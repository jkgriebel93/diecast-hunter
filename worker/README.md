# diecast-hunter-ebay-worker

Tiny Cloudflare Worker that satisfies eBay's *Marketplace Account Deletion /
Closure Notifications* requirement so the desktop app's production keyset can
be unlocked. Without this (or an exemption), eBay leaves your prod keyset
disabled.

The Worker:

- Responds to eBay's verification challenge with the right SHA-256 hash so the
  endpoint registers successfully.
- Verifies eBay's ECDSA signature, then inserts each notification into the
  `marketplace_deletions` table in Cloudflare D1 (idempotent on
  `notification_id`).
- Exposes an authenticated polling API the desktop app calls on launch to
  drain the queue and purge matching local data. Acks soft-delete via
  `acked_at` to preserve an audit trail.
- A daily cron purges acked rows older than the retention window (90 days).

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

# Create the KV namespace (caches the eBay app access token and per-kid
# notification public keys) and copy the printed `id` into wrangler.toml's
# EBAY_KEY_CACHE binding.
pnpm wrangler kv namespace create EBAY_KEY_CACHE

# Create the D1 database (durable store for deletion notifications) and apply
# the schema. Copy the printed database_id into wrangler.toml's DB binding.
pnpm wrangler d1 create diecast-hunter-deletions
pnpm wrangler d1 execute diecast-hunter-deletions --remote --file=./migrations/0001_init.sql

# Generate two random secrets. On Windows PowerShell:
#   -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | % {[char]$_})
# Or any other 64-char alphanumeric generator.
# EBAY_VERIFICATION_TOKEN must be 32-80 chars, alphanumeric, hyphen, or
# underscore. APP_SHARED_SECRET is purely between Worker and desktop app.
pnpm wrangler secret put EBAY_VERIFICATION_TOKEN
pnpm wrangler secret put APP_SHARED_SECRET

# eBay app credentials, used to fetch notification public keys for signature
# verification (client_credentials grant). From your eBay production keyset.
pnpm wrangler secret put EBAY_CLIENT_ID
pnpm wrangler secret put EBAY_CLIENT_SECRET

# Optional. Sentry DSN for the deletion_insert_failed alert — see "Alerting on
# a lost notification" below. Unset, reporting is a no-op; everything else
# works unchanged.
pnpm wrangler secret put SENTRY_DSN

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

## Retention policy

Acked marketplace-deletion rows are kept for **90 days** after their
`acked_at` timestamp, then hard-deleted by a daily cron at 04:00 UTC. The
retention window lives in one place — `PURGE_RETENTION_MS` in
`src/index.ts` — so changing it is a one-line edit + redeploy.

90 days is the audit-trail length for a personal-use app: long enough to
investigate "did we receive a notification for X" questions after the
fact, short enough to keep the table bounded indefinitely. Adjust if a
real compliance posture demands different (eBay's own retention guidance
for deletion notifications is much looser than this).

The cron emits a structured `deletion_purge` log per run with the cutoff
timestamp and the number of rows deleted — search Worker Logs by
`event=deletion_purge` to confirm it's running.

## What the desktop app does with this

Not yet implemented — that's a follow-up commit. The plan:

1. On app launch (and once a day thereafter), call
   `GET /api/pending-deletions` with the shared secret.
2. For each notification, parse out the eBay username/userId and `DELETE FROM
   listings WHERE seller_username = ?` (and any other rows that mention the
   user).
3. POST `/api/ack-deletions` with the IDs we processed so the queue clears.

## Storage model

- **D1 (`DB` binding)** is the source of truth for deletion notifications.
  Each verified notification is inserted into `marketplace_deletions`,
  idempotent on `notification_id`. The desktop app's poll/ack API and the
  daily purge cron read and write here.
- **KV (`EBAY_KEY_CACHE` binding)** is *only* a cache — the eBay app access
  token (~2h TTL) and per-`kid` notification public keys (24h TTL). It holds
  no deletion data. The only thing that reads KV on the request path is
  signature verification: each `POST /marketplace-deletion` carrying an
  `x-ebay-signature` header costs one KV read to look up `pubkey:${kid}`.

## Deletion write contract

**A verified notification always gets `200`, even if the D1 write fails.**
That is deliberate, and it is not the obvious choice, so here is the
reasoning (DCH-28).

eBay treats any non-2xx as a failed delivery and retries indefinitely.
Retrying only helps a *transient* failure. A **permanent** one — an unbound
binding, schema drift, exhausted quota — fails identically on every attempt,
so the retries become a storm rather than eventual delivery. That has
happened here before: a dead KV binding produced exactly that. A storm
trips eBay's endpoint-down detection, which can get the notification
subscription disabled and the production keyset locked. Risking the whole
subscription to save one record is the worse trade.

Since D1 is the only store, a swallowed failure is unrecoverable — so the
handler does not simply give up:

1. The insert is retried up to **3 attempts** with a short backoff
   (~150 ms worst case). This is what recovers transient blips, and it does
   so without giving eBay a reason to retry. Retrying is safe because the
   statement is `ON CONFLICT(notification_id) DO NOTHING`.
