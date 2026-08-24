import { useState } from "react";
import { Thumbnail } from "@/components/Thumbnail";
import { stepIndex } from "@/lib/carousel";
import { api } from "@/lib/tauri";

/**
 * A card thumbnail that can cycle through an image set — the DCH-52 Seller
 * Feed carousel, extracted so Saved Listings mounts the same component
 * (DCH-75). Owns the current index; the caller owns which images apply
 * (see `lib/carousel.ts::visibleImages` for the fallback rules).
 *
 * With one image or none this is exactly a `Thumbnail` — no arrows, no
 * counter, no empty frame. The index survives the set changing shape;
 * `stepIndex`/modulo keep it in range when the set shrinks.
 *
 * Clicking the image opens it enlarged in the reusable photo window —
 * clicking through several photos retargets one window, never stacks.
 * `photoTitle` names that window after the listing.
 */
export function CarouselThumbnail({
  images,
  className,
  photoTitle,
}: {
  images: string[];
  className: string;
  photoTitle?: string;
}) {
  const [index, setIndex] = useState(0);
  const count = images.length;
  const shown = count > 0 ? images[index % count] : null;

  return (
    <div className="shrink-0 space-y-1">
      {shown !== null ? (
        <button
          type="button"
          className="block cursor-zoom-in"
          aria-label="Open this photo enlarged in a new window"
          title="Open this photo enlarged in a new window"
          onClick={() => {
            // Fire-and-forget like the sidebar's new-window button: the
            // result is a window appearing, and a failure has no surface
            // in a thumbnail, so it goes to the console.
            api.openPhotoWindow(shown, photoTitle ?? "Photo").catch((e) => {
              console.error("open photo window failed:", e);
            });
          }}
        >
          <Thumbnail src={shown} className={className} />
        </button>
      ) : (
        <Thumbnail src={null} className={className} />
      )}
      {count > 1 && (
        <div className="flex items-center justify-center gap-2 text-xs text-fg-subtle tabular-nums">
          <button
            type="button"
            className="px-1.5 hover:text-fg"
            aria-label="Previous image"
            onClick={() => setIndex((i) => stepIndex(i, -1, count))}
          >
            ‹
          </button>
          {(index % count) + 1} / {count}
          <button
            type="button"
            className="px-1.5 hover:text-fg"
            aria-label="Next image"
            onClick={() => setIndex((i) => stepIndex(i, 1, count))}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
