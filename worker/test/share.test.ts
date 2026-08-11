import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  DEFAULT_TTL_DAYS,
  MAX_SHARE_BYTES,
  MAX_TTL_DAYS,
  isValidSlug,
  newSlug,
  parseTtlDays,
  shareKey,
  shareUrl,
} from "../src/share";
import { makeEnv } from "./helpers";

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const DOC = "<!doctype html><title>Hunts</title><h1>Hunts</h1>";

function putReq(body = DOC, ttlDays?: number, secret = "shared-secret") {
  const q = ttlDays === undefined ? "" : `?ttl_days=${ttlDays}`;
  return new Request(`https://w.test/api/share${q}`, {
    method: "PUT",
    body,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "text/html",
    },
  });
}

async function share(env: ReturnType<typeof makeEnv>, ttlDays?: number) {
  const res = await worker.fetch(putReq(DOC, ttlDays), env, ctx);
  return (await res.json()) as {
    slug: string;
    url: string;
    expires_at: number;
    ttl_days: number;
    bytes: number;
  };
}

describe("slugs", () => {
  it("are 128 bits of base64url, so guessing is not a strategy", () => {
    const slug = newSlug();
    expect(slug).toHaveLength(22);
    expect(isValidSlug(slug)).toBe(true);
  });

  it("do not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newSlug()));
    expect(seen.size).toBe(500);
  });

  it("rejects anything that isn't the exact shape", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("short")).toBe(false);
    expect(isValidSlug("a".repeat(23))).toBe(false);
    // Path traversal and KV key-prefix escapes are the reason this is a
    // whitelist rather than a length check.
    expect(isValidSlug("../../etc/passwd")).toBe(false);
    expect(isValidSlug("share:aaaaaaaaaaaaaaaa")).toBe(false);
  });
});

describe("parseTtlDays", () => {
  it("defaults when absent or unparseable", () => {
    expect(parseTtlDays(null)).toBe(DEFAULT_TTL_DAYS);
    expect(parseTtlDays("")).toBe(DEFAULT_TTL_DAYS);
    expect(parseTtlDays("soon")).toBe(DEFAULT_TTL_DAYS);
    expect(parseTtlDays("-5")).toBe(DEFAULT_TTL_DAYS);
    expect(parseTtlDays("0")).toBe(DEFAULT_TTL_DAYS);
  });

  it("clamps to the maximum rather than honouring a forever link", () => {
    expect(parseTtlDays("3650")).toBe(MAX_TTL_DAYS);
  });

  it("takes a value inside the range", () => {
    expect(parseTtlDays("7")).toBe(7);
    expect(parseTtlDays("7.9")).toBe(7);
  });
});

describe("shareUrl", () => {
  it("builds the public link", () => {
    expect(shareUrl("https://w.test", "abc")).toBe("https://w.test/w/abc");
  });

  it("doesn't double the slash on a trailing-slash origin", () => {
    expect(shareUrl("https://w.test/", "abc")).toBe("https://w.test/w/abc");
  });
});

