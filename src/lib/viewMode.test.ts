// DCH-50: the stored view mode is user-controlled text as far as the code
// is concerned — a renamed value, a typo from manual editing, or another
// page's key must fall back to the caller's default, never crash the page
// or render neither layout.
import { describe, expect, it } from "vitest";
import { resolveViewMode } from "./viewMode";

describe("resolveViewMode", () => {
  it("passes through both known modes", () => {
    expect(resolveViewMode("cards", "list")).toBe("cards");
    expect(resolveViewMode("list", "cards")).toBe("list");
  });

  it("falls back on junk, old renamed values, and missing keys", () => {
    expect(resolveViewMode(null, "cards")).toBe("cards");
    expect(resolveViewMode("", "cards")).toBe("cards");
    expect(resolveViewMode("gallery", "cards")).toBe("cards");
    expect(resolveViewMode("CARDS", "list")).toBe("list");
  });
});
