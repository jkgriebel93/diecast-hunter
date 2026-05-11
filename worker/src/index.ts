/**
 * Cloudflare Worker that handles eBay's "Marketplace Account Deletion /
 * Closure" notifications, which eBay requires every production application
 * keyset to handle (or be exempt from). The desktop app is local-only so we
 * stand up this tiny endpoint just to satisfy the compliance requirement.
 *
 * Routes:
 *   GET  /marketplace-deletion?challenge_code=...
 *     Verification handshake. Computes SHA-256(challenge + token + endpoint)
 *     and returns it as JSON. eBay calls this once when you register the URL
 *     and may re-call periodically.
 *
 *   POST /marketplace-deletion
 *     Real notification. Stores the payload in KV under a key derived from
 *     eBay's notificationId (idempotent — duplicate POSTs overwrite).
 *
 *   GET  /api/pending-deletions     (Bearer: APP_SHARED_SECRET)
 *     Desktop app polls this on launch to drain the queue.
 *
 *   POST /api/ack-deletions         (Bearer: APP_SHARED_SECRET)
 *     Desktop app POSTs { ids: [...] } once it's deleted matching local rows.
 *     Removes them from KV.
 *
 *   GET  /health
 *     Plain "ok" — useful for confirming the deploy is up.
 */

export interface Env {
  DELETIONS: KVNamespace;
  EBAY_VERIFICATION_TOKEN: string;
  APP_SHARED_SECRET: string;
  ENDPOINT_URL: string;
  // eBay app credentials (client_credentials grant) used to fetch the
  // notification public key. Both come from `wrangler secret put`.
  EBAY_CLIENT_ID: string;
  EBAY_CLIENT_SECRET: string;
  // Separate KV namespace caching the app access token and per-kid public
  // keys. Kept apart from DELETIONS so cache writes don't pollute the
  // deletion record set (and vice versa).
  EBAY_KEY_CACHE: KVNamespace;
  // D1 deletions store. Dual-written alongside DELETIONS during the Phase 1
  // soak; KV still serves the read path until Phase 2 promotes D1.
  DB: D1Database;
}

interface DeletionRecord {
  received_at: number;
  raw: unknown;
}

import { verifyEbaySignature } from "./ebay-signature";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    // Treat HEAD identically to GET. eBay's URL validator (and many other
    // crawlers/probers) use HEAD to confirm a URL is live; without this they
    // see 404 and the developer-portal form silently refuses to save.
    const method = req.method === "HEAD" ? "GET" : req.method;

    if (path === "/marketplace-deletion" && method === "GET") {
      return handleVerification(url, env);
    }
    if (path === "/marketplace-deletion" && method === "POST") {
      return handleNotification(req, env);
    }
    if (path === "/api/pending-deletions" && method === "GET") {
      const auth = checkAuth(req, env);
      return auth ?? handlePending(env);
    }
    if (path === "/api/ack-deletions" && method === "POST") {
      const auth = checkAuth(req, env);
      return auth ?? handleAck(req, env);
    }
    if (path === "/ebay-oauth-callback" && method === "GET") {
      return handleOauthCallback(url);
    }
    if (path === "/ebay-auth-declined" && method === "GET") {
      return htmlResponse(authDeclinedPage());
    }
    if (path === "/privacy" && method === "GET") {
      return htmlResponse(privacyPage());
    }
    if (path === "/health" || path === "/") {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleVerification(url: URL, env: Env): Promise<Response> {
  const challenge = url.searchParams.get("challenge_code");
  if (!challenge) {
    return new Response("missing challenge_code", { status: 400 });
  }
  if (!env.EBAY_VERIFICATION_TOKEN || !env.ENDPOINT_URL) {
    return new Response("worker not configured", { status: 500 });
  }
  const data = challenge + env.EBAY_VERIFICATION_TOKEN + env.ENDPOINT_URL;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  const challengeResponse = toHex(new Uint8Array(buf));
  return Response.json(
    { challengeResponse },
    {
      headers: { "content-type": "application/json" },
    },
  );
}

export async function handleNotification(
  req: Request,
  env: Env,
): Promise<Response> {
  // Authenticity gate. The endpoint is publicly registered with eBay so the
  // URL is discoverable; without this gate every drive-by POST writes a KV
  // record. eBay always sends `x-ebay-signature` with a real notification.
  const sigHeader = req.headers.get("x-ebay-signature");
  if (!sigHeader) {
    return new Response("missing signature", { status: 412 });
  }

  // Read raw bytes — the signature covers exact bytes, so we cannot
  // re-serialize from a parsed object.
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

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // A signed-but-malformed payload is a schema violation, not a retry. Don't
  // invent a fallback id — that path is what allowed unbounded KV growth.
  const id = extractNotificationId(body);
  if (!id) {
    console.warn("verified notification missing notificationId");
    return new Response("missing notificationId", { status: 400 });
  }

  // Dual-write: D1 is the new source of truth (Phase 2 will promote it on the
  // read path), KV is the safety net during the soak. Both writes are
  // idempotent on notificationId, so eBay retries don't grow either store.
  //
  // Neither write failure breaks the 200 response — eBay only cares that the
  // signed notification was received. Failures are logged structured so drift
  // is attributable.
  const notification =
    (body as { notification?: Record<string, unknown> }).notification ?? {};
  // eBay nests the deletion subject under `notification.data` (per their
  // Marketplace Account Deletion docs and our existing fixtures). The ticket
  // spec reads them off `notification` directly, which would silently land
  // NULLs in every column.
  const data =
    (notification.data as Record<string, unknown> | undefined) ?? {};
  const now = Date.now();
  const record: DeletionRecord = { received_at: now, raw: body };

  const d1Write = env.DB.prepare(
    `INSERT INTO marketplace_deletions
       (notification_id, received_at, user_id, username, eias_token, raw)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(notification_id) DO NOTHING`,
  )
    .bind(
      id,
      now,
      (data.userId as string | undefined) ?? null,
      (data.username as string | undefined) ?? null,
      (data.eiasToken as string | undefined) ?? null,
      JSON.stringify(notification),
    )
    .run();

  const kvWrite = env.DELETIONS.put(
    `deletion:${id}`,
    JSON.stringify(record),
  );

  const results = await Promise.allSettled([d1Write, kvWrite]);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      console.error(
        JSON.stringify({
          event: "deletion_write_failed",
          store: i === 0 ? "d1" : "kv",
          notification_id: id,
          error: String(r.reason),
        }),
      );
    }
  }
  return new Response("ok", { status: 200 });
}

