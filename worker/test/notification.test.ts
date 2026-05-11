import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotification } from "../src/index";
import {
  buildSigHeader,
  exportPublicKeyPem,
  generateP256Keypair,
  installEbayFetchMock,
  makeEnv,
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

function postReq(body: string | ArrayBuffer, headers: Record<string, string> = {}): Request {
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
  it("returns 412 when x-ebay-signature is missing", async () => {
    const env = makeEnv();
    const res = await handleNotification(postReq(validNotification()), env);
    expect(res.status).toBe(412);
    expect(env.DELETIONS._store.size).toBe(0);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when x-ebay-signature is not valid base64/JSON", async () => {
    const env = makeEnv();
    const res = await handleNotification(
      postReq(validNotification(), { "x-ebay-signature": "###not-base64###" }),
      env,
    );
    expect(res.status).toBe(412);
    expect(env.DELETIONS._store.size).toBe(0);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when alg is wrong", async () => {
    const env = makeEnv();
    const req = await signedReq(validNotification(), keypair.privateKey, {
      alg: "rsa",
    });
    const res = await handleNotification(req, env);
    expect(res.status).toBe(412);
    expect(env.DELETIONS._store.size).toBe(0);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 412 when digest is wrong", async () => {
    const env = makeEnv();
    const req = await signedReq(validNotification(), keypair.privateKey, {
      digest: "SHA256",
    });
    const res = await handleNotification(req, env);
    expect(res.status).toBe(412);
    expect(env.DELETIONS._store.size).toBe(0);
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
    expect(env.DELETIONS._store.size).toBe(0);
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
    expect(env.DELETIONS._store.size).toBe(0);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 400 with no KV write when verified body lacks notificationId", async () => {
    const env = makeEnv();
    const body = JSON.stringify({ notification: { data: { x: 1 } } });
    const req = await signedReq(body, keypair.privateKey);
    const res = await handleNotification(req, env);
    expect(res.status).toBe(400);
    expect(env.DELETIONS._store.size).toBe(0);
    expect(env.DB._rows.size).toBe(0);
  });

  it("returns 200 and writes to both D1 and KV on a valid notification", async () => {
    const env = makeEnv();
    const body = validNotification("notif-abc");
    const req = await signedReq(body, keypair.privateKey);
    const res = await handleNotification(req, env);
    expect(res.status).toBe(200);

    expect([...env.DELETIONS._store.keys()]).toEqual(["deletion:notif-abc"]);
    const stored = JSON.parse(env.DELETIONS._store.get("deletion:notif-abc")!);
    expect(stored.raw.notification.notificationId).toBe("notif-abc");
    expect(typeof stored.received_at).toBe("number");

    expect(env.DB._rows.size).toBe(1);
    const row = env.DB._rows.get("notif-abc")!;
    expect(row.user_id).toBe("uid");
    expect(row.username).toBe("u");
    expect(row.eias_token).toBe("tok");
    expect(typeof row.received_at).toBe("number");
    // `raw` column stores only the `notification` sub-object, per spec.
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
    expect(env.DELETIONS._store.size).toBe(1);
    expect(env.DB._rows.size).toBe(1);
  });

  it("still returns 200 and writes to KV when the D1 write fails", async () => {
    const env = makeEnv();
    env.DB._failNextRun = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = validNotification("notif-d1-fail");
    const req = await signedReq(body, keypair.privateKey);
    const res = await handleNotification(req, env);

    expect(res.status).toBe(200);
    expect(env.DELETIONS._store.size).toBe(1);
    expect(env.DB._rows.size).toBe(0);

    // Structured failure log for drift attribution.
    const logged = errSpy.mock.calls.map((c) => String(c[0]));
    const d1Failure = logged.find((line) => line.includes('"store":"d1"'));
    expect(d1Failure).toBeDefined();
    const parsed = JSON.parse(d1Failure!);
    expect(parsed.event).toBe("deletion_write_failed");
    expect(parsed.notification_id).toBe("notif-d1-fail");
    errSpy.mockRestore();
  });

  it("still returns 200 and writes to D1 when the KV write fails", async () => {
    const env = makeEnv();
    // Force the next KV put to throw.
    env.DELETIONS.put = (async () => {
      throw new Error("simulated kv failure");
    }) as KVNamespace["put"];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = validNotification("notif-kv-fail");
    const req = await signedReq(body, keypair.privateKey);
    const res = await handleNotification(req, env);

    expect(res.status).toBe(200);
    expect(env.DB._rows.size).toBe(1);
    expect(env.DB._rows.has("notif-kv-fail")).toBe(true);

    const logged = errSpy.mock.calls.map((c) => String(c[0]));
    const kvFailure = logged.find((line) => line.includes('"store":"kv"'));
    expect(kvFailure).toBeDefined();
    const parsed = JSON.parse(kvFailure!);
    expect(parsed.event).toBe("deletion_write_failed");
    expect(parsed.notification_id).toBe("notif-kv-fail");
    errSpy.mockRestore();
  });

  it("returns 200 and logs both failures when D1 and KV both fail", async () => {
    const env = makeEnv();
    env.DB._failNextRun = true;
    env.DELETIONS.put = (async () => {
      throw new Error("simulated kv failure");
    }) as KVNamespace["put"];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = validNotification("notif-both-fail");
    const req = await signedReq(body, keypair.privateKey);
    const res = await handleNotification(req, env);

    expect(res.status).toBe(200);
    expect(env.DB._rows.size).toBe(0);
    expect(env.DELETIONS._store.size).toBe(0);

    const stores = errSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])).store;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    expect(stores).toEqual(expect.arrayContaining(["d1", "kv"]));
    errSpy.mockRestore();
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
