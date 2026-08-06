import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEnvelope,
  buildEvent,
  parseDsn,
  reportInsertFailure,
} from "../src/sentry";

const DSN = "https://abc123def456@o4507000.ingest.us.sentry.io/4509999";
const NOW = 1_800_000_000_000;

const details = {
  notificationId: "notif-abc",
  attempts: 3,
  error: "D1_ERROR: no such table: marketplace_deletions",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDsn", () => {
  it("derives the envelope endpoint and key from a real DSN", () => {
    expect(parseDsn(DSN)).toEqual({
      envelopeUrl: "https://o4507000.ingest.us.sentry.io/api/4509999/envelope/",
      publicKey: "abc123def456",
    });
  });

  it("returns null rather than throwing on anything unusable", () => {
    // A malformed secret must disable reporting, not break the endpoint
    // eBay depends on.
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn("")).toBeNull();
    expect(parseDsn("not-a-url")).toBeNull();
    // No public key.
    expect(parseDsn("https://o4507000.ingest.us.sentry.io/4509999")).toBeNull();
    // No project id.
    expect(parseDsn("https://abc123@o4507000.ingest.us.sentry.io")).toBeNull();
  });
});

describe("buildEvent", () => {
  it("carries what you need to act on a lost notification", () => {
    const event = buildEvent(details, NOW, "f".repeat(32));
    expect(event.event_id).toBe("f".repeat(32));
    expect(event.level).toBe("error");
    expect(event.timestamp).toBe(NOW / 1000);

    // The notification id is the whole point: it's what you search eBay's
    // side for to find the record we told them we had.
    expect(event.extra).toEqual({
      notification_id: "notif-abc",
      attempts: 3,
      error: details.error,
    });
    expect((event.tags as Record<string, string>).event).toBe(
      "deletion_insert_failed",
    );

    const exception = event.exception as {
      values: { type: string; value: string }[];
    };
    expect(exception.values[0].type).toBe("DeletionInsertFailed");
    expect(exception.values[0].value).toContain("notif-abc");
    expect(exception.values[0].value).toContain("after 3 attempts");
  });

  it("fingerprints every occurrence into one issue", () => {
    // D1 error text varies; without a fixed fingerprint each variation would
    // open its own Sentry issue and the alert history would be unreadable.
    const a = buildEvent(details, NOW);
    const b = buildEvent(
      { ...details, error: "D1_ERROR: network", notificationId: "other" },
      NOW,
    );
    expect(a.fingerprint).toEqual(b.fingerprint);
  });

  it("gives each event its own id", () => {
    expect(buildEvent(details, NOW).event_id).not.toBe(
      buildEvent(details, NOW).event_id,
    );
    expect(buildEvent(details, NOW).event_id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("buildEnvelope", () => {
  it("emits the three newline-delimited parts Sentry expects", () => {
    const event = buildEvent(details, NOW, "a".repeat(32));
    const lines = buildEnvelope(event, "2027-01-15T00:00:00.000Z")
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({
      event_id: "a".repeat(32),
      sent_at: "2027-01-15T00:00:00.000Z",
    });
    expect(JSON.parse(lines[1])).toEqual({ type: "event" });
    expect(JSON.parse(lines[2]).event_id).toBe("a".repeat(32));
  });
});

describe("reportInsertFailure", () => {
  it("posts an envelope to the DSN's ingest endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    expect(await reportInsertFailure(DSN, details, NOW)).toBe("sent");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://o4507000.ingest.us.sentry.io/api/4509999/envelope/",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-sentry-envelope");
    expect(headers["X-Sentry-Auth"]).toContain("sentry_key=abc123def456");
    expect(headers["X-Sentry-Auth"]).toContain("sentry_version=7");
    expect(String(init.body)).toContain("notif-abc");
  });

  it("does nothing at all when SENTRY_DSN is unset", async () => {
    // The secret is optional by design: an unconfigured worker must behave
    // exactly as it did before reporting existed.
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await reportInsertFailure(undefined, details, NOW)).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a rejected send", async () => {
    // The alerting path failing must never become an unhandled rejection in
    // the middle of the compliance endpoint.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reportInsertFailure(DSN, details, NOW)).resolves.toBe(
      "failed",
    );
  });

  it("swallows a non-2xx from Sentry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reportInsertFailure(DSN, details, NOW)).toBe("failed");
    expect(errorLog).toHaveBeenCalledOnce();
    expect(String(errorLog.mock.calls[0][0])).toContain("sentry_report_failed");
  });
});
