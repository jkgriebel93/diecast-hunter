// The viewer entry contract (DCH-64): the `viewer` query param either names
// a real view or the window renders the normal app. Null is the safe answer
// for everything else — a stale shortcut must not produce a blank window.
import { describe, expect, it } from "vitest";
import { viewerViewFromSearch } from "./viewer";

describe("viewerViewFromSearch", () => {
  it("returns a valid view id", () => {
    expect(viewerViewFromSearch("?viewer=/collection")).toBe("/collection");
    expect(viewerViewFromSearch("?viewer=/ebay/feed")).toBe("/ebay/feed");
  });

  it("finds the param among others", () => {
    expect(viewerViewFromSearch("?foo=1&viewer=/registry&bar=2")).toBe(
      "/registry",
    );
  });

  it("returns null when the param is absent", () => {
    expect(viewerViewFromSearch("")).toBeNull();
    expect(viewerViewFromSearch("?foo=1")).toBeNull();
  });

  it("returns null for a view that doesn't exist", () => {
    expect(viewerViewFromSearch("?viewer=/no-such-view")).toBeNull();
    expect(viewerViewFromSearch("?viewer=collection")).toBeNull();
    expect(viewerViewFromSearch("?viewer=")).toBeNull();
  });
});
