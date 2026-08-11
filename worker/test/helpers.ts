/**
 * Test-only helpers: in-memory KV stub, eBay signature/header construction,
 * keypair + PEM export, and a fetch mock for the eBay token + public-key
 * endpoints.
 */

import type { Env } from "../src/index";

export type FakeKv = KVNamespace & {
  _store: Map<string, string>;
  /** Options each put was called with, so TTL can be asserted rather than
   *  assumed — an expiring share that silently never expires looks
   *  identical in every other test. */
  _putOptions: Map<string, { expirationTtl?: number } | undefined>;
};

export function makeKv(): FakeKv {
  const store = new Map<string, string>();
  const putOptions = new Map<string, { expirationTtl?: number } | undefined>();
  const ns = {
    _store: store,
    _putOptions: putOptions,
    async get(key: string, opts?: unknown): Promise<unknown> {
      const raw = store.get(key);
      if (raw === undefined) return null;
      const type =
        typeof opts === "string" ? opts : (opts as { type?: string })?.type;
      if (type === "json") return JSON.parse(raw);
      return raw;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ): Promise<void> {
      store.set(key, value);
      putOptions.set(key, options);
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

/**
 * Minimal D1 mock that mirrors the `prepare().bind().run()` chain we use.
 * Captures every successful insert in `_rows` keyed by notification_id so
 * tests can assert on the write. Honors `ON CONFLICT DO NOTHING` by only
 * inserting when the key is new. `_failNextRun` / `_failRuns` /
 * `_failAllRuns` cause the next `run()` or
 * `all()` to reject, used to exercise failure paths.
 */
export interface FakeD1Row {
  notification_id: string;
  received_at: number;
  acked_at: number | null;
  user_id: string | null;
  username: string | null;
  eias_token: string | null;
  raw: string;
}

export type FakeD1 = D1Database & {
  _rows: Map<string, FakeD1Row>;
  _failNextRun: boolean;
  /** Fail this many subsequent runs, then succeed. For retry paths. */
  _failRuns: number;
  /** Fail every run — a permanent fault rather than a transient blip. */
  _failAllRuns: boolean;
};

/**
 * Recognises four statement shapes:
 *
 *   - `INSERT INTO marketplace_deletions ... ON CONFLICT DO NOTHING` — write
 *     path from `handleNotification`.
 *   - `SELECT ... FROM marketplace_deletions WHERE acked_at IS NULL ORDER BY
 *     received_at` — read path from `handlePending`.
 *   - `UPDATE marketplace_deletions SET acked_at = ? WHERE notification_id IN
 *     (...) AND acked_at IS NULL` — ack path from `handleAck`.
 *   - `DELETE FROM marketplace_deletions WHERE acked_at IS NOT NULL AND
 *     acked_at < ?` — purge cron from `purgeAckedDeletions`.
 */
export function makeD1(): FakeD1 {
  const rows = new Map<string, FakeD1Row>();
  const db = {
    _rows: rows,
    _failNextRun: false,
    _failRuns: 0,
    _failAllRuns: false,
    prepare(sql: string): D1PreparedStatement {
      const isInsert = /INSERT\s+INTO\s+marketplace_deletions/i.test(sql);
      const isOnConflictNothing = /ON\s+CONFLICT.*DO\s+NOTHING/is.test(sql);
      const isSelectPending =
        /SELECT[\s\S]*FROM\s+marketplace_deletions[\s\S]*WHERE\s+acked_at\s+IS\s+NULL/i.test(
          sql,
        );
      const isUpdateAck =
        /UPDATE\s+marketplace_deletions[\s\S]*SET\s+acked_at[\s\S]*WHERE\s+notification_id\s+IN/i.test(
          sql,
        );
      const isDeletePurge =
        /DELETE\s+FROM\s+marketplace_deletions[\s\S]*WHERE\s+acked_at\s+IS\s+NOT\s+NULL[\s\S]*acked_at\s*<\s*\?/i.test(
          sql,
        );
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]): D1PreparedStatement {
          bound = values;
          return stmt;
        },
        async run(): Promise<unknown> {
          if (db._failNextRun) {
            db._failNextRun = false;
            throw new Error("simulated d1 failure");
          }
          if (db._failAllRuns) {
            throw new Error("simulated d1 failure");
          }
          if (db._failRuns > 0) {
            db._failRuns--;
            throw new Error("simulated d1 failure");
          }
          if (isInsert) {
            const [id, received_at, user_id, username, eias_token, raw] =
              bound as [
                string,
                number,
                string | null,
                string | null,
                string | null,
                string,
              ];
            if (!(isOnConflictNothing && rows.has(id))) {
              rows.set(id, {
                notification_id: id,
                received_at,
                acked_at: null,
                user_id,
                username,
                eias_token,
                raw,
              });
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (isUpdateAck) {
            const [now, ...ids] = bound as [number, ...string[]];
            let changes = 0;
            for (const id of ids) {
              const row = rows.get(id);
              if (row && row.acked_at === null) {
                row.acked_at = now;
                changes++;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (isDeletePurge) {
            const [cutoff] = bound as [number];
            let changes = 0;
            for (const [id, row] of rows) {
              if (row.acked_at !== null && row.acked_at < cutoff) {
                rows.delete(id);
                changes++;
              }
            }
            return { success: true, meta: { changes } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          if (db._failNextRun) {
            db._failNextRun = false;
            throw new Error("simulated d1 failure");
          }
          if (db._failAllRuns) {
            throw new Error("simulated d1 failure");
          }
          if (db._failRuns > 0) {
            db._failRuns--;
            throw new Error("simulated d1 failure");
          }
          if (isSelectPending) {
            const pending = [...rows.values()]
              .filter((r) => r.acked_at === null)
              .sort((a, b) => a.received_at - b.received_at);
            return { results: pending as unknown as T[] };
          }
          return { results: [] };
        },
      } as unknown as D1PreparedStatement;
      return stmt;
    },
  };
  return db as unknown as FakeD1;
}

/**
 * Rate-limiter stub. `success: true` lets every request through (the default
 * for tests that aren't exercising throttling); pass `false` to simulate a
 * client that's over the limit.
 */
export function makeRateLimit(success = true): Env["POST_LIMITER"] {
  return { limit: async () => ({ success }) };
}

export function makeEnv(overrides: Partial<Env> = {}): Env & {
  EBAY_KEY_CACHE: FakeKv;
  SHARES: FakeKv;
  DB: FakeD1;
} {
  return {
    EBAY_KEY_CACHE: makeKv(),
    SHARES: makeKv(),
    DB: makeD1(),
    POST_LIMITER: makeRateLimit(),
    EBAY_VERIFICATION_TOKEN: "verify-token-x".padEnd(40, "x"),
    APP_SHARED_SECRET: "shared-secret",
    ENDPOINT_URL: "https://example.test/marketplace-deletion",
    EBAY_CLIENT_ID: "client-id",
    EBAY_CLIENT_SECRET: "client-secret",
    ...overrides,
  } as Env & { EBAY_KEY_CACHE: FakeKv; SHARES: FakeKv; DB: FakeD1 };
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
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
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
