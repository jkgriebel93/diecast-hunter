import { useEffect, useState } from "react";

/** How a results screen arranges its cards (DCH-50): packed into the
 *  gallery grid, or stacked full-width like Saved Listings' rows. */
export type ViewMode = "cards" | "list";

const isViewMode = (v: unknown): v is ViewMode => v === "cards" || v === "list";

/** Pure so the fallback behavior is testable without React: anything that
 *  isn't a known mode — junk, an old renamed value, null — reads as the
 *  caller's default rather than throwing or rendering nothing. */
export function resolveViewMode(
  stored: string | null,
  fallback: ViewMode,
): ViewMode {
  return isViewMode(stored) ? stored : fallback;
}

/** Same shape and storage convention as `useImageSize`, so the two
 *  per-screen display preferences stay interchangeable to work with. */
export function useViewMode(
  pageKey: string,
  defaultMode: ViewMode = "cards",
): [ViewMode, (m: ViewMode) => void] {
  const storageKey = `view-mode:${pageKey}`;
  const [mode, setModeState] = useState<ViewMode>(() => {
    try {
      return resolveViewMode(localStorage.getItem(storageKey), defaultMode);
    } catch {
      // localStorage may be unavailable; fall through to default
      return defaultMode;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      // ignore
    }
  }, [storageKey, mode]);
  return [mode, setModeState];
}
