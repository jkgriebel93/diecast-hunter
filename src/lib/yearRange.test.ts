import { describe, expect, it } from "vitest";
import {
  EMPTY_YEAR_RANGE,
  describeRange,
  inYearRange,
  isEmptyRange,
  normalizeRange,
  parseYear,
  yearsInRange,
} from "./yearRange";

const range = (from: number | null, to: number | null) => ({ from, to });

describe("parseYear", () => {
  it("accepts plausible years as strings or numbers", () => {
    expect(parseYear("1998")).toBe(1998);
    expect(parseYear(2003)).toBe(2003);
    expect(parseYear("1948")).toBe(1948);
  });

  it("treats blanks as no bound", () => {
    expect(parseYear("")).toBeNull();
    expect(parseYear(null)).toBeNull();
    expect(parseYear(undefined)).toBeNull();
  });

  it("rejects garbage rather than letting it become a bound", () => {
    expect(parseYear("Any")).toBeNull();
    expect(parseYear("nineteen ninety")).toBeNull();
    // Pre-NASCAR and absurd values are not real registry years.
    expect(parseYear("1200")).toBeNull();
    expect(parseYear("99999")).toBeNull();
  });
});

describe("normalizeRange", () => {
  it("swaps inverted bounds instead of yielding an empty result", () => {
    expect(normalizeRange(range(2003, 1998))).toEqual(range(1998, 2003));
  });

  it("leaves ordered and open-ended ranges alone", () => {
    expect(normalizeRange(range(1998, 2003))).toEqual(range(1998, 2003));
    expect(normalizeRange(range(1998, null))).toEqual(range(1998, null));
    expect(normalizeRange(range(null, 2003))).toEqual(range(null, 2003));
  });
});

describe("isEmptyRange", () => {
  it("is true only when neither bound is set", () => {
    expect(isEmptyRange(EMPTY_YEAR_RANGE)).toBe(true);
    expect(isEmptyRange(range(1998, null))).toBe(false);
    expect(isEmptyRange(range(null, 2003))).toBe(false);
  });
});

describe("inYearRange", () => {
  it("includes both endpoints", () => {
    expect(inYearRange(1998, range(1998, 2003))).toBe(true);
    expect(inYearRange(2003, range(1998, 2003))).toBe(true);
    expect(inYearRange(2000, range(1998, 2003))).toBe(true);
  });

  it("excludes years outside the bounds", () => {
    expect(inYearRange(1997, range(1998, 2003))).toBe(false);
    expect(inYearRange(2004, range(1998, 2003))).toBe(false);
  });

  it("handles one-sided ranges", () => {
    expect(inYearRange(2010, range(1998, null))).toBe(true);
    expect(inYearRange(1990, range(1998, null))).toBe(false);
    expect(inYearRange(1990, range(null, 2003))).toBe(true);
    expect(inYearRange(2010, range(null, 2003))).toBe(false);
  });

  it("applies the inverted-bounds swap", () => {
    expect(inYearRange(2000, range(2003, 1998))).toBe(true);
  });

  it("passes everything through when no bound is set", () => {
    expect(inYearRange(1998, EMPTY_YEAR_RANGE)).toBe(true);
    expect(inYearRange(null, EMPTY_YEAR_RANGE)).toBe(true);
  });

  it("drops undated rows once a bound exists", () => {
    // A row we can't date isn't evidence it belongs in 1998-2003.
    expect(inYearRange(null, range(1998, 2003))).toBe(false);
    expect(inYearRange(undefined, range(1998, null))).toBe(false);
  });
});

describe("yearsInRange", () => {
  // Newest-first, the order the year dropdowns already use.
  const options = [
    "2005",
    "2004",
    "2003",
    "2002",
    "2001",
    "2000",
    "1999",
    "1998",
    "1997",
  ];

  it("expands a range to the options inside it, preserving their order", () => {
    expect(yearsInRange(options, range(1998, 2003))).toEqual([
      "2003",
      "2002",
      "2001",
      "2000",
      "1999",
      "1998",
    ]);
  });

  it("returns nothing for an inactive range so callers see 'no filter'", () => {
    expect(yearsInRange(options, EMPTY_YEAR_RANGE)).toEqual([]);
  });

  it("only emits years the source actually offers", () => {
    // 1995-1997 overlaps the option list at exactly one year.
    expect(yearsInRange(options, range(1995, 1997))).toEqual(["1997"]);
    // A range past the end of the list yields nothing rather than inventing
    // years the search would never match.
    expect(yearsInRange(options, range(2010, 2015))).toEqual([]);
  });

  it("handles one-sided ranges", () => {
    expect(yearsInRange(options, range(2004, null))).toEqual(["2005", "2004"]);
    expect(yearsInRange(options, range(null, 1998))).toEqual(["1998", "1997"]);
  });

  it("ignores non-numeric options rather than passing them through", () => {
    expect(yearsInRange(["Any", "2001", ""], range(2000, 2002))).toEqual([
      "2001",
    ]);
  });
});

describe("describeRange", () => {
  it("renders each shape of range", () => {
    expect(describeRange(range(1998, 2003))).toBe("1998–2003");
    expect(describeRange(range(1998, null))).toBe("1998 or later");
    expect(describeRange(range(null, 2003))).toBe("up to 2003");
    expect(describeRange(range(2001, 2001))).toBe("2001");
    expect(describeRange(EMPTY_YEAR_RANGE)).toBeNull();
  });

  it("describes inverted bounds the way they will actually filter", () => {
    expect(describeRange(range(2003, 1998))).toBe("1998–2003");
  });
});
