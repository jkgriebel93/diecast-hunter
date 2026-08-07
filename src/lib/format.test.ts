import { describe, expect, it } from "vitest";
import {
  formatAgo,
  formatCents,
  formatCount,
  formatDateTime,
  formatUntil,
} from "./format";

describe("formatCents", () => {
  it("adds thousands separators", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });

  it("keeps two decimal places on round amounts", () => {
    expect(formatCents(500)).toBe("$5.00");
    expect(formatCents(1000000)).toBe("$10,000.00");
  });

  it("handles zero and negatives", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(-123456)).toBe("-$1,234.56");
  });

  it("renders missing values as an em dash", () => {
    expect(formatCents(null)).toBe("—");
  });
});

describe("formatCount", () => {
  it("separates thousands without decimals", () => {
    expect(formatCount(12500)).toBe("12,500");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(0)).toBe("0");
  });

  it("renders missing values as an em dash", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
  });
});

describe("formatAgo", () => {
  const NOW = 1_800_000_000;
  const DAY = 86400;
  const ago = (days: number) => formatAgo(NOW - days * DAY, NOW);

  it("names the last two days instead of counting them", () => {
    expect(ago(0)).toBe("today");
    expect(ago(0.5)).toBe("today");
    expect(ago(1)).toBe("yesterday");
    expect(ago(1.9)).toBe("yesterday");
  });

  it("counts days up to a fortnight, then weeks, then months", () => {
    expect(ago(3)).toBe("3 days ago");
    expect(ago(13)).toBe("13 days ago");
    expect(ago(21)).toBe("3 weeks ago");
    expect(ago(59)).toBe("8 weeks ago");
    expect(ago(90)).toBe("3 months ago");
    expect(ago(540)).toBe("18 months ago");
  });

  it("clamps a future timestamp to today rather than going negative", () => {
    // Clock skew between the eBay-reported end time and the local machine
    // shouldn't render a comp as "-1 days ago".
    expect(formatAgo(NOW + 5 * DAY, NOW)).toBe("today");
  });
});

describe("formatDateTime", () => {
  // 2026-01-23T21:05:00Z. Asserted against `toLocaleString()` on the same
  // instant rather than a literal, because the expected string depends on
  // the runner's timezone and locale — pinning it would make the test fail
  // in CI for the wrong reason.
  const TS = 1769202300;

  it("renders a stored timestamp the same way the old inline call did", () => {
    // DCH-34 replaced nineteen `new Date(x * 1000).toLocaleString()` calls
    // with this helper on the promise that nothing visibly changed.
    expect(formatDateTime(TS)).toBe(new Date(TS * 1000).toLocaleString());
  });

  it("treats the argument as seconds, not milliseconds", () => {
    expect(formatDateTime(TS)).not.toBe(new Date(TS).toLocaleString());
  });

  it("renders missing timestamps as an em dash", () => {
    // The actual bug this helper exists to prevent. The two missing cases
    // failed in *different* wrong ways inline, which is why neither was
    // obvious: `undefined` rendered the string "Invalid Date", and `null`
    // coerced to 0 and confidently rendered the Unix epoch as if it were a
    // real sync time.
    expect(formatDateTime(undefined)).toBe("—");
    expect(new Date(undefined! * 1000).toLocaleString()).toBe("Invalid Date");

    expect(formatDateTime(null)).toBe("—");
    expect(new Date(null! * 1000).getTime()).toBe(0);
  });

  it("renders unparseable values as an em dash rather than Invalid Date", () => {
    expect(formatDateTime(NaN)).toBe("—");
    expect(formatDateTime(Infinity)).toBe("—");
    // Far outside the range Date can represent (±8.64e15 ms).
    expect(formatDateTime(1e15)).toBe("—");
  });

  it("still formats the epoch, which is a real timestamp and not missing", () => {
    expect(formatDateTime(0)).toBe(new Date(0).toLocaleString());
  });
});

describe("formatUntil", () => {
  const NOW = 1769202300;
  const at = (secs: number) => formatUntil(NOW + secs, NOW);

  it("gets coarser the further out the end time is", () => {
    expect(at(30)).toBe("in under a minute");
    expect(at(60 * 20)).toBe("in 20 min");
    expect(at(3600 * 5)).toBe("in 5 hours");
    expect(at(3600)).toBe("in 1 hour");
    expect(at(86400 * 2)).toBe("in 2 days");
    expect(at(86400)).toBe("in 1 day");
    expect(at(86400 * 30)).toBe("in 4 weeks");
  });

  it("says ended rather than counting backwards", () => {
    // An auction can close while the page is open, so callers shouldn't
    // need a separate branch for it.
    expect(at(-1)).toBe("ended");
    expect(at(-86400 * 3)).toBe("ended");
    expect(at(0)).toBe("ended");
  });

  it("renders a missing end time as an em dash", () => {
    // Fixed-price listings have no end time at all.
    expect(formatUntil(null, NOW)).toBe("—");
    expect(formatUntil(undefined, NOW)).toBe("—");
  });
});
