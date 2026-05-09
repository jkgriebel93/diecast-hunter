# diecast-hunter-ebay Worker — fix runaway KV writes

## Context

The `diecast-hunter-ebay` Cloudflare Worker is the public endpoint that handles eBay's Marketplace Account Deletion notifications and the OAuth callback for the Diecast Hunter desktop app. It binds the `DELETIONS` KV namespace (binding name: `DELETIONS`, namespace id: `698ce6ff67ef4a1a8bdd18d605dd1cd3`).

Cloudflare's Security Insights flagged thousands of KV write requests against this namespace. Investigation showed the writes come from this Worker's `POST /marketplace-deletion` route. Two compounding bugs let any unauthenticated POST produce a fresh KV record.

## Files in scope

- `src/index.ts` — main Worker (this is where the fix lives)
- `wrangler.toml` (or `wrangler.jsonc`) — may need new secrets / KV binding for public-key cache
- Any test files for the notification handler

## The bug

In the current `handleNotification`:

```ts
async function handleNotification(req: Request, env: Env) {
  let body;
  try { body = await req.json(); }
  catch { return new Response("invalid json", { status: 400 }); }

  const id = extractNotificationId(body) ?? crypto.randomUUID();   // 👈 (1)
  const record = { received_at: Date.now(), raw: body };
  await env.DELETIONS.put(`deletion:${id}`, JSON.stringify(record));  // 👈 (2)
  return new Response("ok", { status: 200 });
}
```

Two compounding problems:

1. **No authenticity check.** The endpoint is publicly registered with eBay so its URL is discoverable by scanners. Any POST with valid JSON gets processed. eBay actually signs notifications with an `x-ebay-signature` header — it's never checked.
2. **`?? crypto.randomUUID()` defeats deduplication.** When a junk POST arrives without `notification.notificationId`, the Worker invents a fresh UUID and writes a new KV record. Every drive-by POST → one new key. Even legitimate eBay retries that *do* carry the same `notificationId` are deduped correctly, but the random fallback creates unbounded growth from scanners.

Combined effect: a public endpoint that writes to KV on every POST regardless of source. The "thousands of writes" are mostly internet background-noise scanners.

## Required behavior changes

`POST /marketplace-deletion` must:

