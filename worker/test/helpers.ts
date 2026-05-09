/**
 * Test-only helpers: in-memory KV stub, eBay signature/header construction,
 * keypair + PEM export, and a fetch mock for the eBay token + public-key
 * endpoints.
 */

import type { Env } from "../src/index";

export type FakeKv = KVNamespace & { _store: Map<string, string> };

export function makeKv(): FakeKv {
  const store = new Map<string, string>();
  const ns = {
    _store: store,
    async get(key: string, opts?: unknown): Promise<unknown> {
      const raw = store.get(key);
      if (raw === undefined) return null;
      const type = typeof opts === "string" ? opts : (opts as { type?: string })?.type;
      if (type === "json") return JSON.parse(raw);
      return raw;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }): Promise<{
      keys: { name: string }[];
      list_complete: true;
      cursor: undefined;
    }> {
      const keys = [...store.keys()]
        .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
  return ns as unknown as FakeKv;
}

export function makeEnv(overrides: Partial<Env> = {}): Env & {
  DELETIONS: FakeKv;
  EBAY_KEY_CACHE: FakeKv;
} {
  return {
    DELETIONS: makeKv(),
    EBAY_KEY_CACHE: makeKv(),
    EBAY_VERIFICATION_TOKEN: "verify-token-x".padEnd(40, "x"),
    APP_SHARED_SECRET: "shared-secret",
    ENDPOINT_URL: "https://example.test/marketplace-deletion",
    EBAY_CLIENT_ID: "client-id",
    EBAY_CLIENT_SECRET: "client-secret",
    ...overrides,
  } as Env & { DELETIONS: FakeKv; EBAY_KEY_CACHE: FakeKv };
}

export async function generateP256Keypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export async function exportPublicKeyPem(key: CryptoKey): Promise<string> {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", key));
  const b64 = bytesToBase64(spki);
  // 64-char-wrapped PEM body, matching what eBay returns.
  const wrapped = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

/**
 * Sign rawBody with `key` using ECDSA-SHA1. Web Crypto returns raw r||s;
 * we re-encode to DER for the eBay header format.
 */
export async function signEbayBody(
  privateKey: CryptoKey,
  rawBody: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-1" },
      privateKey,
      rawBody,
    ),
  );
  return rawToDerEcdsaSignature(raw, 32);
}

export function buildSigHeader(
  kid: string,
  derSig: Uint8Array,
  overrides: Partial<{ alg: string; digest: string }> = {},
): string {
  const headerObj = {
    alg: overrides.alg ?? "ecdsa",
    kid,
    signature: bytesToBase64(derSig),
    digest: overrides.digest ?? "SHA1",
  };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(headerObj)));
}

/**
 * Inverse of derToRawEcdsaSignature: encode raw r||s as DER for testing.
 */
export function rawToDerEcdsaSignature(
  raw: Uint8Array,
  coordSize: number,
): Uint8Array {
  if (raw.length !== coordSize * 2) throw new Error("raw length mismatch");
  const r = trimAndPadInt(raw.subarray(0, coordSize));
  const s = trimAndPadInt(raw.subarray(coordSize));
  const seqBody = new Uint8Array(2 + r.length + 2 + s.length);
  let i = 0;
  seqBody[i++] = 0x02;
  seqBody[i++] = r.length;
  seqBody.set(r, i);
  i += r.length;
  seqBody[i++] = 0x02;
  seqBody[i++] = s.length;
  seqBody.set(s, i);
  // For P-256 the body is < 128 bytes so single-byte length is fine.
  const out = new Uint8Array(2 + seqBody.length);
  out[0] = 0x30;
  out[1] = seqBody.length;
  out.set(seqBody, 2);
  return out;
}

function trimAndPadInt(coord: Uint8Array): Uint8Array {
  // Strip leading zero bytes.
  let start = 0;
  while (start < coord.length - 1 && coord[start] === 0x00) start++;
  const trimmed = coord.subarray(start);
  // If high bit set, prepend 0x00 to keep value positive in DER.
  if (trimmed[0] & 0x80) {
    const out = new Uint8Array(trimmed.length + 1);
    out[0] = 0x00;
    out.set(trimmed, 1);
    return out;
  }
  return trimmed.slice();
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Mock fetch for eBay's token + public-key endpoints. Returns counters so
 * caching tests can assert call counts.
 */
export type FetchCounts = { token: number; publicKey: number };

export function installEbayFetchMock(
  pem: string,
  kid: string,
): { restore: () => void; counts: FetchCounts } {
  const counts: FetchCounts = { token: 0, publicKey: 0 };
  const original = globalThis.fetch;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/identity/v1/oauth2/token")) {
      counts.token++;
      return new Response(
        JSON.stringify({ access_token: "test-app-token", expires_in: 7200 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes(`/public_key/${kid}`)) {
      counts.publicKey++;
      return new Response(
        JSON.stringify({ key: pem, algorithm: "ECDSA", digest: "SHA1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    counts,
  };
}
