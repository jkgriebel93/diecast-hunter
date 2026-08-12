// DCH-49: the gallery grids on Browse and the Seller Feed sized every
// column at a fixed 19rem, which fits the small (6rem) image but not the
// medium (12rem) or large (18rem) ones — the image row overflowed the card.
// These tests pin the relationship between the image classes and the grid
// minimums so a future size added to one map without the other, or a
// column too narrow for its image, fails here instead of on screen.
import { describe, expect, it } from "vitest";
import { GALLERY_GRID_CLASS, IMG_CLASS } from "./imageSize";
import type { ImageSize } from "./imageSize";

const SIZES: ImageSize[] = ["sm", "md", "lg"];

/** Tailwind spacing is 0.25rem per unit, so `w-24` is 6rem. */
function imageRem(cls: string): number {
  const m = /(?:^|\s)w-(\d+)(?:\s|$)/.exec(cls);
  if (!m) throw new Error(`no width class in "${cls}"`);
  return Number(m[1]) / 4;
}

function gridMinRem(cls: string): number {
  const m = /minmax\(min\(100%,(\d+(?:\.\d+)?)rem\)/.exec(cls);
  if (!m) throw new Error(`no rem minimum in "${cls}"`);
  return Number(m[1]);
}

/** Fixed width beside the image inside a card: p-4 padding (2rem), the
 *  minimize toggle (~1rem), and the two flex gap-3 gaps (1.5rem). */
const CHROME_REM = 4.5;
/** Anything narrower and the title wraps to a word per line. */
const MIN_TEXT_REM = 8;

describe("IMG_CLASS", () => {
  it("is square at every size", () => {
    for (const size of SIZES) {
      const m = /w-(\d+) h-(\d+)/.exec(IMG_CLASS[size]);
      expect(m, IMG_CLASS[size]).not.toBeNull();
      expect(m![1]).toBe(m![2]);
    }
  });

  it("grows monotonically", () => {
    expect(imageRem(IMG_CLASS.sm)).toBeLessThan(imageRem(IMG_CLASS.md));
    expect(imageRem(IMG_CLASS.md)).toBeLessThan(imageRem(IMG_CLASS.lg));
  });
});

describe("GALLERY_GRID_CLASS", () => {
  it("leaves room for the image, card chrome, and readable text at every size", () => {
    for (const size of SIZES) {
      const column = gridMinRem(GALLERY_GRID_CLASS[size]);
      const image = imageRem(IMG_CLASS[size]);
      expect(
        column,
        `${size}: ${column}rem column < ${image}rem image + chrome + text`,
      ).toBeGreaterThanOrEqual(image + CHROME_REM + MIN_TEXT_REM);
    }
  });

  it("caps the minimum at the container width so narrow panes get one full-width column", () => {
    for (const size of SIZES) {
      expect(GALLERY_GRID_CLASS[size]).toContain("minmax(min(100%,");
    }
  });
});
