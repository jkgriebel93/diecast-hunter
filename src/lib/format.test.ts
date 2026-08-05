import { describe, expect, it } from "vitest";
import { formatAgo, formatCents, formatCount } from "./format";

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