describe("PUT /api/share", () => {
  it("rejects an unauthenticated write", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://w.test/api/share", { method: "PUT", body: DOC }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(env.SHARES._store.size).toBe(0);
  });

  it("rejects a wrong secret", async () => {
    const env = makeEnv();
    const res = await worker.fetch(putReq(DOC, undefined, "nope"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("stores the document and returns its link", async () => {
    const env = makeEnv();
    const res = await worker.fetch(putReq(), env, ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; url: string };
    expect(isValidSlug(body.slug)).toBe(true);
    expect(body.url).toBe(`https://w.test/w/${body.slug}`);
    expect(env.SHARES._store.get(shareKey(body.slug))).toBe(DOC);
  });

  it("always sets a TTL, so no share outlives its window", async () => {
    // The failure this guards is invisible otherwise: a share with no
    // expirationTtl works perfectly and lives forever.
    const env = makeEnv();
    const body = await share(env);
    const opts = env.SHARES._putOptions.get(shareKey(body.slug));
    expect(opts?.expirationTtl).toBe(DEFAULT_TTL_DAYS * 86400);
  });

  it("honours a requested lifetime", async () => {
    const env = makeEnv();
    const body = await share(env, 7);
    expect(body.ttl_days).toBe(7);
    expect(env.SHARES._putOptions.get(shareKey(body.slug))?.expirationTtl).toBe(
      7 * 86400,
    );
  });

  it("clamps an over-long lifetime instead of refusing", async () => {
    const env = makeEnv();
    const body = await share(env, 3650);
    expect(body.ttl_days).toBe(MAX_TTL_DAYS);
  });

  it("refuses an empty document", async () => {
    const env = makeEnv();
    const res = await worker.fetch(putReq("   "), env, ctx);
    expect(res.status).toBe(400);
    expect(env.SHARES._store.size).toBe(0);
  });

  it("refuses a document past the KV value limit", async () => {
    // A wishlist embeds its images as data URIs, so this is reached by a big
    // list rather than by an attack — it needs a legible status, not a
    // failed put.
    const env = makeEnv();
    const res = await worker.fetch(
      putReq("x".repeat(MAX_SHARE_BYTES + 1)),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
    expect(env.SHARES._store.size).toBe(0);
  });

  it("gives every share its own slug", async () => {
    const env = makeEnv();
    const a = await share(env);
    const b = await share(env);
    expect(a.slug).not.toBe(b.slug);
    expect(env.SHARES._store.size).toBe(2);
  });
});

describe("GET /w/:slug", () => {
  it("serves the document to anyone with the link", async () => {
    const env = makeEnv();
    const { slug } = await share(env);
    const res = await worker.fetch(
      new Request(`https://w.test/w/${slug}`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(DOC);
  });

  it("tells crawlers not to index it", async () => {
    // A link pasted into a public channel must not become a permanent
    // search result for someone's personal wishlist.
    const env = makeEnv();
    const { slug } = await share(env);
    const res = await worker.fetch(
      new Request(`https://w.test/w/${slug}`),
      env,
      ctx,
    );
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
  });

  it("needs no credentials", async () => {
    const env = makeEnv({ APP_SHARED_SECRET: "" });
    const kv = makeEnv().SHARES;
    await kv.put(shareKey("a".repeat(22)), DOC);
    const res = await worker.fetch(
      new Request(`https://w.test/w/${"a".repeat(22)}`),
      { ...env, SHARES: kv },
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("404s an unknown, revoked or expired slug identically", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://w.test/w/${"b".repeat(22)}`),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/isn't available/);
  });

  it("404s a malformed slug without touching KV", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://w.test/w/../api/share"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/share/:slug", () => {
  it("revokes a live share", async () => {
    const env = makeEnv();
    const { slug } = await share(env);
    const res = await worker.fetch(
      new Request(`https://w.test/api/share/${slug}`, {
        method: "DELETE",
        headers: { authorization: "Bearer shared-secret" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(env.SHARES._store.size).toBe(0);

    const after = await worker.fetch(
      new Request(`https://w.test/w/${slug}`),
      env,
      ctx,
    );
    expect(after.status).toBe(404);
  });

  it("rejects an unauthenticated revoke", async () => {
    const env = makeEnv();
    const { slug } = await share(env);
    const res = await worker.fetch(
      new Request(`https://w.test/api/share/${slug}`, { method: "DELETE" }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(env.SHARES._store.size).toBe(1);
  });

  it("succeeds when the share is already gone", async () => {
    // Revoke is "make this link stop working". It already doesn't.
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://w.test/api/share/${"c".repeat(22)}`, {
        method: "DELETE",
        headers: { authorization: "Bearer shared-secret" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
  });

  it("rejects a malformed slug", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://w.test/api/share/nope", {
        method: "DELETE",
        headers: { authorization: "Bearer shared-secret" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
