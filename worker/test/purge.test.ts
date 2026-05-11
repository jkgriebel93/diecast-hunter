import { describe, expect, it, vi } from "vitest";
import { PURGE_RETENTION_MS, purgeAckedDeletions } from "../src/index";
import { makeEnv } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

function seedRow(
  env: ReturnType<typeof makeEnv>,
  id: string,
  received_at: number,
  acked_at: number | null,
): void {
  env.DB._rows.set(id, {
    notification_id: id,
    received_at,
    acked_at,
    user_id: null,
    username: null,
    eias_token: null,
    raw: JSON.stringify({ notificationId: id, data: {} }),
  });
}

describe("purgeAckedDeletions", () => {
  it("uses a 90-day retention window", () => {
    expect(PURGE_RETENTION_MS).toBe(90 * DAY_MS);
  });

  it("returns 0 and writes no rows when the table is empty", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const deleted = await purgeAckedDeletions(env, Date.now());
    expect(deleted).toBe(0);
    expect(env.DB._rows.size).toBe(0);

    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.event).toBe("deletion_purge");
    expect(parsed.rows_deleted).toBe(0);
    expect(typeof parsed.cutoff_ms).toBe("number");
    logSpy.mockRestore();
  });

  it("deletes acked rows older than the retention cutoff, keeps everything else", async () => {
    const env = makeEnv();
    const now = 1_800_000_000_000;
    const longAgo = now - 100 * DAY_MS;
    const justInside = now - 89 * DAY_MS;
    const justOutside = now - 91 * DAY_MS;

    seedRow(env, "old-acked", longAgo, longAgo);
    seedRow(env, "fresh-acked", justInside, justInside);
    seedRow(env, "edge-acked", justOutside, justOutside);
    seedRow(env, "old-pending", longAgo, null);
    seedRow(env, "fresh-pending", justInside, null);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const deleted = await purgeAckedDeletions(env, now);

    // Only old-acked and edge-acked cross the cutoff and are acked.
    expect(deleted).toBe(2);
    expect(env.DB._rows.has("old-acked")).toBe(false);
    expect(env.DB._rows.has("edge-acked")).toBe(false);
    expect(env.DB._rows.has("fresh-acked")).toBe(true);
    expect(env.DB._rows.has("old-pending")).toBe(true); // never acked → kept
    expect(env.DB._rows.has("fresh-pending")).toBe(true);

    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.event).toBe("deletion_purge");
    expect(parsed.rows_deleted).toBe(2);
    expect(parsed.cutoff_ms).toBe(now - PURGE_RETENTION_MS);
    logSpy.mockRestore();
  });

  it("never deletes a pending row regardless of age", async () => {
    const env = makeEnv();
    const ancient = 1_500_000_000_000;
    seedRow(env, "ancient-pending", ancient, null);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const deleted = await purgeAckedDeletions(env, Date.now());
    expect(deleted).toBe(0);
    expect(env.DB._rows.has("ancient-pending")).toBe(true);
    logSpy.mockRestore();
  });

  it("propagates D1 failure so the cron run errors out instead of silently no-op'ing", async () => {
    const env = makeEnv();
    env.DB._failNextRun = true;
    await expect(purgeAckedDeletions(env, Date.now())).rejects.toThrow(
      /simulated d1 failure/,
    );
  });
});