2. If every attempt fails, the Worker answers `200` and logs
   **`deletion_insert_failed`** with the `notification_id`, attempt count,
   and error.

`deletion_insert_failed` means a notification was accepted by eBay and then
lost — it is the event worth alerting on. The per-request outcome line
(`event: "deletion_post"`) reports `outcome: "store_failed"` in that case
rather than `"stored"`, so the two logs agree.

### Alerting on a lost notification

`deletion_insert_failed` is reported to **Sentry** (project
`diecast-hunter-worker` in the `thistle-grow-software` org), which emails on
the resulting issue. `src/sentry.ts` posts the event directly to Sentry's
envelope endpoint from the failure branch, inside `ctx.waitUntil()` — so a
slow or unreachable Sentry can neither delay nor change the `200` that keeps
eBay from retrying.

**Why not the Cloudflare dashboard**, which is where you'd expect this to
live: it can't do it. Workers Logs stores, filters and queries logs but has
no alerting, and Cloudflare Notifications only offers threshold-shaped alert
types (error rate, CPU) that a single lost notification would never cross.
The log line remains the local signal — `wrangler tail` still shows it, and
it is what works when `SENTRY_DSN` is unset.

**No Sentry SDK**, deliberately. The deletion path is the one place in this
Worker where a dependency failure has real cost, and Sentry's ingest API is
a single POST. Every failure in the reporter is swallowed and logged; an
alerting path that throws would turn a recoverable D1 problem into an
unhandled rejection inside the compliance endpoint.

`SENTRY_DSN` is optional. Unset, reporting is a no-op and the Worker behaves
exactly as it did before this existed — which is what keeps local dev and the
test suite credential-free.

To (re)configure:

```sh
# 1. Create the project in Sentry, copy its DSN, then:
npx wrangler secret put SENTRY_DSN
# 2. In Sentry, confirm an issue alert rule exists for the project.
```

One thing to get right on that rule: all occurrences share a fixed
fingerprint, so they group into a single Sentry issue. A rule conditioned on
*"a new issue is created"* therefore fires once and then goes quiet. Condition
it on **"an event is seen"** (with a sensible frequency limit) if you want to
hear about every lost notification rather than only the first.

## Signature verification & abuse

Inbound notifications are authenticated: the `x-ebay-signature` header carries
an ECDSA (P-256, SHA-1 digest) signature over the raw body, and the Worker
verifies it against eBay's published public key before writing anything
(`src/ebay-signature.ts`). A POST with no signature, or an invalid one,
returns `412` and is never stored.

Because the endpoint is publicly registered with eBay, scanners and abusive
clients will POST to it. Each such POST that includes *any* `x-ebay-signature`
header spends a KV read (the `pubkey:${kid}` lookup) even when verification
fails — that is the only realistic way to burn the KV free tier here, since
legitimate deletion volume is near zero.

Every POST emits a structured `deletion_post` log line with `outcome`
(`stored` | `invalid_signature` | `missing_signature` | `verification_error` |
`invalid_json` | `missing_notification_id` | `rate_limited`) plus `ip`, `asn`,
`as_org`, `country`, `colo`, `ua`, and `kid`. To distinguish real eBay traffic from
abuse, search Worker Logs for `event=deletion_post`: `outcome=stored` is
cryptographically-verified eBay; a flood of `outcome=invalid_signature` /
`missing_signature` from scattered ASNs is abuse.

There are two ways to throttle abuse; which applies depends on how the Worker
is exposed.

**On `*.workers.dev` (current setup):** zone-level WAF and Rate Limiting rules
do **not** apply — that hostname is on Cloudflare's zone, not yours. The Worker
instead uses Cloudflare's in-Worker **Rate Limiting binding** (`POST_LIMITER`
in `wrangler.toml`), which works on workers.dev. `handleNotification` calls it
keyed on the client IP and returns `429` *before* the `x-ebay-signature` check,
so throttled floods never reach `getPublicKeyPem` and cost no KV reads. The
default is 20 requests / 60s per IP — far above legitimate eBay volume. Tune
`simple = { limit, period }` in `wrangler.toml` (period must be 10 or 60) and
redeploy to adjust.

**Behind a custom domain you control (recommended if abuse persists):** route
the Worker at a hostname in one of your Cloudflare zones, then add zone-level
rules that block abuse *before* the Worker runs at all (no request charge, no
KV):

1. **Rate Limiting rule** (Security → WAF → Rate limiting rules): match
   `http.request.method eq "POST" and http.request.uri.path eq "/marketplace-deletion"`,
   threshold e.g. 5 requests / 10s per IP, action Block. Free plan includes
   one rate-limiting rule.
2. **WAF custom rule** (Security → WAF → Custom rules): Block or Managed
   Challenge the same path when `ip.geoip.asnum` is not eBay's ASN, after
   confirming eBay's ASN from the `deletion_post` logs.
