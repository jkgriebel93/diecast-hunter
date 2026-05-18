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
