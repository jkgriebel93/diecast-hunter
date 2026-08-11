# Screenshots

PNGs under `docs/screenshots/<feature>/`, embedded in the PR that changed the
screen. Pull-request bodies must reference them at the **`main`** ref — merging
with `gh pr merge -d` deletes the branch and turns branch-ref images into 404s.

## Regenerating them

The app is a Tauri shell, so a plain browser can't load a page: every screen
calls `invoke()` and gets nothing back. `src/screenshot-harness.tsx` is the way
in — it stubs `window.__TAURI_INTERNALS__` with a fixed fixture, mounts one page
inside a box shaped like `EditorPane`'s scrollport, and reads a `preset` query
parameter so each capture is deterministic rather than a state you had to click
your way into. It is dev-only: nothing imports it, and `vite build` bundles
`index.html` alone.

```sh
pnpm dev
google-chrome --headless=new --disable-gpu --window-size=1280,700 \
  --virtual-time-budget=5000 \
  --screenshot=out.png "http://localhost:1420/screenshot.html?preset=default"
```

Capture every state at the **same window size** — a layout fix is only legible
next to the layout it fixed. Short windows (700px and under) are where sticky
panels and tall filter cards actually break, so prefer one of those over a tall
window that hides the problem.

To shoot a different page or state, edit the harness: swap the imported page,
add a `preset` branch for the state, and seed store-backed state through the
store's own API (`setManyMinimized`, not a raw `localStorage.setItem` — the
minimized store snapshots localStorage at import time, so a raw write lands
underneath it and does nothing).

## Contents

| Folder | Ticket | What it shows |
| --- | --- | --- |
| `archive-ended-listings/` | DCH-10 | Archived rows and the end-reason labels |
| `danger-actions/` | DCH-33 | `.btn-danger` / `.link-danger` at rest |
| `error-messages/` | DCH-18 | `ErrorBanner` titles and the details disclosure |
| `extension-match-verdicts/` | — | The eBay extension's in-page verdict |
| `facet-collapse/` | DCH-43 | Saved Listings' collapsible filter facets |
| `filter-parity/` | DCH-35 | Clear filters, filtered-empty, result counts |
| `helper-adoption/` | DCH-34 | Shared formatters on the list screens |
| `listing-panel/` | DCH-20 | Listing cards collapsed by default |
| `manual-collection-entry/` | DCH-12 | Adding a car DCR doesn't list |
| `seller-filter/` | DCH-44 | Saved Listings' Seller facet, open / picked / empty |
| `wishlist-bulk-add/` | DCH-45 | Select mode → Add to wishlist, and its notices |
| `wishlist-sharing/` | DCH-46 | Share dialog (unconfigured / ready / live) and its settings |
