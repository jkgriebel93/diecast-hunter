/**
 * Public-link wishlist sharing (DCH-46).
 *
 * The desktop app renders a wishlist to a self-contained HTML document and
 * PUTs it here; the worker stores it in KV under a random slug and serves it
 * back at `/w/<slug>` to anyone with the URL. That makes a wishlist shareable
 * over SMS, Messenger, WhatsApp or email without integrating with any of
 * them — a URL is the one payload every channel accepts.
 *
 * **The security model is the slug, and nothing else.** There is no login on
 * the read path, because the recipient is someone's friend with a phone, not
 * a user of this app. So the slug has to be unguessable rather than merely
 * unique — 128 bits of randomness, not a counter — and the read path is
 * marked `noindex` so a link pasted into a public channel doesn't end up in
 * a search index. Anything genuinely private is stripped before upload, on
 * the app side, where the fields are known.
 *
 * Shares expire. KV's `expirationTtl` does it for free, and a link that
 * outlives the conversation it was sent in is a liability nobody is
 * maintaining.
 */

/** Slug alphabet and length: 16 random bytes, base64url, no padding. */
const SLUG_RE = /^[A-Za-z0-9_-]{22}$/;

export const DEFAULT_TTL_DAYS = 30;
export const MAX_TTL_DAYS = 90;
const SECONDS_PER_DAY = 86_400;

/**
 * KV caps a value at 25 MiB. Refuse a bit under that with a clear status
 * rather than letting the put fail: a wishlist export embeds its images as
 * data URIs, so a big list is the expected way to reach this, not an attack.
 */
export const MAX_SHARE_BYTES = 20 * 1024 * 1024;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** 128 bits from the platform CSPRNG, base64url without padding. */
export function newSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Clamp a requested lifetime into something sane. An absent or unparseable
 * value takes the default rather than erroring — the app always sends one,
 * and a share that fails because of a malformed query param is a worse
 * outcome than a share that lives 30 days.
 */
export function parseTtlDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_DAYS;
  return Math.min(Math.floor(n), MAX_TTL_DAYS);
}

/** The link the app copies to the clipboard. */
export function shareUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/w/${slug}`;
}

export interface ShareKv {
  get(key: string, type: "text"): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

const KEY_PREFIX = "share:";

export function shareKey(slug: string): string {
  return `${KEY_PREFIX}${slug}`;
}

/**
 * Store a rendered wishlist and return its link. The body is the HTML
 * itself rather than a JSON envelope: these documents carry embedded images
 * and can run to megabytes, and base64-in-JSON would inflate that by a third
 * for no benefit.
 */
export async function handlePutShare(
  req: Request,
  kv: ShareKv,
  url: URL,
  now: number,
): Promise<Response> {
  const html = await req.text();
  if (html.trim() === "") {
    return json({ error: "empty document" }, 400);
  }
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_SHARE_BYTES) {
    return json(
      { error: "document too large", bytes, max_bytes: MAX_SHARE_BYTES },
      413,
    );
  }

  const ttlDays = parseTtlDays(url.searchParams.get("ttl_days"));
  const slug = newSlug();
  await kv.put(shareKey(slug), html, {
    expirationTtl: ttlDays * SECONDS_PER_DAY,
  });

  return json(
    {
      slug,
      url: shareUrl(url.origin, slug),
      expires_at: Math.floor(now / 1000) + ttlDays * SECONDS_PER_DAY,
      ttl_days: ttlDays,
      bytes,
    },
    201,
  );
}

/**
 * Serve a shared wishlist. Public by design — the slug is the credential.
 *
 * `noindex` matters more than it looks: these links get pasted into group
 * chats and forums, and a crawler that finds one would put a personal
 * wishlist in a search index permanently, long after the KV entry expires.
 */
export async function handleGetShare(
  slug: string,
  kv: ShareKv,
): Promise<Response> {
  if (!isValidSlug(slug)) return notFoundPage();
  const html = await kv.get(shareKey(slug), "text");
  if (html === null) return notFoundPage();
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      // Shares are immutable for their lifetime — the app revokes and
      // re-shares rather than editing in place — but keep it short so a
      // revoke takes effect promptly at the edge.
      "cache-control": "public, max-age=300",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Revoke a share. Deleting a slug that isn't there succeeds: revoke is the
 * user asking for the link to stop working, and it already doesn't. Erroring
 * would make "revoke, then revoke again" look like a failure.
 */
export async function handleDeleteShare(
  slug: string,
  kv: ShareKv,
): Promise<Response> {
  if (!isValidSlug(slug)) return json({ error: "bad slug" }, 400);
  await kv.delete(shareKey(slug));
  return new Response(null, { status: 204 });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Deliberately identical for "never existed", "expired" and "revoked" — a
 *  recipient learns nothing about which, and the sender's answer is the same
 *  either way: ask for a fresh link. */
function notFoundPage(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow">` +
      `<title>Link expired</title>` +
      `<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;` +
      `margin:0;min-height:100vh;display:grid;place-items:center;` +
      `background:#0f1115;color:#e6e8ee}main{text-align:center;padding:2rem;` +
      `max-width:32rem}h1{font-size:1.25rem;margin:0 0 .5rem}` +
      `p{margin:0;color:#9aa3b2;line-height:1.5}</style></head>` +
      `<body><main><h1>This link isn't available</h1>` +
      `<p>Shared wishlists expire, and the sender can turn one off at any ` +
      `time. Ask them for a fresh link.</p></main></body></html>`,
    {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}
