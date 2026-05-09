/**
 * eBay Marketplace Account Deletion notification signature verification.
 *
 * Spec: https://developer.ebay.com/marketplace-account-deletion
 *
 * The `x-ebay-signature` header is base64(JSON) of:
 *   { alg: "ecdsa", kid, signature: base64(DER), digest: "SHA1" }
 * The signature covers the raw request body bytes. The signing curve is
 * P-256; the digest is SHA-1.
 *
 * Web Crypto's ECDSA verify wants raw r||s, so we convert from DER first.
 */

import type { Env } from "./index";
import { getPublicKeyPem } from "./ebay-token";

export type EbaySigHeader = {
  alg: string;
  kid: string;
  signature: string;
  digest: string;
};

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
  const rawSig = derToRawEcdsaSignature(base64ToBytes(parsed.signature), 32);

  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-1" },
    key,
    rawSig,
    rawBody,
  );
}

export function parseSigHeader(headerB64: string): EbaySigHeader {
  const json = new TextDecoder().decode(base64ToBytes(headerB64));
  const obj = JSON.parse(json);
  if (
    typeof obj?.alg !== "string" ||
    typeof obj?.kid !== "string" ||
    typeof obj?.signature !== "string" ||
    typeof obj?.digest !== "string"
  ) {
    throw new Error("malformed x-ebay-signature header");
  }
  return obj as EbaySigHeader;
}

export async function importEcdsaPublicKey(pem: string): Promise<CryptoKey> {
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
 * DER ECDSA signature: 0x30 LEN 0x02 RLEN R 0x02 SLEN S.
 * Each integer may carry a leading 0x00 sign byte; strip it.
 * Each coord is left-padded to coordSize (32 for P-256) and concatenated.
 */
export function derToRawEcdsaSignature(
  der: Uint8Array,
  coordSize: number,
): Uint8Array {
  if (der[0] !== 0x30) throw new Error("DER: expected sequence");
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);

  if (der[offset] !== 0x02) throw new Error("DER: expected integer for r");
  const rLen = der[offset + 1];
  let r = der.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;

  if (der[offset] !== 0x02) throw new Error("DER: expected integer for s");
  const sLen = der[offset + 1];
  let s = der.subarray(offset + 2, offset + 2 + sLen);

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

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