interface PendingRow {
  notification_id: string;
  received_at: number;
  user_id: string | null;
  username: string | null;
  eias_token: string | null;
  raw: string;
}

export async function handlePending(env: Env): Promise<Response> {
  // D1 is the source of truth for the read path as of Phase 2. KV is no
  // longer consulted here, but still drained on ack to keep it as a safety
  // net until Phase 3 removes the KV write entirely.
  const { results } = await env.DB.prepare(
    `SELECT notification_id, received_at, user_id, username, eias_token, raw
       FROM marketplace_deletions
      WHERE acked_at IS NULL
      ORDER BY received_at`,
  ).all<PendingRow>();

  const deletions = (results ?? []).map((r) => {
    let notification: unknown;
    try {
      notification = JSON.parse(r.raw);
    } catch {
      // `raw` is written by us as JSON.stringify; a parse failure is data
      // corruption, not user input. Pass the string through so the consumer
      // can decide what to do, and log so it's surfaced.
      console.error(
        JSON.stringify({
          event: "deletion_raw_parse_failed",
          notification_id: r.notification_id,
        }),
      );
      notification = r.raw;
    }
    return {
      id: r.notification_id,
      received_at: r.received_at,
      user_id: r.user_id,
      username: r.username,
      eias_token: r.eias_token,
      notification,
    };
  });

  return Response.json({ deletions });
}

