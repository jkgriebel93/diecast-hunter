// The viewer entry contract (DCH-64): the `viewer` query param either names
// a real view or the window renders the normal app. Null is the safe answer
// for everything else — a stale shortcut must not produce a blank window.
import { describe, expect, it } from "vitest";
import { photoUrlFromSearch, viewerViewFromSearch } from "./viewer";

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

describe("photoUrlFromSearch", () => {
  it("returns web and data image urls, decoded", () => {
    expect(
      photoUrlFromSearch(
        "?photo=https%3A%2F%2Fi.ebayimg.com%2Fimages%2Fg%2Fabc%2Fs-l1600.jpg",
      ),
    ).toBe("https://i.ebayimg.com/images/g/abc/s-l1600.jpg");
    expect(
      photoUrlFromSearch(
        "?photo=data%3Aimage%2Fsvg%2Bxml%3Butf8%2C%3Csvg%2F%3E",
      ),
    ).toBe("data:image/svg+xml;utf8,<svg/>");
  });

  it("refuses anything that isn't an image url — it becomes an img src", () => {
    expect(photoUrlFromSearch("")).toBeNull();
    expect(photoUrlFromSearch("?photo=")).toBeNull();
    expect(photoUrlFromSearch("?photo=javascript%3Aalert(1)")).toBeNull();
    expect(
      photoUrlFromSearch("?photo=file%3A%2F%2F%2Fetc%2Fpasswd"),
    ).toBeNull();
    expect(
      photoUrlFromSearch("?photo=data%3Atext%2Fhtml%2C%3Cscript%3E"),
    ).toBeNull();
  });
});
