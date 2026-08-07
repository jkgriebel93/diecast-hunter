import { describe, expect, it } from "vitest";
import {
  isConventionalSortValue,
  isWireSort,
  sortLabel,
  sortValue,
} from "./sortOptions";

describe("sortLabel", () => {
  it("spells direction in the reader's terms, not asc/desc", () => {
    expect(sortLabel("Driver", "alpha", "asc")).toBe("Driver A → Z");
    expect(sortLabel("Driver", "alpha", "desc")).toBe("Driver Z → A");
    expect(sortLabel("Price", "numeric", "asc")).toBe("Price low → high");
    expect(sortLabel("Price", "numeric", "desc")).toBe("Price high → low");
    expect(sortLabel("Year", "chronological", "asc")).toBe(
      "Year oldest → newest",
    );
    expect(sortLabel("Year", "chronological", "desc")).toBe(
      "Year newest → oldest",
    );
  });

  it("keeps the arrow idiom the three screens already agreed on", () => {
    // `high → low` was the one thing consistent before DCH-35, so every
    // label is built around the same arrow rather than a new invention.
    for (const kind of ["alpha", "numeric", "chronological"] as const) {
      expect(sortLabel("X", kind, "asc")).toContain(" → ");
      expect(sortLabel("X", kind, "desc")).toContain(" → ");
    }
  });

  it("reverses the endpoints rather than relabelling them", () => {
    // "Year newest → oldest" and "Year oldest → newest" must be each
    // other's mirror; a label that reads the same both ways is a bug.
    expect(sortLabel("Year", "chronological", "asc")).not.toBe(
      sortLabel("Year", "chronological", "desc"),
    );
  });
});

describe("sortValue", () => {
  it("builds field-direction values", () => {
    expect(sortValue("year", "desc")).toBe("year-desc");
    expect(sortValue("driver", "asc")).toBe("driver-asc");
  });

  it("kebab-cases multi-word fields so values stay greppable", () => {
    expect(sortValue("Retail value", "asc")).toBe("retail-value-asc");
    expect(sortValue("Production qty", "desc")).toBe("production-qty-desc");
  });
});

describe("isConventionalSortValue", () => {
  it("accepts field-asc / field-desc", () => {
    expect(isConventionalSortValue("year-desc")).toBe(true);
    expect(isConventionalSortValue("retail-value-asc")).toBe(true);
  });

  it("rejects the bare and parenthesised forms the audit found", () => {
    // Registry's `driver` and Listings' `name`: no direction at all, so two
    // screens could disagree about which way they sorted.
    expect(isConventionalSortValue("driver")).toBe(false);
    expect(isConventionalSortValue("name")).toBe(false);
    expect(isConventionalSortValue("newest")).toBe(false);
  });

  it("exempts orderings that have no direction", () => {
    // The registry's own ordering isn't ascending or descending anything;
    // `registry-asc` would imply an axis that doesn't exist.
    expect(isConventionalSortValue("registry")).toBe(true);
  });

  it("exempts eBay's wire values", () => {
    // These go to the Browse API verbatim and Saved searches persists them
    // in SQLite. Renaming would break the request and every saved row.
    for (const v of ["", "price", "-price", "newlyListed", "endingSoonest"]) {
      expect(isWireSort(v)).toBe(true);
      expect(isConventionalSortValue(v)).toBe(true);
    }
  });
});
