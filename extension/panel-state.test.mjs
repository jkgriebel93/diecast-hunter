// The pure half of DCH-70: the default-minimized fold and the pill's
// summary line. The module is a classic script (content scripts can't use
// `export`), so importing it for its side effect and reading `globalThis`
// is the contract, same as the browser's.
import { describe, expect, it } from "vitest";
import "./panel-state.js";

const { MINIMIZED_KEY, initialMinimized, pillSummary } =
  globalThis.dhPanelState;

describe("initialMinimized", () => {
  it("defaults to minimized when no choice is stored", () => {
    // A fresh install, and any install upgrading from pre-0.3.0 storage.
    expect(initialMinimized(undefined)).toBe(true);
    expect(initialMinimized(null)).toBe(true);
  });

  it("honors the last explicit choice in both directions", () => {
    expect(initialMinimized(false)).toBe(false);
    expect(initialMinimized(true)).toBe(true);
  });

  it("stores under a stable key", () => {
    // Renaming the key would silently reset every user to the default.
    expect(MINIMIZED_KEY).toBe("panelMinimized");
  });
});

describe("pillSummary", () => {
  const preview = (overrides = {}) => ({
    entry: { registry_entry_id: 1 },
    matched: true,
    confidence: 92.4,
    deal_score: 61.2,
    comp_score: null,
    ...overrides,
  });

  it("leads with match quality, rounded", () => {
    expect(pillSummary(preview({ deal_score: null }))).toBe("match 92%");
    expect(pillSummary(preview({ matched: false, deal_score: null }))).toBe(
      "guess 92%",
    );
  });

  it("prefers sold comps over retail as the price signal", () => {
    // Comps are evidence of actual sales; retail is a catalog number.
    expect(pillSummary(preview({ comp_score: 84.6 }))).toBe(
      "match 92% · 85% of sold",
    );
    expect(pillSummary(preview())).toBe("match 92% · 61% of retail");
  });

  it("shows an em dash for a missing confidence", () => {
    expect(pillSummary(preview({ confidence: null, deal_score: null }))).toBe(
      "match —",
    );
  });

  it("returns empty for anything that isn't a usable preview", () => {
    expect(pillSummary(null)).toBe("");
    expect(pillSummary({ skipped_reason: "not diecast" })).toBe("");
  });
});
