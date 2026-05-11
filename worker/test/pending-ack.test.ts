import { describe, expect, it, vi } from "vitest";
import { handleAck, handlePending } from "../src/index";
import { makeEnv } from "./helpers";

function seed(
  env: ReturnType<typeof makeEnv>,
  rows: Array<{
    id: string;
    received_at: number;
    acked_at?: number | null;
    user_id?: string | null;
    username?: string | null;
    eias_token?: string | null;
    notification?: unknown;
  }>,
): void {
  for (const r of rows) {
    env.DB._rows.set(r.id, {
      notification_id: r.id,
      received_at: r.received_at,
      acked_at: r.acked_at ?? null,
      user_id: r.user_id ?? null,
      username: r.username ?? null,
      eias_token: r.eias_token ?? null,
      raw: JSON.stringify(
        r.notification ?? { notificationId: r.id, data: {} },
      ),
    });
    env.DELETIONS._store.set(
      `deletion:${r.id}`,
      JSON.stringify({ received_at: r.received_at, raw: {} }),
    );
  }
}

function ackReq(body: unknown): Request {
  return new Request("https://example.test/api/ack-deletions", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("handlePending", () => {
  it("returns an empty list when D1 has no unacked rows", async () => {
    const env = makeEnv();
    const res = await handlePending(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deletions: [] });
  });

  it("returns only unacked rows, ordered by received_at ascending", async () => {
    const env = makeEnv();
    seed(env, [
      { id: "newer", received_at: 3000 },
      { id: "oldest", received_at: 1000 },
      { id: "acked-old", received_at: 500, acked_at: 2500 },
      { id: "middle", received_at: 2000 },
    ]);
    const res = await handlePending(env);
    const { deletions } = (await res.json()) as { deletions: { id: string }[] };
    expect(deletions.map((d) => d.id)).toEqual(["oldest", "middle", "newer"]);
  });

  it("flattens columns into the new response shape and JSON-parses `raw`", async () => {
    const env = makeEnv();
    const payload = {
      notificationId: "n1",
      data: { username: "u", userId: "uid", eiasToken: "tok" },
    };
    seed(env, [
      {
        id: "n1",
        received_at: 1700000000000,
        user_id: "uid",
        username: "u",
        eias_token: "tok",
        notification: payload,
      },
    ]);
    const res = await handlePending(env);
    const { deletions } = (await res.json()) as {
      deletions: Array<{
        id: string;
        received_at: number;
        user_id: string | null;
        username: string | null;
        eias_token: string | null;
        notification: unknown;
      }>;
    };
    expect(deletions).toEqual([
      {
        id: "n1",
        received_at: 1700000000000,
        user_id: "uid",
        username: "u",
        eias_token: "tok",
        notification: payload,
      },
    ]);
  });

  it("falls through with the string raw and a structured log when `raw` is not JSON", async () => {
    const env = makeEnv();
    env.DB._rows.set("corrupt", {
      notification_id: "corrupt",
      received_at: 1,
      acked_at: null,
      user_id: null,
      username: null,
      eias_token: null,
      raw: "{not valid json",
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handlePending(env);
    const { deletions } = (await res.json()) as {
      deletions: Array<{ id: string; notification: unknown }>;
    };
    expect(deletions[0].notification).toBe("{not valid json");
    const parsed = JSON.parse(String(errSpy.mock.calls[0][0]));
    expect(parsed.event).toBe("deletion_raw_parse_failed");
    expect(parsed.notification_id).toBe("corrupt");
    errSpy.mockRestore();
  });
});

describe("handleAck", () => {
  it("returns 400 on invalid JSON", async () => {
    const env = makeEnv();
    const res = await handleAck(ackReq("{not json"), env);
    expect(res.status).toBe(400);
  });

  it("returns acked=0 with no-op when ids is missing or empty", async () => {
    const env = makeEnv();
    seed(env, [{ id: "x", received_at: 1 }]);
    for (const body of [{}, { ids: [] }, { ids: "nope" }]) {
      const res = await handleAck(ackReq(body), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ acked: 0 });
    }
    // Nothing should have been mutated.
    expect(env.DB._rows.get("x")!.acked_at).toBeNull();
    expect(env.DELETIONS._store.has("deletion:x")).toBe(true);
  });

  it("soft-deletes in D1 and hard-deletes from KV for matching ids", async () => {
    const env = makeEnv();
    seed(env, [
      { id: "a", received_at: 1 },
      { id: "b", received_at: 2 },
      { id: "c", received_at: 3 },
    ]);
    const res = await handleAck(ackReq({ ids: ["a", "c"] }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acked: 2 });

    expect(typeof env.DB._rows.get("a")!.acked_at).toBe("number");
    expect(env.DB._rows.get("b")!.acked_at).toBeNull();
    expect(typeof env.DB._rows.get("c")!.acked_at).toBe("number");

    expect(env.DELETIONS._store.has("deletion:a")).toBe(false);
    expect(env.DELETIONS._store.has("deletion:b")).toBe(true);
    expect(env.DELETIONS._store.has("deletion:c")).toBe(false);
  });

  it("returns changes count, not requested count, for ids that don't exist or are already acked", async () => {
    const env = makeEnv();
    seed(env, [
      { id: "fresh", received_at: 1 },
      { id: "already", received_at: 2, acked_at: 999 },
    ]);
    const res = await handleAck(
      ackReq({ ids: ["fresh", "already", "ghost"] }),
      env,
    );
    expect(res.status).toBe(200);
    // Only `fresh` flips from NULL → number.
    expect(await res.json()).toEqual({ acked: 1 });
    expect(env.DB._rows.get("already")!.acked_at).toBe(999);
  });

  it("re-acking an already-acked id is a no-op (idempotent)", async () => {
    const env = makeEnv();
    seed(env, [{ id: "a", received_at: 1 }]);

    const first = await handleAck(ackReq({ ids: ["a"] }), env);
    expect(await first.json()).toEqual({ acked: 1 });
    const firstAckedAt = env.DB._rows.get("a")!.acked_at;
    expect(typeof firstAckedAt).toBe("number");

    const second = await handleAck(ackReq({ ids: ["a"] }), env);
    expect(await second.json()).toEqual({ acked: 0 });
    // acked_at is not bumped on a re-ack.
    expect(env.DB._rows.get("a")!.acked_at).toBe(firstAckedAt);
  });

  it("ignores non-string entries in the ids array", async () => {
    const env = makeEnv();
    seed(env, [{ id: "a", received_at: 1 }]);
    const res = await handleAck(
      ackReq({ ids: ["a", 42, null, { not: "a string" }] }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acked: 1 });
  });

  it("KV delete failure does not break the ack response", async () => {
    const env = makeEnv();
    seed(env, [{ id: "a", received_at: 1 }]);
    env.DELETIONS.delete = (async () => {
      throw new Error("simulated kv delete failure");
    }) as KVNamespace["delete"];

    const res = await handleAck(ackReq({ ids: ["a"] }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acked: 1 });
    // D1 ack still landed.
    expect(typeof env.DB._rows.get("a")!.acked_at).toBe("number");
  });
});
