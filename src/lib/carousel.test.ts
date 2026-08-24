// The carousel contract (DCH-75): wrap-around stepping in both directions,
// and the empty-frame rule — a detail without images must never replace the
// one image we do have with nothing.
import { describe, expect, it } from "vitest";
import { stepIndex, visibleImages } from "./carousel";

describe("stepIndex", () => {
  it("wraps forward and backward", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  it("pins to 0 when there is nothing to step through", () => {
    expect(stepIndex(5, 1, 0)).toBe(0);
    expect(stepIndex(5, -1, 0)).toBe(0);
  });

  it("normalizes an index that outgrew a shrunken set", () => {
    // The set can shrink under a live index (detail replaced by fallback).
    expect(stepIndex(5, 1, 3)).toBe(0);
  });
});

describe("visibleImages", () => {
  const detail = ["a.jpg", "b.jpg", "c.jpg"];

  it("shows the full set while open", () => {
    expect(visibleImages(true, detail, "one.jpg")).toEqual(detail);
  });

  it("shows only the known image while closed", () => {
    expect(visibleImages(false, detail, "one.jpg")).toEqual(["one.jpg"]);
  });

  it("falls back when the detail carried no images", () => {
    expect(visibleImages(true, [], "one.jpg")).toEqual(["one.jpg"]);
    expect(visibleImages(true, undefined, "one.jpg")).toEqual(["one.jpg"]);
  });

  it("is empty with nothing at all — placeholder, not a broken frame", () => {
    expect(visibleImages(true, [], null)).toEqual([]);
    expect(visibleImages(false, undefined, null)).toEqual([]);
  });
});