export async function handleAck(req: Request, env: Env): Promise<Response> {
  let body: { ids?: unknown };
  try {
    body = (await req.json()) as { ids?: unknown };
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const ids: string[] = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string")
    : [];
  if (ids.length === 0) return Response.json({ acked: 0 });

  // Soft-delete in D1 (preserves audit trail); hard-delete in KV to keep it
  // drained as the safety net. `acked_at IS NULL` ensures we only count
  // first-time acks, so re-ack of an already-acked id is a no-op.
  const placeholders = ids.map(() => "?").join(",");
  const now = Date.now();
  const { meta } = await env.DB.prepare(
    `UPDATE marketplace_deletions
        SET acked_at = ?
      WHERE notification_id IN (${placeholders})
        AND acked_at IS NULL`,
  )
    .bind(now, ...ids)
    .run();

  await Promise.allSettled(
    ids.map((id) => env.DELETIONS.delete(`deletion:${id}`)),
  );

  return Response.json({ acked: meta?.changes ?? ids.length });
}

function checkAuth(req: Request, env: Env): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.APP_SHARED_SECRET}`;
  if (!env.APP_SHARED_SECRET || !timingSafeEqual(auth, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function extractNotificationId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  const notification = obj.notification;
  if (typeof notification !== "object" || notification === null) return null;
  const id = (notification as Record<string, unknown>).notificationId;
  return typeof id === "string" ? id : null;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function handleOauthCallback(url: URL): Response {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  if (error || !code) {
    const msg = errorDescription || error || "no code returned";
    return htmlResponse(oauthErrorPage(msg), 400);
  }
  return htmlResponse(oauthSuccessPage(code));
}

function oauthSuccessPage(code: string): string {
  const escaped = escapeHtml(code);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Diecast Hunter — eBay authorization</title>
    <style>
      :root { color-scheme: dark light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #0b0d10;
        color: #e2e8f0;
        padding: 1rem;
      }
      .card {
        max-width: 36rem;
        width: 100%;
        background: #13171c;
        border: 1px solid #262c34;
        border-radius: 12px;
        padding: 2rem;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
      }
      h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
      p { color: #94a3b8; margin: 0.5rem 0; line-height: 1.5; }
      .ok { color: #10b981; font-weight: 600; }
      label { display: block; font-size: 0.75rem; color: #94a3b8; margin: 1.5rem 0 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
      .row { display: flex; gap: 0.5rem; align-items: stretch; }
      input {
        flex: 1;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.875rem;
        background: #1a1f25;
        color: #e2e8f0;
        border: 1px solid #262c34;
        border-radius: 6px;
        padding: 0.625rem 0.75rem;
        min-width: 0;
      }
      button {
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0 1rem;
        font-size: 0.875rem;
        cursor: pointer;
      }
      button:hover { background: #2563eb; }
      .hint { font-size: 0.875rem; }
      ol { padding-left: 1.25rem; color: #cbd5e1; }
      ol li { margin: 0.375rem 0; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1><span class="ok">✓</span> eBay authorization successful</h1>
      <p>Copy the code below and paste it back into Diecast Hunter. The code expires in a few minutes — finish the connection promptly.</p>

      <label for="code">Authorization code</label>
      <div class="row">
        <input id="code" readonly value="${escaped}" />
        <button type="button" onclick="copy()">Copy</button>
      </div>
      <p id="status" class="hint"></p>

      <p class="hint" style="margin-top:1.5rem;">Next steps:</p>
      <ol class="hint">
        <li>Switch back to the Diecast Hunter app.</li>
        <li>In Settings → eBay Developers, click <em>Paste auth code</em>.</li>
        <li>Paste the code and confirm. The app exchanges it for a refresh token and you're connected.</li>
      </ol>
    </main>

    <script>
      function copy() {
        const el = document.getElementById('code');
        el.select();
        el.setSelectionRange(0, 999);
        try {
          navigator.clipboard.writeText(el.value);
          document.getElementById('status').textContent = 'Copied — paste it into the app.';
        } catch (_e) {
          document.execCommand && document.execCommand('copy');
          document.getElementById('status').textContent = 'Copied (fallback).';
        }
      }
      // Auto-select on load so Cmd/Ctrl+C works immediately.
      window.addEventListener('load', () => {
        const el = document.getElementById('code');
        el.focus();
        el.select();
      });
    </script>
  </body>
</html>`;
}

function oauthErrorPage(msg: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Diecast Hunter — eBay authorization failed</title>
    <style>
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
             font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
             background: #0b0d10; color: #e2e8f0; padding: 1rem; }
      .card { max-width: 36rem; background: #13171c; border: 1px solid #262c34; border-radius: 12px; padding: 2rem; }
      h1 { margin: 0 0 0.5rem; font-size: 1.25rem; color: #f87171; }
      p { color: #94a3b8; margin: 0.5rem 0; line-height: 1.5; }
      pre { background: #1a1f25; padding: 0.75rem; border-radius: 6px; overflow-x: auto; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>eBay authorization failed</h1>
      <p>The authorization didn't complete. eBay reported:</p>
      <pre>${escapeHtml(msg)}</pre>
      <p>Close this tab and try again from the app.</p>
    </main>
  </body>
</html>`;
}

function authDeclinedPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>eBay authorization declined</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0d10;color:#e2e8f0;padding:1rem}.card{max-width:36rem;background:#13171c;border:1px solid #262c34;border-radius:12px;padding:2rem}h1{margin:0 0 .5rem;font-size:1.25rem}p{color:#94a3b8;margin:.5rem 0}</style>
</head><body><main class="card"><h1>Authorization declined</h1><p>You declined to grant Diecast Hunter access to your eBay account. You can close this tab.</p></main></body></html>`;
}

function privacyPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Diecast Hunter privacy policy</title>
<style>body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0d10;color:#e2e8f0;padding:2rem;max-width:48rem;margin-inline:auto;line-height:1.6}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:2rem}p,li{color:#cbd5e1}</style>
</head><body>
<h1>Diecast Hunter — Privacy Policy</h1>
<p>Diecast Hunter is a personal-use desktop application for managing one user's diecast collection and the listings they personally choose to track.</p>
<h2>Data collected</h2>
<p>The app stores, locally on the user's own machine:</p>
<ul>
  <li>The user's own eBay authorization tokens (refresh and access tokens), used to query the user's own account.</li>
  <li>Listing data the user explicitly chose to track (item ids, titles, prices, seller usernames, images).</li>
  <li>Personal collection data imported from diecastregistry.com using the user's own account.</li>
</ul>
<h2>Data sharing</h2>
<p>No data is shared with third parties. The application connects only to: eBay's APIs (with the user's own credentials), diecastregistry.com (with the user's own credentials), and a small Cloudflare Worker the user themself deploys to receive eBay's deletion notifications.</p>
<h2>Data deletion</h2>
<p>The app honors eBay's account-deletion notification process. When eBay notifies of an account deletion via the configured Worker endpoint, the desktop app removes any local rows referencing that user.</p>
<h2>Contact</h2>
<p>This is a single-user personal application; there is no support team. The source is available at the repository configured in the user's local installation.</p>
</body></html>`;
}
