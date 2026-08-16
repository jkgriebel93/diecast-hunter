import { useEffect, useState } from "react";
import { resolveImageSrc } from "@/lib/imageUrl";

/**
 * The picture on a list row — a car, a listing, an attached photo.
 *
 * Every list screen used to hand-roll this, and the copies had drifted: four
 * spelled DCR's origin prefix themselves, one set `referrerPolicy` and eleven
 * didn't, and none handled a URL that resolves but fails to load. That last
 * one is why images "sometimes" vanished — eBay stops serving an image once a
 * listing has been gone long enough, and a dead `src` paints the webview's
 * broken-image glyph, which looks like a bug rather than like a row with no
 * picture on file.
 *
 * So a failed load falls back to the same placeholder a null `src` gets: the
 * two cases are indistinguishable to the user and should look it. The
 * placeholder always occupies the row whether or not there's an image, which
 * keeps text aligned down a list.
 */
export function Thumbnail({
  src,
  className = "",
  alt = "",
  eager = false,
}: {
  /** Raw stored value — absolute, DCR-relative, or a `convertFileSrc` URL.
   *  Resolution and the "unusable" cases are handled here. */
  src: string | null | undefined;
  /** Size classes for the box, e.g. `w-16 h-16` or a screen's `imgSizeClass`.
   *  Shape and border come from the component so every row matches. */
  className?: string;
  /** Only worth setting when the picture carries information the adjacent
   *  text doesn't. A thumbnail beside the title it illustrates is decorative,
   *  and naming it again just makes a screen reader say everything twice. */
  alt?: string;
  /** Skip lazy loading — for the one or two images that are above the fold
   *  by construction, like a dialog header. */
  eager?: boolean;
}) {
  const resolved = resolveImageSrc(src);
  const [failed, setFailed] = useState(false);

  // A recycled row can be handed a new URL; without this the previous URL's
  // failure would suppress an image that is perfectly good.
  useEffect(() => setFailed(false), [resolved]);

  const box = `${className} rounded border border-border shrink-0`;
  if (!resolved || failed) {
    return <div className={`${box} bg-bg`} aria-hidden="true" />;
  }
  return (
    <img
      src={resolved}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      // DCR and eBay both serve images to the webview fine, but its origin is
      // `tauri://`/`http://localhost`, which is exactly the shape a hotlink
      // check rejects. Sending no referrer at all is the reliable request.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${box} object-cover`}
    />
  );
}
