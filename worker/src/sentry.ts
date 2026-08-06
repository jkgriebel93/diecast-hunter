/**
 * Minimal Sentry reporter for the one event that needs to page a human
 * (DCH-30): `deletion_insert_failed`, meaning eBay handed us a marketplace
 * account deletion notification, we answered 200, and then lost it.
 *
 * # Why not the Sentry SDK
 *
 * This Worker's entire job is eBay compliance, and the deletion path is the
 * one place where a dependency failure has real cost. The SDK brings an
 * instrumentation layer, global handlers and a release-tracking story we
 * don't want anywhere near that path. Sentry's ingest API is a single POST;
 * that's all this file is.
 *
 * # Why not the Cloudflare dashboard
 *
 * Because it can't. Workers Logs stores and queries logs but has no
 * alerting, and Cloudflare Notifications alert types are threshold-shaped —
 * a single lost notification never crosses an error-rate threshold. Alerting
 * has to come from somewhere that fires on a discrete event.
 *
 * # Failure policy
 *
 * Every failure here is swallowed. A reporter that throws would turn a
 * recoverable D1 problem into an unhandled rejection in the middle of the
 * compliance endpoint, which is strictly worse than not being told about it.
 * `SENTRY_DSN` being unset is treated the same way — the Worker then behaves
 * exactly as it did before this existed.
 */

/** Give up on the POST rather than holding the invocation open. */
const SEND_TIMEOUT_MS = 5000;

/** Sent as `sentry_client`; shows up in Sentry as the reporting SDK. */
const CLIENT = "diecast-hunter-worker/1.0";

/** Groups every occurrence into one Sentry issue regardless of the D1 error
 *  text, which varies. Without this, each distinct error message would open
 *  a separate issue and the alert history would be unreadable. */
const FINGERPRINT = "deletion-insert-failed";

export interface DsnParts {
  envelopeUrl: string;
  publicKey: string;
}

/**
 * Split a Sentry DSN into the envelope endpoint and the public key.
 *
 * A DSN looks like `https://<publicKey>@<host>/<projectId>`, and the ingest
 * endpoint for it is `<scheme>//<host>/api/<projectId>/envelope/`.
 *
 * Returns null for anything unparseable rather than throwing — a malformed
 * secret should silently disable reporting, not break the endpoint that
 * eBay depends on.
 */
export function parseDsn(dsn: string | undefined): DsnParts | null {
  if (!dsn) return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const publicKey = url.username;
  const projectId = url.pathname.replace(/^\/+/, "");
  if (!publicKey || !projectId) return null;
  return {
    envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
    publicKey,
  };
}

export interface InsertFailureDetails {
  notificationId: string;
  attempts: number;
  error: string;
}

/** 32 lowercase hex characters, which is what Sentry wants for an event id
 *  — a plain UUID with the dashes taken out. */
function eventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * The Sentry event body. Exported for tests: asserting on the payload is the
 * only way to know the alert will carry enough to act on, short of reading
 * it in the Sentry UI.
 */
export function buildEvent(
  details: InsertFailureDetails,
  now: number,
  id: string = eventId(),
): Record<string, unknown> {
  return {
    event_id: id,
    timestamp: now / 1000,
    platform: "javascript",
    level: "error",
    logger: "marketplace-deletion",
    environment: "production",
    // An `exception` rather than a bare message, so the issue gets a real
    // title and Sentry treats it as an error rather than an info log.
    exception: {
      values: [
        {
          type: "DeletionInsertFailed",
          value: `Lost eBay deletion notification ${details.notificationId} after ${details.attempts} attempts: ${details.error}`,
        },
      ],
    },
    fingerprint: [FINGERPRINT],
    tags: {
      event: "deletion_insert_failed",
      notification_id: details.notificationId,
    },
    // The notification id is the thing you need to go looking for the record
    // eBay thinks we have. Everything else is for diagnosing the cause.
    extra: {
      notification_id: details.notificationId,
      attempts: details.attempts,
      error: details.error,
    },
  };
}

/** Envelopes are newline-delimited JSON: header, item header, item. */
export function buildEnvelope(
  event: Record<string, unknown>,
  sentAt: string,
): string {
  const header = JSON.stringify({ event_id: event.event_id, sent_at: sentAt });
  const itemHeader = JSON.stringify({ type: "event" });
  return `${header}\n${itemHeader}\n${JSON.stringify(event)}\n`;
}

/**
 * Report one lost notification. Resolves to whether the event was accepted,
 * which callers may ignore — the return value exists for tests and for the
 * local log line, not to drive behaviour.
 *
 * Never rejects.
 */
export async function reportInsertFailure(
  dsn: string | undefined,
  details: InsertFailureDetails,
  now: number = Date.now(),
): Promise<"sent" | "skipped" | "failed"> {
  const parsed = parseDsn(dsn);
  if (!parsed) return "skipped";

  try {
    const event = buildEvent(details, now);
    const res = await fetch(parsed.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=${CLIENT}`,
      },
      body: buildEnvelope(event, new Date(now).toISOString()),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Logged, not thrown: this is the alerting path failing, and there is
      // nothing useful to escalate it to.
      console.error(
        JSON.stringify({
          event: "sentry_report_failed",
          status: res.status,
          notification_id: details.notificationId,
        }),
      );
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "sentry_report_failed",
        error: err instanceof Error ? err.message : String(err),
        notification_id: details.notificationId,
      }),
    );
    return "failed";
  }
}