1. Reject any request missing `x-ebay-signature` with HTTP 412.
2. Verify the signature against eBay's public key over the raw (unparsed) request body. Reject with 412 on bad signature.
3. Only after signature verification, parse JSON.
4. Reject (HTTP 400) any verified payload that lacks `notification.notificationId`. Do **not** generate a fallback ID. A signed payload without the ID is a schema violation and shouldn't write.
5. Use `notification.notificationId` as the KV key (`deletion:${id}`). This guarantees idempotency for retries.
6. Return 200 within ~3 seconds (eBay's timeout) for verified, well-formed notifications.

The existing `GET /marketplace-deletion` challenge handler is correct and does not need changes.

The existing `/api/pending-deletions` and `/api/ack-deletions` bearer-auth handlers are correct and do not need changes (other than benefiting from the much-smaller key set after the fix).

## eBay signature spec (the critical reference)

This is the part that's easy to get wrong. Confirmed against eBay's developer docs and the AsyncAPI contract.

### Header format

`x-ebay-signature` is a base64-encoded JSON object:

```json
{
  "alg": "ecdsa",
  "kid": "9936261a-7d7b-4621-a0f1-96ccb428af49",
  "signature": "MEYCIQCfxfIWuxmWcIBQJ9c5/X7iGDJqs2RCGsBEaAjinyrrfAIhAIV6wGcTiBuV5KJUif2hokyrL+Q9ssHkad+mx2nEE25w",
  "digest": "SHA1"
}
```

- `kid` — UUID identifying which eBay public key signed this notification.
- `signature` — base64-encoded **DER-formatted** ECDSA signature.
- `digest` — eBay currently uses **SHA-1**. Yes, SHA-1. This is what eBay specifies.
- `alg` — always `"ecdsa"` for marketplace account deletion today. Reject anything else.

### Public key fetch

```
GET https://api.ebay.com/commerce/notification/v1/public_key/{kid}
Authorization: Bearer <APP_ACCESS_TOKEN>
```

Returns:

```json
{
  "algorithm": "ECDSA",
  "digest": "SHA1",
  "key": "-----BEGIN PUBLIC KEY-----\nMFk...\n-----END PUBLIC KEY-----"
}
```

`APP_ACCESS_TOKEN` is an **Application access token** (client credentials grant), **not** a user OAuth token. Get it from:

```
POST https://api.ebay.com/identity/v1/oauth2/token
Authorization: Basic <base64(CLIENT_ID:CLIENT_SECRET)>
Content-Type: application/x-www-form-urlencoded
Body: grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope
```

Tokens last ~2 hours — cache them.

### Verification

The signature is over the **raw request body bytes** (the unparsed UTF-8). Don't re-serialize the parsed JSON — re-serialization will break the signature because of whitespace/key-order differences.

The signature in eBay's header is **DER-encoded**. Web Crypto's `crypto.subtle.verify` for ECDSA expects **raw r||s** format (concatenated big-endian, fixed-width). Conversion is required. This is the part most implementations get wrong.

The curve is **P-256** (prime256v1, secp256r1). Web Crypto needs that as `namedCurve: "P-256"` when importing the key.

The hash is **SHA-1**. Pass `hash: "SHA-1"` to `subtle.verify`.

## Implementation skeleton

Drop these into `src/index.ts` (or split into modules — recommended: `src/ebay-signature.ts`, `src/ebay-token.ts`).

### `Env` type additions

```ts
type Env = {
  // existing
  DELETIONS: KVNamespace;
  EBAY_VERIFICATION_TOKEN: string;
  ENDPOINT_URL: string;
  APP_SHARED_SECRET: string;

  // new
  EBAY_CLIENT_ID: string;       // wrangler secret
  EBAY_CLIENT_SECRET: string;   // wrangler secret
  EBAY_KEY_CACHE: KVNamespace;  // new KV namespace for public-key + token cache
};
```

Use a separate small KV namespace for caches — don't mix cache state into the `DELETIONS` namespace. Caches are write-heavy in a different way and you don't want them tangled with deletion records.

### Patched `handleNotification`

```ts
async function handleNotification(req: Request, env: Env): Promise<Response> {
  const sigHeader = req.headers.get("x-ebay-signature");
  if (!sigHeader) {
    return new Response("missing signature", { status: 412 });
  }

  // Read raw bytes — signature is over the exact bytes eBay sent.
  const rawBody = await req.arrayBuffer();

  let verified: boolean;
  try {
    verified = await verifyEbaySignature(sigHeader, rawBody, env);
  } catch (err) {
    console.error("signature verification error", err);
    return new Response("signature verification failed", { status: 412 });
  }
  if (!verified) {
    return new Response("invalid signature", { status: 412 });
  }

  // Only parse after the signature is valid.
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const id = extractNotificationId(body);
  if (!id) {
    // Signed by eBay but missing notificationId — schema violation, don't write.
    console.warn("verified notification missing notificationId", body);
    return new Response("missing notificationId", { status: 400 });
  }

  // Idempotent: same notificationId → same key, no growth on retries.
  const record = { received_at: Date.now(), raw: body };
  await env.DELETIONS.put(`deletion:${id}`, JSON.stringify(record));
  return new Response("ok", { status: 200 });
}
```

### `src/ebay-signature.ts`

```ts
type EbaySigHeader = {
  alg: string;
  kid: string;
  signature: string; // base64(DER)
  digest: string;
};

const KEY_TTL_SECONDS = 60 * 60 * 24; // 24h — eBay rotates rarely

export async function verifyEbaySignature(
  headerB64: string,
  rawBody: ArrayBuffer,
  env: Env,
): Promise<boolean> {
  const parsed = parseSigHeader(headerB64);
  if (parsed.alg.toLowerCase() !== "ecdsa") return false;
  if (parsed.digest.toUpperCase() !== "SHA1") return false;

  const pem = await getPublicKeyPem(parsed.kid, env);
  const key = await importEcdsaPublicKey(pem);
  const rawSig = derToRawEcdsaSignature(base64ToBytes(parsed.signature), 32); // P-256 → 32 bytes per coord

  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-1" },
    key,
    rawSig,
    rawBody,
  );
}

function parseSigHeader(headerB64: string): EbaySigHeader {
  const json = new TextDecoder().decode(base64ToBytes(headerB64));
  const obj = JSON.parse(json);
  if (typeof obj?.kid !== "string" || typeof obj?.signature !== "string") {
    throw new Error("malformed x-ebay-signature header");
  }
  return obj as EbaySigHeader;
}

async function importEcdsaPublicKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const spki = base64ToBytes(b64);
  return crypto.subtle.importKey(
    "spki",
    spki,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * eBay's signature is DER-encoded; Web Crypto wants raw r||s.
 * DER ECDSA signature: 0x30 LEN 0x02 RLEN R 0x02 SLEN S
 * Each integer may have a leading 0x00 byte for sign-disambiguation; strip it.
 * Pad each to coordSize bytes (32 for P-256) and concatenate.
 */
export function derToRawEcdsaSignature(der: Uint8Array, coordSize: number): Uint8Array {
  if (der[0] !== 0x30) throw new Error("DER: expected sequence");
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f); // long-form length

  if (der[offset] !== 0x02) throw new Error("DER: expected integer for r");
  const rLen = der[offset + 1];
  let r = der.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;

  if (der[offset] !== 0x02) throw new Error("DER: expected integer for s");
  const sLen = der[offset + 1];
  let s = der.subarray(offset + 2, offset + 2 + sLen);

  // Strip leading zero used for sign disambiguation.
  if (r.length > coordSize && r[0] === 0x00) r = r.subarray(1);
  if (s.length > coordSize && s[0] === 0x00) s = s.subarray(1);
  if (r.length > coordSize || s.length > coordSize) {
    throw new Error("DER: coordinate larger than expected");
  }

  const out = new Uint8Array(coordSize * 2);
  out.set(r, coordSize - r.length);
  out.set(s, 2 * coordSize - s.length);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

### `src/ebay-token.ts`

```ts
type CachedKey = { pem: string; fetched_at: number };
type CachedToken = { token: string; expires_at: number };

const TOKEN_REFRESH_SLOP_MS = 60_000; // refresh 60s before expiry

export async function getPublicKeyPem(kid: string, env: Env): Promise<string> {
  const cacheKey = `pubkey:${kid}`;
  const cached = await env.EBAY_KEY_CACHE.get<CachedKey>(cacheKey, "json");
  if (cached?.pem) return cached.pem;

  const token = await getAppAccessToken(env);
  const resp = await fetch(
    `https://api.ebay.com/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    throw new Error(`getPublicKey failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json<{ key: string; algorithm: string; digest: string }>();
  if (data.algorithm !== "ECDSA" || data.digest !== "SHA1") {
    throw new Error(`unexpected algo: ${data.algorithm}/${data.digest}`);
  }

  await env.EBAY_KEY_CACHE.put(
    cacheKey,
    JSON.stringify({ pem: data.key, fetched_at: Date.now() } satisfies CachedKey),
    { expirationTtl: 60 * 60 * 24 }, // 24h
  );
  return data.key;
}

async function getAppAccessToken(env: Env): Promise<string> {
  const cached = await env.EBAY_KEY_CACHE.get<CachedToken>("app_token", "json");
  if (cached && cached.expires_at - Date.now() > TOKEN_REFRESH_SLOP_MS) {
    return cached.token;
  }

  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  if (!resp.ok) {
    throw new Error(`app token fetch failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json<{ access_token: string; expires_in: number }>();
  const expires_at = Date.now() + data.expires_in * 1000;

  await env.EBAY_KEY_CACHE.put(
    "app_token",
    JSON.stringify({ token: data.access_token, expires_at } satisfies CachedToken),
    { expirationTtl: data.expires_in - 60 },
  );
  return data.access_token;
}
```

## Required infrastructure changes

1. **New KV namespace** for caches:
   ```bash
   npx wrangler kv namespace create EBAY_KEY_CACHE
   ```
   Bind it in `wrangler.toml` as `EBAY_KEY_CACHE`.

2. **New secrets**:
   ```bash
   npx wrangler secret put EBAY_CLIENT_ID
   npx wrangler secret put EBAY_CLIENT_SECRET
   ```
   Use the same eBay app credentials already used by the Diecast Hunter desktop app's OAuth flow.

3. **Optional: WAF rule** as belt-and-suspenders pre-filter. In Cloudflare dashboard → Security → WAF → Custom rules:
    - Expression: `(http.request.uri.path eq "/marketplace-deletion" and http.request.method eq "POST" and len(http.request.headers["x-ebay-signature"]) == 0)`
    - Action: Block
    - This drops scanner traffic before it reaches the Worker, eliminating the invocation cost too.

## Test plan

Use `vitest` with `@cloudflare/vitest-pool-workers` (or whatever is already configured). Cases:

1. **Missing signature header → 412.** POST with no `x-ebay-signature`.
2. **Malformed signature header → 412.** Header is not valid base64 / not valid JSON.
3. **Wrong algorithm or digest → 412.** Signature header parses but `alg` or `digest` is wrong.
4. **Bad signature → 412.** Tamper a byte of the body or signature.
5. **Valid signature, missing `notification.notificationId` → 400, no KV write.**
6. **Valid signature, valid notification → 200, KV has `deletion:${id}` exactly once.**
7. **Valid signature, retry of same notification → 200, KV still has only one record.** (Idempotency.)
8. **Public key cache hit → no outbound fetch.** Mock the fetch and assert it's not called the second time.
9. **App token cache miss → token fetched once, reused for subsequent verifies.**
10. **Existing handlers unchanged:** `GET /marketplace-deletion`, `/api/pending-deletions`, `/api/ack-deletions`, `/health`, `/ebay-oauth-callback`, `/privacy` should all still pass their existing tests if any.

For test fixtures, eBay's developer docs include a sample signed notification you can use. Cache a real `kid` → public key mapping in a fixture so tests don't hit eBay.

## Cleanup of existing junk records

After deploying the patched Worker, the `DELETIONS` namespace still holds thousands of garbage records. Recommended cleanup:

**Option A — recreate (cleanest):**
1. `npx wrangler kv namespace create DELETIONS_V2`
2. Update `wrangler.toml` to point the `DELETIONS` binding at the new namespace id.
3. Deploy. New records flow into the empty namespace.
4. After confirming a few real notifications land correctly, delete the old namespace via dashboard or `npx wrangler kv namespace delete --namespace-id 698ce6ff67ef4a1a8bdd18d605dd1cd3`.

**Option B — bulk delete in place:** loop the REST API. Less clean. Skip unless there's a reason to preserve the namespace ID.

## Definition of done

- [ ] `POST /marketplace-deletion` returns 412 for any request without a valid eBay signature.
- [ ] Verified-but-malformed payloads return 400 and produce zero KV writes.
- [ ] Verified valid notifications produce exactly one KV record per `notificationId`, regardless of retry count.
- [ ] Public key and app token are cached in `EBAY_KEY_CACHE`; verified by tests not making redundant outbound fetches.
- [ ] Test suite passes including the cases above.
- [ ] Old `DELETIONS` namespace either recreated or bulk-cleared.
- [ ] Optional WAF rule deployed.
- [ ] After 24h of being live, KV write rate on the namespace metrics tab in the Cloudflare dashboard is essentially zero except during real notification events.

## References

- eBay Marketplace Account Deletion guide: https://developer.ebay.com/marketplace-account-deletion
- eBay Notification API (`getPublicKey`): https://developer.ebay.com/api-docs/commerce/notification/resources/public_key/methods/getPublicKey
- eBay AsyncAPI contract: https://developer.ebay.com/api-docs/master/commerce/notification/asyncapi/marketplace_account_deletion.yaml
- Cloudflare Workers KV write limits & pricing: https://developers.cloudflare.com/kv/platform/limits/ and https://developers.cloudflare.com/kv/platform/pricing/
- Web Crypto ECDSA verify in Workers: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/