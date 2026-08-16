import { describe, expect, it } from "vitest";
import { DCR_BASE, resolveDcrUrl } from "./dcr";
import { resolveImageSrc } from "./imageUrl";

describe("resolveDcrUrl", () => {
  it("passes an absolute URL through untouched", () => {
    const u = "https://i.ebayimg.com/images/g/abc/s-l500.jpg";
    expect(resolveDcrUrl(u)).toBe(u);
  });

  it("puts DCR's origin in front of a site-relative path", () => {
    expect(resolveDcrUrl("/img/thumb.jpg")).toBe(`${DCR_BASE}/img/thumb.jpg`);
  });

  it("adds the missing slash rather than gluing onto the origin", () => {
    expect(resolveDcrUrl("img/thumb.jpg")).toBe(`${DCR_BASE}/img/thumb.jpg`);
  });

  it("gives a protocol-relative URL a scheme instead of a DCR prefix", () => {
    // The old `startsWith("http")` test failed here and produced
    // `https://www.diecastregistry.com//cdn.example.com/x.jpg`.
    expect(resolveDcrUrl("//cdn.example.com/x.jpg")).toBe(
      "https://cdn.example.com/x.jpg",
    );
  });

  it("leaves a converted local-file URL alone", () => {
    // What convertFileSrc returns for an attached photo on Windows.
    const u = "http://asset.localhost/C%3A%5Cphotos%5Ccar.jpg";
    expect(resolveDcrUrl(u)).toBe(u);
    expect(resolveDcrUrl("asset://localhost/car.jpg")).toBe(
      "asset://localhost/car.jpg",
    );
  });
});

describe("resolveImageSrc", () => {
  it("resolves the same way a page link does", () => {
    expect(resolveImageSrc("/img/thumb.jpg")).toBe(`${DCR_BASE}/img/thumb.jpg`);
  });

  it("treats nothing-in-particular as no image", () => {
    // An empty src resolves to the page itself and paints a broken icon, so
    // it has to become null rather than reach an <img>. This is the one rule
    // an image needs that a link doesn't.
    expect(resolveImageSrc(null)).toBeNull();
    expect(resolveImageSrc(undefined)).toBeNull();
    expect(resolveImageSrc("")).toBeNull();
    expect(resolveImageSrc("   ")).toBeNull();
  });
});
