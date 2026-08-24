// The viewer-window entry contract (DCH-64). A secondary window is a
// stateless single-view "viewer": the backend opens `index.html?viewer=<id>`
// and main.tsx mounts that one view without the workspace shell. The id
// rides the URL rather than any storage on purpose — localStorage is shared
// across every webview in a Tauri app, so storage is exactly where a second
// window must not keep state.

import { isViewId, type ViewId } from "./views";

/** The view a viewer window should pin, from its `location.search` — or
 *  null when this is the main window (no `viewer` param) or the param names
 *  a view that doesn't exist (stale shortcut, renamed view). Callers treat
 *  null as "render the normal app". */
export function viewerViewFromSearch(search: string): ViewId | null {
  const raw = new URLSearchParams(search).get("viewer");
  return raw !== null && isViewId(raw) ? raw : null;
}

/** The image the enlarged-photo window (DCH-75) should show, from its
 *  `location.search` — or null when absent or not an image URL. The
 *  allowlist mirrors the backend's `is_photo_url`: web images and inline
 *  data images only, because this string becomes an `<img src>`. */
export function photoUrlFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("photo");
  if (raw === null) return null;
  return raw.startsWith("https://") ||
    raw.startsWith("http://") ||
    raw.startsWith("data:image/")
    ? raw
    : null;
}
