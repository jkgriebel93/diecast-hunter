// The pure half of the image carousel (DCH-52, shared by DCH-75): which
// image set a thumbnail cycles through, and how the index steps. Split out
// of the component so the wrap-around and fallback rules are unit-testable.

/** Step a carousel index by `delta`, wrapping in both directions. A count
 *  of zero has nothing to step through and pins the index at 0. */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** The image set a card's thumbnail shows. The full set only applies while
 *  the photos are open AND the detail actually carried images — a detail
 *  with an empty set falls back to the one known image rather than
 *  rendering an empty frame. No fallback either → empty, and the caller's
 *  Thumbnail shows its placeholder. */
export function visibleImages(
  open: boolean,
  detailUrls: string[] | undefined,
  fallbackUrl: string | null,
): string[] {
  if (open && detailUrls && detailUrls.length > 0) return detailUrls;
  return fallbackUrl ? [fallbackUrl] : [];
}
