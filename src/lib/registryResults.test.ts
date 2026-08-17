// The pure half of DCH-59: the page now defers, bounds and memoizes the
// results render, and these tests are what pin the numbers and ordering to
// the pre-refactor behavior — including the "registry" no-axis mode, which
// must return the input array itself, untouched and unresorted.

import { describe, expect, it } from "vitest";
import type { ProductionSearchResult } from "@/lib/tauri";
import {
  filterRegistryResults,
  inRange,
  parseDollars,
  sortRegistryResults,
  type RegistryResultFilterInputs,
} from "./registryResults";

let nextGuid = 1;
function mkResult(
  overrides: Partial<ProductionSearchResult> = {},
): ProductionSearchResult {
  return {
    registry_guid: `guid-${nextGuid++}`,
    detail_url: null,
    image_url: null,
    driver_name: "Jeff Gordon",
    driver_normalized: "jeff-gordon",
    year: 2002,
    oem: "Action / Lionel",
    brand: "ARC",
    scale: "1:24",
    make: "CWC",
    scheme_text: "#24 DuPont",
    seq_produced_total: 5004,
    retail_value_cents: 8800,
    wholesale_value_cents: 2700,
    ...overrides,
  };
}

function inputs(
  overrides: Partial<RegistryResultFilterInputs> = {},
): RegistryResultFilterInputs {
  return {
    q: "",
    retailMin: "",
    retailMax: "",
    wholesaleMin: "",
    wholesaleMax: "",
    ...overrides,
  };
}

describe("parseDollars", () => {
  it("parses plain and $-prefixed amounts into cents", () => {
    expect(parseDollars("25")).toBe(2500);
    expect(parseDollars("$12.50")).toBe(1250);
    expect(parseDollars(" 8 ")).toBe(800);
  });

  it("treats blanks and garbage as no bound", () => {
    expect(parseDollars("")).toBeNull();
    expect(parseDollars("  ")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
  });
});

describe("inRange", () => {
  it("passes null values only while no bound is set", () => {
    expect(inRange(null, null, null)).toBe(true);
    expect(inRange(null, 100, null)).toBe(false);
    expect(inRange(null, null, 100)).toBe(false);
  });

  it("applies bounds inclusively", () => {
    expect(inRange(100, 100, 200)).toBe(true);
    expect(inRange(200, 100, 200)).toBe(true);
    expect(inRange(99, 100, null)).toBe(false);
    expect(inRange(201, null, 200)).toBe(false);
  });
});

describe("filterRegistryResults", () => {
  it("returns the input array itself when nothing narrows", () => {
    nextGuid = 1;
    const results = [mkResult(), mkResult()];
    expect(filterRegistryResults(results, inputs())).toBe(results);
  });

  it("matches text across driver, scheme, attributes and year", () => {
    nextGuid = 1;
    const gordon = mkResult();
    const labonte = mkResult({
      driver_name: "Terry Labonte",
      scheme_text: "#5 Kellogg's",
      year: 1998,
      brand: "Elite",
    });
    const results = [gordon, labonte];
    expect(filterRegistryResults(results, inputs({ q: "labonte" }))).toEqual([
      labonte,
    ]);
    expect(filterRegistryResults(results, inputs({ q: "dupont" }))).toEqual([
      gordon,
    ]);
    expect(filterRegistryResults(results, inputs({ q: "1998" }))).toEqual([
      labonte,
    ]);
    expect(filterRegistryResults(results, inputs({ q: "elite" }))).toEqual([
      labonte,
    ]);
    expect(filterRegistryResults(results, inputs({ q: "ZZZ" }))).toEqual([]);
  });

  it("applies retail and wholesale bounds, excluding unvalued rows", () => {
    nextGuid = 1;
    const cheap = mkResult({ retail_value_cents: 2000 });
    const dear = mkResult({ retail_value_cents: 20000 });
    const unvalued = mkResult({ retail_value_cents: null });
    const results = [cheap, dear, unvalued];
    expect(filterRegistryResults(results, inputs({ retailMin: "50" }))).toEqual(
      [dear],
    );
    expect(
      filterRegistryResults(results, inputs({ retailMax: "$50" })),
    ).toEqual([cheap]);
  });
});

describe("sortRegistryResults", () => {
  it("registry mode returns the input array itself, order untouched", () => {
    nextGuid = 1;
    const results = [
      mkResult({ year: 1999 }),
      mkResult({ year: 2024 }),
      mkResult({ year: null }),
    ];
    const sorted = sortRegistryResults(results, "registry");
    expect(sorted).toBe(results);
    expect(sorted.map((r) => r.year)).toEqual([1999, 2024, null]);
  });

  it("driver-asc sorts by name then newest year, without mutating input", () => {
    nextGuid = 1;
    const results = [
      mkResult({ driver_name: "Terry Labonte", year: 1998 }),
      mkResult({ driver_name: "Jeff Gordon", year: 1998 }),
      mkResult({ driver_name: "Jeff Gordon", year: 2002 }),
    ];
    const before = [...results];
    const sorted = sortRegistryResults(results, "driver-asc");
    expect(sorted.map((r) => `${r.driver_name} ${r.year}`)).toEqual([
      "Jeff Gordon 2002",
      "Jeff Gordon 1998",
      "Terry Labonte 1998",
    ]);
    expect(results).toEqual(before);
  });

  // Pinned quirk, not an endorsement: the descending modes swap the
  // comparator's arguments, which flips `nullsLast` into nulls-FIRST. This
  // is the behavior the page has always shipped (the Listings sorts share
  // the pattern), and DCH-59's contract is that sorting is unchanged — a
  // deliberate fix would be its own ticket, not a perf side effect.
  it("value and qty sorts put null last ascending, first descending", () => {
    nextGuid = 1;
    const results = [
      mkResult({ retail_value_cents: null, seq_produced_total: null }),
      mkResult({ retail_value_cents: 5000, seq_produced_total: 100 }),
      mkResult({ retail_value_cents: 1000, seq_produced_total: 9000 }),
    ];
    expect(
      sortRegistryResults(results, "retail-value-asc").map(
        (r) => r.retail_value_cents,
      ),
    ).toEqual([1000, 5000, null]);
    expect(
      sortRegistryResults(results, "retail-value-desc").map(
        (r) => r.retail_value_cents,
      ),
    ).toEqual([null, 5000, 1000]);
    expect(
      sortRegistryResults(results, "production-qty-desc").map(
        (r) => r.seq_produced_total,
      ),
    ).toEqual([null, 9000, 100]);
  });

  it("year sorts order correctly (nulls last asc, first desc)", () => {
    nextGuid = 1;
    const results = [
      mkResult({ year: null }),
      mkResult({ year: 1995 }),
      mkResult({ year: 2020 }),
    ];
    expect(
      sortRegistryResults(results, "year-desc").map((r) => r.year),
    ).toEqual([null, 2020, 1995]);
    expect(sortRegistryResults(results, "year-asc").map((r) => r.year)).toEqual(
      [1995, 2020, null],
    );
  });
});
