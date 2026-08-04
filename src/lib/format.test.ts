import { describe, expect, it } from "vitest";
import { formatCents, formatCount } from "./format";

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
