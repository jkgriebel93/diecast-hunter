import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { handleTestAlert } from "../src/index";
import { makeEnv } from "./helpers";

const DSN = "https://key123@o1.ingest.us.sentry.io/42";

/** Minimal ExecutionContext for the top-level fetch handler. */
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function testAlertReq(auth?: string): Request {
  return new Request("https://example.test/api/test-alert", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/test-alert", () => {
  it("sends a real report through the real DSN", async () => {
    // The whole point: this is the one link unit tests can't cover, because
    // it needs a live DSN and a live Sentry.
    const env = makeEnv({ SENTRY_DSN: DSN });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    const res = await handleTestAlert(env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      notification_id: string;
    };
    expect(body.outcome).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("sentry.io");
  });

  it("marks the event unmistakably as a test", async () => {
    // It lands in the same Sentry issue as a genuine lost notification, so
    // the history has to make clear nothing was actually lost.
    const env = makeEnv({ SENTRY_DSN: DSN });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    const body = (await (await handleTestAlert(env)).json()) as {
      notification_id: string;
    };

    expect(body.notification_id).toMatch(/^TEST-DO-NOT-ACT-/);
    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).toContain(
      "TEST-DO-NOT-ACT-",
    );
  });

  it("reports skipped rather than pretending, when no DSN is configured", async () => {
    // The most likely cause of a silent alerting chain, so it gets named
    // instead of returning a cheerful 200.
    const env = makeEnv(); // no SENTRY_DSN
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await handleTestAlert(env);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when Sentry rejects the event", async () => {
    const env = makeEnv({ SENTRY_DSN: DSN });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await handleTestAlert(env);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("failed");
  });

  it("requires the shared secret", async () => {
    const env = makeEnv({ SENTRY_DSN: DSN });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    for (const auth of [undefined, "Bearer wrong", "shared-secret"]) {
      const res = await worker.fetch(testAlertReq(auth), env, ctx);
      expect(res.status).toBe(401);
    }
    // Nothing reached Sentry on any of the rejected attempts.
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("sentry.io")),
    ).toHaveLength(0);
  });

  it("is reachable through the router with the right secret", async () => {
    const env = makeEnv({ SENTRY_DSN: DSN });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );

    const res = await worker.fetch(
      testAlertReq("Bearer shared-secret"),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("sent");
  });

  it("is POST-only", async () => {
    const env = makeEnv({ SENTRY_DSN: DSN });
    const res = await worker.fetch(
      new Request("https://example.test/api/test-alert", {
        method: "GET",
        headers: { authorization: "Bearer shared-secret" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("writes nothing to D1", async () => {
    // A test alert must not leave a row that looks like a real deletion.
    const env = makeEnv({ SENTRY_DSN: DSN });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    await handleTestAlert(env);
    expect(env.DB._rows.size).toBe(0);
  });
});
