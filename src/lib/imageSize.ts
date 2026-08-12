import { useEffect, useState } from "react";

export type ImageSize = "sm" | "md" | "lg";

const isImageSize = (v: unknown): v is ImageSize =>
  v === "sm" || v === "md" || v === "lg";

export function useImageSize(
  pageKey: string,
  defaultSize: ImageSize = "md",
): [ImageSize, (s: ImageSize) => void] {
  const storageKey = `image-size:${pageKey}`;
  const [size, setSizeState] = useState<ImageSize>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (isImageSize(stored)) return stored;
    } catch {
      // localStorage may be unavailable; fall through to default
    }
    return defaultSize;
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, size);
    } catch {
      // ignore
    }
  }, [storageKey, size]);
  return [size, setSizeState];
}

export type SizeClasses = Record<ImageSize, string>;

export function pickSize(classes: SizeClasses, size: ImageSize): string {
  return classes[size];
}

/** Listing-thumbnail size classes, shared by every screen with an
 *  `ImageSizeToggle` so the three sizes stay identical app-wide. */
export const IMG_CLASS: SizeClasses = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

/** Column sizing for the gallery grids (Browse, Seller Feed), keyed by the
 *  same image size as `IMG_CLASS`. The cards lay the image beside the text,
 *  so a column must hold image + fixed chrome (card padding, minimize
 *  toggle, flex gaps ≈ 4.5rem) and still leave the text a readable width —
 *  a fixed 19rem column fits the 6rem small image but overflows on the
 *  12rem and 18rem ones. `imageSize.test.ts` pins that arithmetic. */
export const GALLERY_GRID_CLASS: SizeClasses = {
  sm: "grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3",
  md: "grid grid-cols-[repeat(auto-fill,minmax(min(100%,26rem),1fr))] gap-3",
  lg: "grid grid-cols-[repeat(auto-fill,minmax(min(100%,32rem),1fr))] gap-3",
};
