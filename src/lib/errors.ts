/** Turns whatever a failed `invoke()` (or a stray JS throw) hands us into
 *  something worth showing a person.
 *
 *  Backend errors arrive as the `Display` form of Rust's `AppError` — e.g.
 *  `"network error: ebay api https://… returned 401: {…}"` — because
 *  `AppError` serializes via `to_string()`. That string is precise and
 *  useless: it names the failure mode in our vocabulary, not the user's,
 *  and buries the one actionable fact ("reconnect eBay") inside a wall of
 *  JSON. `describeError` splits it into a plain-language `title`, an
 *  optional `hint` naming the fix, and the original text as `detail` for
 *  the disclosure triangle.
 *
 *  Kept free of Tauri imports so it's unit-testable outside the app shell.
 */

export type ErrorKind =
  "network" | "auth" | "quota" | "setup" | "data" | "cancelled" | "unknown";

export interface DescribedError {
  /** One plain sentence: what happened, in the user's terms. */
  title: string;
  /** What to do about it, when there's a clear next step. */
  hint: string | null;
  /** The original message, for the "Technical details" disclosure. Null
   *  when the title already says everything the raw string did. */
  detail: string | null;
  kind: ErrorKind;
}

/** Normalize the many shapes a caught value can take into a string. */
export function errorText(e: unknown): string {
  if (e === null || e === undefined) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object") {
    const obj = e as Record<string, unknown>;
    // Tauri command rejections are plain strings, but a thrown Response or
    // a custom object may carry one of these.
    for (const key of ["message", "error", "detail"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

/** `AppError`'s `#[error("…")]` prefixes, longest first so `migration
 *  error:` can't be shadowed by a looser match. */
const PREFIXES: Array<[string, ErrorKind]> = [
  ["eBay rate limit reached:", "quota"],
  ["migration error:", "data"],
  ["database error:", "data"],
  ["network error:", "network"],
  ["keyring error:", "setup"],
  ["not configured:", "setup"],
  ["login failed:", "auth"],
  ["config error:", "setup"],
  ["parse error:", "data"],
  ["io error:", "data"],
];

interface Split {
  prefix: string | null;
  kind: ErrorKind;
  body: string;
}

function splitPrefix(raw: string): Split {
  for (const [prefix, kind] of PREFIXES) {
    if (raw.startsWith(prefix)) {
      return { prefix, kind, body: raw.slice(prefix.length).trim() };
    }
  }
  return { prefix: null, kind: "unknown", body: raw };
}

/** Host out of the first URL in a message, for "couldn't reach X". */
function hostFrom(text: string): string | null {
  const m = text.match(/https?:\/\/([^/\s"']+)/i);
  if (!m) return null;
  return m[1].replace(/^www\./, "");
}

/** First HTTP status code in an eBay/DCR error body. */
function statusFrom(text: string): number | null {
  const m = text.match(/returned (\d{3})|HTTP status[^\d]*(\d{3})|\((\d{3})\)/);
  if (!m) return null;
  const code = Number(m[1] ?? m[2] ?? m[3]);
  return Number.isFinite(code) ? code : null;
}

function sentenceCase(s: string): string {
  if (!s) return s;
  // Leave strings that already start with a capital or a known proper
  // noun alone — "eBay App ID not set" must not become "EBay …".
  if (/^[A-Z]/.test(s) || /^e[A-Z]/.test(s)) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function describeNetwork(body: string): DescribedError {
  const lower = body.toLowerCase();
  const host = hostFrom(body);
  const status = statusFrom(body);

  if (lower.includes("iaf token")) {
    return {
      title: "Your eBay sign-in has expired.",
      hint: "Reconnect your eBay account in Settings, then try again.",
      detail: body,
      kind: "auth",
    };
  }
  if (
    lower.includes("dns error") ||
    lower.includes("error sending request") ||
    lower.includes("connection refused") ||
    lower.includes("tcp connect error") ||
    lower.includes("connection reset") ||
    lower.includes("timed out")
  ) {
    return {
      title: host ? `Couldn't reach ${host}.` : "Couldn't reach the network.",
      hint: "Check your internet connection and try again.",
      detail: body,
      kind: "network",
    };
  }
  if (status === 401 || status === 403) {
    return {
      title: host
        ? `${host} rejected the request as unauthorized.`
        : "The request was rejected as unauthorized.",
      hint: "Your saved credentials or API keys may be wrong or expired — check Settings.",
      detail: body,
      kind: "auth",
    };
  }
  if (status === 404) {
    return {
      title: host
        ? `${host} says that item no longer exists.`
        : "That item no longer exists.",
      hint: "It was probably removed or ended. Nothing to fix on your end.",
      detail: body,
      kind: "data",
    };
  }
  if (status !== null && status >= 500) {
    return {
      title: host
        ? `${host} is having trouble right now (HTTP ${status}).`
        : `The service is having trouble right now (HTTP ${status}).`,
      hint: "This is on their end — try again in a few minutes.",
      detail: body,
      kind: "network",
    };
  }
  return {
    title: host
      ? `The request to ${host} failed.`
      : "A network request failed.",
    hint: null,
    detail: body,
    kind: "network",
  };
}

export function describeError(e: unknown): DescribedError {
  const raw = errorText(e).trim();
  if (!raw) {
    return {
      title: "Something went wrong.",
      hint: null,
      detail: null,
      kind: "unknown",
    };
  }

  const { prefix, kind, body } = splitPrefix(raw);

  if (raw === "operation cancelled") {
    return {
      title: "Cancelled.",
      hint: null,
      detail: null,
      kind: "cancelled",
    };
  }

  switch (prefix) {
    case "network error:":
      return describeNetwork(body);

    case "eBay rate limit reached:":
      return {
        title: "eBay's daily API quota is used up.",
        hint: "Syncing works again after the quota resets (usually within a day). Watched listings and saved data are untouched.",
        detail: body,
        kind: "quota",
      };

    case "login failed:":
      return {
        title: body.includes("anti-forgery token")
          ? "Couldn't load the diecastregistry.com sign-in page."
          : "diecastregistry.com rejected the sign-in.",
        hint: body.includes("anti-forgery token")
          ? "The site may be down or may have changed its login page."
          : "Check the username and password saved in Settings.",
        detail: body,
        kind: "auth",
      };

    case "not configured:":
      // These messages are already written for a person ("eBay RuName not
      // set — configure it in Settings first"), so they lead.
      return {
        title: sentenceCase(body) + (/[.!?]$/.test(body) ? "" : "."),
        hint: /settings/i.test(body) ? null : "Add it in Settings to continue.",
        detail: null,
        kind: "setup",
      };

    case "keyring error:":
      return {
        title: "Couldn't reach the system keychain.",
        hint: "Passwords and API tokens live there. On Windows, check that Credential Manager is available.",
        detail: body,
        kind: "setup",
      };

    case "database error:":
    case "migration error:":
      return {
        title: "Couldn't read or write the local database.",
        hint: "If this keeps happening, another copy of Diecast Hunter may be running.",
        detail: body,
        kind: "data",
      };

    case "parse error:":
      return {
        title: "The response wasn't in the expected format.",
        hint: "Usually means the site changed its page layout — the raw response is below.",
        detail: body,
        kind: "data",
      };

    case "io error:":
      return {
        title: "A file operation failed.",
        hint: null,
        detail: body,
        kind: "data",
      };

    case "config error:":
      return {
        title: sentenceCase(body) + (/[.!?]$/.test(body) ? "" : "."),
        hint: null,
        detail: null,
        kind: "setup",
      };
  }

  // Not an AppError. The one JS failure worth naming: the Tauri bridge is
  // missing, which is what you get running the frontend outside the app.
  if (raw.includes("invoke") && raw.includes("undefined")) {
    return {
      title: "The app's backend isn't available.",
      hint: "This page has to run inside the Diecast Hunter desktop app.",
      detail: raw,
      kind: "setup",
    };
  }

  return {
    title: "Something went wrong.",
    hint: null,
    detail: raw,
    kind,
  };
}
