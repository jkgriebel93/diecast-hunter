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

interface Env {
  DELETIONS: KVNamespace;
  EBAY_VERIFICATION_TOKEN: string;
  APP_SHARED_SECRET: string;
  ENDPOINT_URL: string;
}

interface DeletionRecord {
  received_at: number;
  raw: unknown;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

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

async function handleNotification(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // eBay's payload shape (subset we care about):
  //   { notification: { notificationId: "...", data: { username, userId, eiasToken } } }
  // We persist the whole payload as-is and key by notificationId so duplicate
  // deliveries are idempotent.
  const id = extractNotificationId(body) ?? crypto.randomUUID();
  const record: DeletionRecord = {
    received_at: Date.now(),
    raw: body,
  };
  await env.DELETIONS.put(`deletion:${id}`, JSON.stringify(record));

  // eBay requires a fast 2xx ack. Return immediately; processing happens on
  // the desktop side when it polls /api/pending-deletions.
  return new Response("ok", { status: 200 });
}

async function handlePending(env: Env): Promise<Response> {
  // KV list returns up to 1000 keys per call. For our personal-use volume
  // this is fine (deletions of accounts we've interacted with should be
  // rare). Larger volumes should paginate via cursor.
  const list = await env.DELETIONS.list({ prefix: "deletion:" });
  const items = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.DELETIONS.get(k.name);
      const record: DeletionRecord | null = raw ? JSON.parse(raw) : null;
      return {
        id: k.name.slice("deletion:".length),
        record,
      };
    }),
  );
  return Response.json({ deletions: items });
}

async function handleAck(req: Request, env: Env): Promise<Response> {
  let body: { ids?: string[] };
  try {
    body = (await req.json()) as { ids?: string[] };
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const ids = body.ids ?? [];
  await Promise.all(
    ids.map((id) => env.DELETIONS.delete(`deletion:${id}`)),
  );
  return Response.json({ acked: ids.length });
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
