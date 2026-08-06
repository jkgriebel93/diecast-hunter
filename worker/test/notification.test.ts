import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotification } from "../src/index";
import {
  buildSigHeader,
  exportPublicKeyPem,
  generateP256Keypair,
  installEbayFetchMock,
  makeEnv,
  makeRateLimit,
  signEbayBody,
} from "./helpers";

const KID = "test-kid-uuid";

let keypair: CryptoKeyPair;
let pem: string;
let restore: () => void;
let counts: { token: number; publicKey: number };

beforeEach(async () => {
  keypair = await generateP256Keypair();
  pem = await exportPublicKeyPem(keypair.publicKey);
  ({ restore, counts } = installEbayFetchMock(pem, KID));
});

afterEach(() => {
  restore();
});

function postReq(
  body: string | ArrayBuffer,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://example.test/marketplace-deletion", {
    method: "POST",
    body,
    headers,
  });
}

async function signedReq(
  body: string,
  privateKey: CryptoKey,
  sigOverrides: Partial<{ alg: string; digest: string }> = {},
): Promise<Request> {
  const bodyBytes = new TextEncoder().encode(body);
  const der = await signEbayBody(privateKey, bodyBytes);
  const sigHeader = buildSigHeader(KID, der, sigOverrides);
  return postReq(bodyBytes.buffer, { "x-ebay-signature": sigHeader });
}

function validNotification(id = "notif-123"): string {
  return JSON.stringify({
    notification: {
      notificationId: id,
      data: { username: "u", userId: "uid", eiasToken: "tok" },
    },
  });
}

