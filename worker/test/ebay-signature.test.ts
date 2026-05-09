import { describe, expect, it } from "vitest";
import { derToRawEcdsaSignature } from "../src/ebay-signature";
import { generateP256Keypair, rawToDerEcdsaSignature } from "./helpers";

describe("derToRawEcdsaSignature", () => {
  it("round-trips a real signature back to raw r||s", async () => {
    const { privateKey } = await generateP256Keypair();
    const body = new TextEncoder().encode("hello");
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-1" },
        privateKey,
        body,
      ),
    );
    const der = rawToDerEcdsaSignature(raw, 32);
    const back = derToRawEcdsaSignature(der, 32);
    expect(back).toEqual(raw);
  });

  it("strips the DER sign-disambiguation 0x00 prefix", () => {
    // r and s both have high bit set → DER encoder prepends 0x00 to each.
    const r = new Uint8Array(32).fill(0xaa);
    const s = new Uint8Array(32).fill(0xbb);
    const raw = new Uint8Array(64);
    raw.set(r, 0);
    raw.set(s, 32);
    const der = rawToDerEcdsaSignature(raw, 32);
    // Each integer encoded as 0x02 0x21 0x00 <32 bytes>, so total body is
    // 2*(2 + 33) = 70 bytes; outer SEQUENCE adds 2 bytes → 72.
    expect(der.length).toBe(72);
    const back = derToRawEcdsaSignature(der, 32);
    expect(back).toEqual(raw);
  });

  it("left-pads short coordinates to coordSize", () => {
    // r is small (1 byte) and s is small (2 bytes). After DER round-trip
    // they should be left-padded back to 32 bytes each.
    const raw = new Uint8Array(64);
    raw[31] = 0x05; // r = 0x05
    raw[62] = 0x01; // s = 0x0102
    raw[63] = 0x02;
    const der = rawToDerEcdsaSignature(raw, 32);
    const back = derToRawEcdsaSignature(der, 32);
    expect(back).toEqual(raw);
  });

  it("throws when the first byte is not 0x30", () => {
    const bad = new Uint8Array([0x31, 0x00]);
    expect(() => derToRawEcdsaSignature(bad, 32)).toThrow(/sequence/);
  });

  it("throws when a coordinate is larger than coordSize", () => {
    // SEQUENCE { INTEGER (33 bytes, no leading zero), INTEGER (1 byte) }
    const r = new Uint8Array(33).fill(0x11);
    const s = new Uint8Array([0x01]);
    const body = new Uint8Array(2 + r.length + 2 + s.length);
    let i = 0;
    body[i++] = 0x02;
    body[i++] = r.length;
    body.set(r, i);
    i += r.length;
    body[i++] = 0x02;
    body[i++] = s.length;
    body.set(s, i);
    const der = new Uint8Array(2 + body.length);
    der[0] = 0x30;
    der[1] = body.length;
    der.set(body, 2);
    expect(() => derToRawEcdsaSignature(der, 32)).toThrow(
      /larger than expected/,
    );
  });
});
