import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_DAYS,
  TTL_OPTIONS,
  defaultShareLabel,
  describeExpiry,
} from "./shareLinks";

const DAY = 86_400;
const NOW = 1_754_000_000;

describe("defaultShareLabel", () => {
  it("names the share by count and date", () => {
    // Locale-formatted, so this asserts the shape rather than the exact
    // month spelling — the runner's locale isn't the user's.
    const label = defaultShareLabel(5, new Date(NOW * 1000));
    expect(label.startsWith("5 listings — ")).toBe(true);
    expect(label.length).toBeGreaterThan("5 listings — ".length);
  });

  it("agrees with itself about singular and plural", () => {
    expect(
      defaultShareLabel(1, new Date(NOW * 1000)).startsWith("1 listing —"),
    ).toBe(true);
  });

  it("distinguishes two shares of the same size", () => {
    // The reason the date is in the default at all: "5 listings" twice is
    // two rows nobody can tell apart in the Settings list.
    const a = defaultShareLabel(5, new Date(NOW * 1000));
    const b = defaultShareLabel(5, new Date((NOW + DAY * 40) * 1000));
    expect(a).not.toEqual(b);
  });
});

describe("describeExpiry", () => {
  it("counts down in days while there is time", () => {
    expect(describeExpiry(NOW + DAY * 12, NOW)).toEqual({
      text: "expires in 12 days",
      expired: false,
    });
    expect(describeExpiry(NOW + DAY * 1.5, NOW).text).toBe("expires in 1 day");
  });

  it("drops to hours on the last day", () => {
    expect(describeExpiry(NOW + 3_600 * 5, NOW).text).toBe(
      "expires in 5 hours",
    );
    expect(describeExpiry(NOW + 3_600, NOW).text).toBe("expires in 1 hour");
  });

  it("does not claim minute precision it doesn't have", () => {
    // The shared page is edge-cached for five minutes, so a minute countdown
    // would be more exact than the thing it describes.
    expect(describeExpiry(NOW + 90, NOW).text).toBe("expires within the hour");
  });

  it("marks a lapsed share expired rather than rendering a past date", () => {
    // Expired rows stay in the list — that is how the user finds out the
    // link is dead, instead of hearing it from the recipient.
    expect(describeExpiry(NOW - 1, NOW)).toEqual({
      text: "expired",
      expired: true,
    });
  });

  it("says unknown rather than never for a missing expiry", () => {
    // A null TTL is the Worker not reporting one, which is not a promise
    // that the link lives forever.
    expect(describeExpiry(null, NOW)).toEqual({
      text: "expiry unknown",
      expired: false,
    });
  });
});

describe("TTL options", () => {
  it("offers nothing the Worker would clamp", () => {
    // worker/src/share.ts caps at MAX_TTL_DAYS = 90; offering 180 here would
    // be a promise the Worker silently breaks.
    expect(Math.max(...TTL_OPTIONS.map((o) => o.days))).toBeLessThanOrEqual(90);
    expect(TTL_OPTIONS.every((o) => o.days > 0)).toBe(true);
  });

  it("defaults to one of the options it offers", () => {
    expect(TTL_OPTIONS.some((o) => o.days === DEFAULT_TTL_DAYS)).toBe(true);
  });
});