describe("handleNotification", () => {
  it("returns 429 without verifying or writing when rate limited", async () => {
    const env = makeEnv({ POST_LIMITER: makeRateLimit(false) });
    const req = await signedReq(validNotification(), keypair.privateKey);
    const res = await handleNotification(req, env);
    expect(res.status).toBe(429);
    // Throttling short-circuits before the KV-backed signature lookup, so no
    // public-key fetch happens and nothing is written.
    expect(counts.publicKey).toBe(0);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when x-ebay-signature is missing", async () => {
    const env = makeEnv();
    const res = await handleNotification(postReq(validNotification()), env);
    expect(res.status).toBe(412);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when x-ebay-signature is not valid base64/JSON", async () => {
    const env = makeEnv();
    const res = await handleNotification(
      postReq(validNotification(), { "x-ebay-signature": "###not-base64###" }),
      env,
    );
    expect(res.status).toBe(412);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when alg is wrong", async () => {
    const env = makeEnv();
    const req = await signedReq(validNotification(), keypair.privateKey, {
      alg: "rsa",
    });
    const res = await handleNotification(req, env);
    expect(res.status).toBe(412);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when digest is wrong", async () => {
    const env = makeEnv();
    const req = await signedReq(validNotification(), keypair.privateKey, {
      digest: "SHA256",
    });
    const res = await handleNotification(req, env);
    expect(res.status).toBe(412);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when body is tampered after signing", async () => {
    const env = makeEnv();
    const original = validNotification();
    const der = await signEbayBody(
      keypair.privateKey,
      new TextEncoder().encode(original),
    );
    const sigHeader = buildSigHeader(KID, der);
    // Send a different body with the original signature.
    const tampered = validNotification("notif-999");
    const res = await handleNotification(
      postReq(tampered, { "x-ebay-signature": sigHeader }),
      env,
    );
    expect(res.status).toBe(412);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when signature bytes are flipped", async () => {
    const env = makeEnv();
    const body = validNotification();
    const der = await signEbayBody(
      keypair.privateKey,
      new TextEncoder().encode(body),
    );
    // Flip the last byte of the DER signature.
    const tampered = new Uint8Array(der);
    tampered[tampered.length - 1] ^= 0x01;
    const sigHeader = buildSigHeader(KID, tampered);
    const res = await handleNotification(
      postReq(body, { "x-ebay-signature": sigHeader }),
      env,
    );
    expect(res.status).toBe(412);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 400 with no write when verified body lacks notificationId", async () => {
    const env = makeEnv();
    const body = JSON.stringify({ notification: { data: { x: 1 } } });
    const req = await signedReq(body, keypair.privateKey);
    const res = await handleNotification(req, env);
    expect(res.status).toBe(400);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 200 and writes a row to D1 on a valid notification", async () => {
    const env = makeEnv();
    const body = validNotification("notif-abc");
    const req = await signedReq(body, keypair.privateKey);
    const res = await handleNotification(req, env);
    expect(res.status).toBe(200);

    expect(env.DB._rows.size).toBe(1);
    const row = env.DB._rows.get("notif-abc")!;
    expect(row.user_id).toBe("uid");
    expect(row.username).toBe("u");
    expect(row.eias_token).toBe("tok");
    expect(typeof row.received_at).toBe("number");
    expect(row.acked_at).toBeNull();
    // `raw` column stores only the `notification` sub-object.
    expect(JSON.parse(row.raw)).toEqual({
      notificationId: "notif-abc",
      data: { username: "u", userId: "uid", eiasToken: "tok" },
    });
  });

  it("is idempotent across retries with the same notificationId", async () => {
    const env = makeEnv();
    const body = validNotification("notif-retry");
    for (let i = 0; i < 3; i++) {
      const req = await signedReq(body, keypair.privateKey);
      const res = await handleNotification(req, env);
      expect(res.status).toBe(200);
    }
    expect(env.DB._rows.size).toBe(1);
  });

  it("retries a transient D1 failure and still records the deletion", async () => {
    // The failure class that actually costs us data: a blip on the only
    // store. Retrying in-request recovers it without involving eBay's
    // retry pipeline, which we can't use safely (see the next test).
    const env = makeEnv();
    env.DB._failRuns = 1; // first attempt throws, the retry succeeds
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handleNotification(
        await signedReq(
          validNotification("notif-d1-retry"),
          keypair.privateKey,
        ),
        env,
      );
      expect(res.status).toBe(200);
    } finally {
      errSpy.mockRestore();
    }
    expect(env.DB._rows.size).toBe(1);
  });

  it("answers 200 and logs store_failed when every insert attempt fails", async () => {
    // Contract (DCH-28, documented in README.md): a permanent fault must
    // NOT become a non-2xx. eBay retries non-2xx indefinitely and a
    // permanent fault fails identically every time, so the retries become a
    // storm that trips eBay's endpoint-down detection — risking the whole
    // subscription to save one record.
    const env = makeEnv();
    env.DB._failAllRuns = true;
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((m?: unknown) => void logs.push(String(m)));
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((m?: unknown) => void errors.push(String(m)));
    try {
      const res = await handleNotification(
        await signedReq(validNotification("notif-d1-fail"), keypair.privateKey),
        env,
      );
      expect(res.status).toBe(200);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(env.DB._rows.size).toBe(0);
    // The outcome line must not claim "stored" when nothing was stored.
    expect(logs.some((l) => l.includes('"outcome":"store_failed"'))).toBe(true);
    expect(logs.some((l) => l.includes('"outcome":"stored"'))).toBe(false);
    // The alertable event carries the id of the notification we lost.
    const lost = errors.find((e) => e.includes("deletion_insert_failed"));
    expect(lost).toBeDefined();
    expect(lost).toContain("notif-d1-fail");
  });

  describe("Sentry reporting (DCH-30)", () => {
    /** Collects deferred work so a test can await it, standing in for the
     *  Cloudflare ExecutionContext. */
    function makeCtx() {
      const pending: Promise<unknown>[] = [];
      return {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        settled: () => Promise.all(pending),
      };
    }

    const DSN = "https://key123@o1.ingest.us.sentry.io/42";

    it("reports a lost notification to Sentry", async () => {
      const env = makeEnv({ SENTRY_DSN: DSN });
      env.DB._failAllRuns = true;
      // Intercept only Sentry. Everything else has to reach the eBay mock
      // installed in beforeEach, or signature verification fails and the
      // request never gets as far as the insert.
      const realFetch = globalThis.fetch;
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(((input: RequestInfo | URL, init?: RequestInit) =>
          String(input).includes("sentry.io")
            ? Promise.resolve(new Response("", { status: 200 }))
            : realFetch(input as RequestInfo, init)) as typeof fetch);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ctx = makeCtx();

      const res = await handleNotification(
        await signedReq(validNotification("notif-sentry"), keypair.privateKey),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      await ctx.settled();

      const sentryCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("sentry.io"),
      );
      expect(sentryCalls).toHaveLength(1);
      expect(String((sentryCalls[0][1] as RequestInit).body)).toContain(
        "notif-sentry",
      );
      vi.restoreAllMocks();
    });

    it("sends nothing when the write succeeds", async () => {
      // The alert must mean something. A successful notification reporting
      // to Sentry would train whoever gets the email to ignore it.
      const env = makeEnv({ SENTRY_DSN: DSN });
      const fetchMock = vi.spyOn(globalThis, "fetch");
      vi.spyOn(console, "log").mockImplementation(() => {});
      const ctx = makeCtx();

      const res = await handleNotification(
        await signedReq(validNotification("notif-ok"), keypair.privateKey),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      await ctx.settled();

      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes("sentry.io")),
      ).toHaveLength(0);
      vi.restoreAllMocks();
    });

    it("still answers 200 when Sentry itself is unreachable", async () => {
      // Reporting is best-effort. eBay's response must not depend on it.
      const env = makeEnv({ SENTRY_DSN: DSN });
      env.DB._failAllRuns = true;
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(((
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        if (String(input).includes("sentry.io")) {
          return Promise.reject(new Error("sentry unreachable"));
        }
        return realFetch(input as RequestInfo, init);
      }) as typeof fetch);
      const ctx = makeCtx();

      const res = await handleNotification(
        await signedReq(validNotification("notif-down"), keypair.privateKey),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      // The deferred report resolves rather than rejecting, so the runtime
      // never sees an unhandled rejection.
      await expect(ctx.settled()).resolves.toBeDefined();
      vi.restoreAllMocks();
    });

    it("makes no Sentry call when SENTRY_DSN is unset", async () => {
      const env = makeEnv(); // no DSN — the default deployment before this ships
      env.DB._failAllRuns = true;
      const fetchMock = vi.spyOn(globalThis, "fetch");
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ctx = makeCtx();

      const res = await handleNotification(
        await signedReq(validNotification("notif-nodsn"), keypair.privateKey),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      await ctx.settled();

      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes("sentry.io")),
      ).toHaveLength(0);
      vi.restoreAllMocks();
    });
  });

  it("caches the public key after the first verify", async () => {
    const env = makeEnv();
    const body1 = validNotification("notif-1");
    const body2 = validNotification("notif-2");

    await handleNotification(await signedReq(body1, keypair.privateKey), env);
    expect(counts.publicKey).toBe(1);

    await handleNotification(await signedReq(body2, keypair.privateKey), env);
    expect(counts.publicKey).toBe(1);
  });

  it("caches the app access token across verifies", async () => {
    const env = makeEnv();
    await handleNotification(
      await signedReq(validNotification("a"), keypair.privateKey),
      env,
    );
    await handleNotification(
      await signedReq(validNotification("b"), keypair.privateKey),
      env,
    );
    expect(counts.token).toBe(1);
  });
});
