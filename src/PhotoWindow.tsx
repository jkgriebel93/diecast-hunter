/**
 * The enlarged-photo window (DCH-75): one image, scaled to fit, on the
 * page background. Mounted by main.tsx when the URL carries a valid
 * `?photo=<url>` — which is how the backend's `open_photo_window`
 * addresses it. Deliberately inert: no providers, no invokes, nothing to
 * keep alive; closing it is the only interaction beyond looking.
 */
export function PhotoWindow({ url }: { url: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-bg p-2">
      <img
        src={url}
        alt="Listing photo, enlarged"
        className="max-w-full max-h-full object-contain"
      />
    </div>
  );
}
