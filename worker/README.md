# diecast-hunter-ebay-worker

Tiny Cloudflare Worker that satisfies eBay's *Marketplace Account Deletion /
Closure Notifications* requirement so the desktop app's production keyset can
be unlocked. Without this (or an exemption), eBay leaves your prod keyset
disabled.

The Worker:

- Responds to eBay's verification challenge with the right SHA-256 hash so the
  endpoint registers successfully.
- Receives and queues real deletion notifications in Cloudflare KV.
- Exposes an authenticated polling API the desktop app calls on launch to
  drain the queue and purge matching local data.

## Prerequisites

- A Cloudflare account (free tier is fine).
- `wrangler` CLI: `pnpm install` (in this `worker/` dir) installs it locally;
  use `pnpm wrangler ...` or `npx wrangler ...` thereafter.
- An eBay developer account with a production keyset that's currently
  disabled pending compliance.

## One-time setup

```sh
cd worker
pnpm install

# Authenticate wrangler with your Cloudflare account.
pnpm wrangler login

# Create the KV namespace and copy the printed `id` into wrangler.toml,
# replacing REPLACE_WITH_KV_NAMESPACE_ID.
pnpm wrangler kv namespace create DELETIONS

# Generate two random secrets. On Windows PowerShell:
#   -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | % {[char]$_})
# Or any other 64-char alphanumeric generator.
# EBAY_VERIFICATION_TOKEN must be 32-80 chars, alphanumeric, hyphen, or
# underscore. APP_SHARED_SECRET is purely between Worker and desktop app.
pnpm wrangler secret put EBAY_VERIFICATION_TOKEN
pnpm wrangler secret put APP_SHARED_SECRET

# First deploy — the URL won't be known until after this runs.
pnpm wrangler deploy
```

After the first deploy, wrangler prints your Worker's URL, e.g.:

```
https://diecast-hunter-ebay.<account>.workers.dev
```

Now update `wrangler.toml`:

```toml
[vars]
ENDPOINT_URL = "https://diecast-hunter-ebay.<account>.workers.dev/marketplace-deletion"
```

and redeploy:

```sh
pnpm wrangler deploy
```

This second deploy is necessary because the verification challenge hash
includes the endpoint URL, so the Worker has to know its own URL.

## Register with eBay

1. Sign in at <https://developer.ebay.com>.
2. Go to **My Account → Application Keysets**.
3. Find your production keyset. Click the **Notifications** / **Alerts** /
   **Marketplace Account Deletion** link.
4. Configure:
   - **Marketplace account deletion notification endpoint**:
     `https://diecast-hunter-ebay.<account>.workers.dev/marketplace-deletion`
   - **Verification token**: paste the same value you set for
     `EBAY_VERIFICATION_TOKEN` above.
5. Save. eBay immediately sends a GET to your endpoint with a `challenge_code`
   and expects the right hash back. If it succeeds, the page shows the
   endpoint as verified.

Once verified, your prod keyset compliance is satisfied. If your prod keyset
was disabled solely for compliance, it will become usable immediately or
within a short review window.

## Confirming it works

```sh
# Health check.
curl https://diecast-hunter-ebay.<account>.workers.dev/health

# Verification challenge (simulating eBay).
curl "https://diecast-hunter-ebay.<account>.workers.dev/marketplace-deletion?challenge_code=test123"
# Should return: {"challengeResponse":"<64-char hex>"}

# Authenticated pending-deletions poll (desktop app does this).
curl -H "Authorization: Bearer <APP_SHARED_SECRET>" \
     https://diecast-hunter-ebay.<account>.workers.dev/api/pending-deletions
# Should return: {"deletions":[]}
```

## Local development

```sh
# Put development versions of the secrets in worker/.dev.vars (gitignored):
echo 'EBAY_VERIFICATION_TOKEN = "dev-verification-token-32-chars-min"' >  .dev.vars
echo 'APP_SHARED_SECRET = "dev-shared-secret"' >> .dev.vars

pnpm dev
# Worker runs on http://localhost:8787
```

## Deployment

Each `pnpm deploy` re-publishes the Worker. If you change the Worker URL
(unusual), update `wrangler.toml`'s `ENDPOINT_URL` and re-register the
endpoint with eBay.

## What the desktop app does with this

Not yet implemented — that's a follow-up commit. The plan:

1. On app launch (and once a day thereafter), call
   `GET /api/pending-deletions` with the shared secret.
2. For each notification, parse out the eBay username/userId and `DELETE FROM
   listings WHERE seller_username = ?` (and any other rows that mention the
   user).
3. POST `/api/ack-deletions` with the IDs we processed so the queue clears.

## Notes

- Notification signature verification (eBay signs payloads with ECDSA via the
  `X-EBAY-SIGNATURE` header) is not implemented yet. Current behavior trusts
  any POST that arrives at `/marketplace-deletion`. The worst case from an
  unsigned/spoofed POST is an extra row in the deletion queue that the
  desktop app drains harmlessly. For stricter compliance, add signature
  verification — eBay publishes their public key via the Account Deletion
  Notifications API.
- KV's free tier covers this volume comfortably (deletions are rare).
