import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("propagates D1 failure so the runtime returns 5xx and eBay retries", async () => {
    // Phase 3 removed the KV safety net. With only one store, the
    // Promise.allSettled isolation is gone too — a D1 failure now bubbles
    // out of the handler. The worker runtime turns that into a 5xx, which
    // is exactly what we want so eBay's retry pipeline gets us back to
    // consistency rather than silently dropping the record.
    const env = makeEnv();
    env.DB._failNextRun = true;
    const req = await signedReq(
      validNotification("notif-d1-fail"),
      keypair.privateKey,
    );
    await expect(handleNotification(req, env)).rejects.toThrow(
      /simulated d1 failure/,
    );
    expect(env.DB._rows.size).toBe(0);
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
