import { resolveDcrUrl } from "./dcr";

/**
 * Resolve a stored image reference to something an `<img src>` can load.
 *
 * Thin wrapper over {@link resolveDcrUrl} that adds the one rule an image
 * needs and a link doesn't: return null for anything unusable, so callers
 * have a single thing to check. An empty string is a *valid* `src` that
 * resolves to the page itself, so passing one through puts a broken-image
 * icon on screen rather than rendering nothing.
 */
export function resolveImageSrc(src: string | null | undefined): string | null {
  const trimmed = src?.trim();
  if (!trimmed) return null;
  return resolveDcrUrl(trimmed);
}
