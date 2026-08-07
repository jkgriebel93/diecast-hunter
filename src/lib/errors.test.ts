import { describe, expect, it } from "vitest";
import { describeError, errorText } from "./errors";

describe("errorText", () => {
  it("passes strings through and unwraps Errors and objects", () => {
    expect(errorText("plain")).toBe("plain");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ message: "from message" })).toBe("from message");
    expect(errorText({ error: "from error" })).toBe("from error");
    expect(errorText(null)).toBe("");
  });
});

describe("describeError — eBay auth and quota", () => {
  it("names an expired eBay sign-in and the fix", () => {
    const d = describeError(
      "network error: trading api GetMyeBayBuying returned 401: IAF Token is invalid",
    );
    expect(d.kind).toBe("auth");
    expect(d.title).toBe("Your eBay sign-in has expired.");
    expect(d.hint).toMatch(/Reconnect your eBay account/);
    // The raw string is preserved for the disclosure, not discarded.
    expect(d.detail).toContain("IAF Token is invalid");
  });

  it("explains the daily quota without alarming the user about data", () => {
    const d = describeError(
      "eBay rate limit reached: eBay's daily API quota is used up (HTTP 429 from https://api.ebay.com/x).",
    );
    expect(d.kind).toBe("quota");
    expect(d.title).toBe("eBay's daily API quota is used up.");
    expect(d.hint).toMatch(/untouched/);
  });
});

describe("describeError — network failures", () => {
  it("reports an unreachable host by name", () => {
    const d = describeError(
      "network error: error sending request for url (https://api.ebay.com/buy/browse/v1/item): dns error",
    );
    expect(d.kind).toBe("network");
    expect(d.title).toBe("Couldn't reach api.ebay.com.");
    expect(d.hint).toMatch(/internet connection/);
  });

  it("treats a 404 as an ended listing rather than a user error", () => {
    const d = describeError(
      'network error: ebay api https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=1 returned 404 Not Found: {"errors":[{"errorId":11001}]}',
    );
    expect(d.kind).toBe("data");
    expect(d.title).toMatch(/no longer exists/);
    expect(d.hint).toMatch(/Nothing to fix/);
  });

  it("blames the service, not the user, on a 5xx", () => {
    const d = describeError(
      "network error: ebay api https://api.ebay.com/x returned 503 Service Unavailable: nope",
    );
    expect(d.title).toContain("api.ebay.com is having trouble");
    expect(d.title).toContain("503");
    expect(d.hint).toMatch(/their end/);
  });

  it("points at credentials on a 401 from an unrecognized service", () => {
    const d = describeError(
      "network error: dcr https://www.diecastregistry.com/MyGarage returned 401: denied",
    );
    expect(d.kind).toBe("auth");
    expect(d.title).toContain("diecastregistry.com");
    expect(d.hint).toMatch(/Settings/);
  });
});

describe("describeError — setup and login", () => {
  it("leads with the already-human not-configured message", () => {
    const d = describeError(
      "not configured: eBay RuName not set — configure it in Settings first",
    );
    expect(d.kind).toBe("setup");
    // Capitalization of "eBay" must survive sentence-casing.
    expect(d.title).toBe(
      "eBay RuName not set — configure it in Settings first.",
    );
    // The message already says where to go, so no duplicate hint…
    expect(d.hint).toBeNull();
    // …and there's no technical detail worth hiding.
    expect(d.detail).toBeNull();
  });

  it("adds the Settings hint when the message doesn't mention it", () => {
    const d = describeError("not configured: eBay App ID not set");
    expect(d.title).toBe("eBay App ID not set.");
    expect(d.hint).toMatch(/Settings/);
  });

  it("separates rejected DCR credentials from a broken login page", () => {
    const bad = describeError(
      "login failed: credentials rejected (still on login page)",
    );
    expect(bad.title).toBe("diecastregistry.com rejected the sign-in.");
    expect(bad.hint).toMatch(/username and password/);

    const broken = describeError(
      "login failed: could not find anti-forgery token on login page",
    );
    expect(broken.title).toMatch(/Couldn't load/);
    expect(broken.hint).toMatch(/may have changed/);
  });
});

describe("describeError — everything else", () => {
  it("treats cancellation as a non-error", () => {
    const d = describeError("operation cancelled");
    expect(d.kind).toBe("cancelled");
    expect(d.title).toBe("Cancelled.");
    expect(d.detail).toBeNull();
  });

  it("keeps database errors vague to the user but detailed underneath", () => {
    const d = describeError("database error: database is locked");
    expect(d.title).toMatch(/local database/);
    expect(d.detail).toBe("database is locked");
  });

  it("recognizes a missing Tauri bridge", () => {
    const d = describeError(
      "TypeError: Cannot read properties of undefined (reading 'invoke')",
    );
    expect(d.title).toBe("The app's backend isn't available.");
    expect(d.hint).toMatch(/desktop app/);
  });

  it("falls back without losing the original text", () => {
    const d = describeError("something completely unexpected");
    expect(d.title).toBe("Something went wrong.");
    expect(d.detail).toBe("something completely unexpected");
  });

  it("handles an empty error", () => {
    const d = describeError(null);
    expect(d.title).toBe("Something went wrong.");
    expect(d.detail).toBeNull();
  });
});

describe("constructor-name prefixes from String(e)", () => {
  // Over a hundred `catch` blocks in the app do `setError(String(e))`. When
  // the caught value is a real `Error` rather than a Tauri rejection string,
  // that glues the constructor name onto the front and every prefix in
  // PREFIXES stopped matching — a recognizable backend failure fell through
  // to "Something went wrong."
  it("classifies an AppError that came through String(e)", () => {
    const d = describeError("Error: network error: dns error: no such host");
    expect(d.title).toMatch(/Couldn't reach/);
    expect(d.kind).toBe("network");
  });

  it("strips subclass names too", () => {
    const d = describeError("TypeError: database error: disk I/O error");
    expect(d.title).toBe("Couldn't read or write the local database.");
  });

  it("keeps the untouched original in the details disclosure", () => {
    // Stripping is for matching only — the technical details should still
    // show exactly what was thrown.
    const raw = "Error: keyring error: no backend";
    expect(describeError(raw).detail).toBe("no backend");
    expect(describeError("Error: something unrecognized").detail).toBe(
      "Error: something unrecognized",
    );
  });

  it("does not eat a message that merely mentions an error", () => {
    // "Error:" has to be at the start and followed by a known prefix to do
    // anything; ordinary prose is untouched.
    const d = describeError("The importer reported: Error: bad row");
    expect(d.title).toBe("Something went wrong.");
    expect(d.detail).toBe("The importer reported: Error: bad row");
  });
});
