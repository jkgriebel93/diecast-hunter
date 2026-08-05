/**
 * eBay app-access-token and notification public-key fetching, with
 * KV-backed caching in EBAY_KEY_CACHE.
 *
 * - App access token: client_credentials grant; lifetime ~2h.
 * - Public key: fetched per `kid` from the Notification API; eBay rotates
 *   rarely, so cache 24h.
 *
 * Caches are intentionally in a separate KV namespace from DELETIONS so
 * cache writes don't tangle with deletion records.
 */

import type { Env } from "./index";

type CachedKey = { pem: string; fetched_at: number };
type CachedToken = { token: string; expires_at: number };

const PUBLIC_KEY_TTL_SECONDS = 60 * 60 * 24;
const TOKEN_REFRESH_SLOP_MS = 60_000;

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
  const data = (await resp.json()) as {
    key: string;
    algorithm: string;
    digest: string;
  };
  if (data.algorithm !== "ECDSA" || data.digest !== "SHA1") {
    throw new Error(
      `unexpected key algo/digest: ${data.algorithm}/${data.digest}`,
    );
  }

  const value: CachedKey = { pem: data.key, fetched_at: Date.now() };
  await env.EBAY_KEY_CACHE.put(cacheKey, JSON.stringify(value), {
    expirationTtl: PUBLIC_KEY_TTL_SECONDS,
  });
  return data.key;
}

export async function getAppAccessToken(env: Env): Promise<string> {
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
    throw new Error(
      `app token fetch failed: ${resp.status} ${await resp.text()}`,
    );
  }
  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };
  const expires_at = Date.now() + data.expires_in * 1000;

  const value: CachedToken = { token: data.access_token, expires_at };
  await env.EBAY_KEY_CACHE.put("app_token", JSON.stringify(value), {
    expirationTtl: Math.max(60, data.expires_in - 60),
  });
  return data.access_token;
}
