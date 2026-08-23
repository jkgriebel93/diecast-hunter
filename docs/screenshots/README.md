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
window that hides the problem. `filter-pane/short-window.png` is the exception
and says so in the table below: it is shot at 520px because that is where the
current panel's remaining failure modes live.

To shoot a different page or state, edit the harness: swap the imported page,
add a `preset` branch for the state, and seed store-backed state through the
store's own API (`setManyMinimized`, not a raw `localStorage.setItem` — the
minimized store snapshots localStorage at import time, so a raw write lands
underneath it and does nothing).

## Contents

| Folder | Ticket | What it shows |
| --- | --- | --- |
| `app-version/` | DCH-67 | The Dashboard diagnostics card's `app: 26.8.17 (cd658ea)` line — the in-app face of the build-derived CalVer + commit that also titles the window |
| `archive-ended-listings/` | DCH-10 | Archived rows and the end-reason labels |
| `collection-sorts/` | DCH-66 | The grouped toolbar's two labelled sort controls (Drivers: / Cars:) beside the flat view's single one — the answer to the ticket's "too busy?" question in pixels |
| `collection-entry-titles/` | DCH-65 | Every entry titled `<Driver> #<No.> <Year> <Sponsor/Scheme> <Model> <Specials>` — the flat list, and a grouped panel open to show the rows carry the full format under the driver's own header |
| `collection-notes/` | DCH-63 | Add note / Edit note on every Collection row — DCR-synced included — with a note rendered under its entry, and the note editor open with the car line naming what it's on |
| `danger-actions/` | DCH-33 | `.btn-danger` / `.link-danger` at rest |
| `enrichment-cap/` | DCH-53 | Settings' Sync tab with the "Max detail pages per sync" cap beside the pre-warm cap |
| `expand-all/` | DCH-68 | The paired Expand/Collapse all: Saved Listings' flat view with every card expanded and the label flipped, and Registry results collapsed with "Expand all" offered |
| `error-messages/` | DCH-18 | `ErrorBanner` titles and the details disclosure |
| `extension-match-verdicts/` | — | The eBay extension's in-page verdict |
| `extension-minimized/` | DCH-70 | The extension overlay's two faces on a mock item page: the default pill ("DH · match 92% · 85% of sold") in the corner, and the full panel with its new minimize button. Shot from a local harness that stubs `chrome.*` and runs the real content script — the states are reachable, not painted |
| `facet-collapse/` | DCH-43 | Saved Listings' collapsible filter facets — **superseded by `filter-pane/`**; kept as the record of that PR, and its `expanded` / `badges` presets are gone |
| `filter-pane/` | DCH-47 | The filter sidebar as a scrolling accordion: at rest, collapsed summaries, mid-scroll, a menu escaping the scroll region, and (at 520px) the pinned footer |
| `filter-parity/` | DCH-35 | Clear filters, filtered-empty, result counts |
| `listing-sharing/` | DCH-48 | Share selection dialog, the created link, the unconfigured state, and Settings' Active links |
| `helper-adoption/` | DCH-34 | Shared formatters on the list screens |
| `listing-panel/` | DCH-20 | Listing cards collapsed by default |
| `listings-perf/` | DCH-58 | What must not have changed: the flat list, the search-narrowed list with faceted counts, and the by-driver view fully collapsed (which now mounts no cards) |
| `registry-results-perf/` | DCH-59 | The bounded results render ("Show 200 more" under the 200th card), the deferred results filter narrowing 450 → 225, and the MultiSelect's capped dropdown with its "N more matches" note |
| `manual-collection-entry/` | DCH-12 | Adding a car DCR doesn't list |
| `match-dialog-search/` | DCH-73 | The match dialog's "Search these results…" box narrowing 450 → 225 with the count updating beside it, and the box excluding everything — FilteredEmpty with its Clear way out, distinct from a search that returned nothing |
| `result-counts/` | DCH-72 | The match dialog's result count pinned above its scroll region (the surface that had none), and Saved Listings' "4 of 24 listings." while a search narrows the flat list |
| `seller-feed-chrome/` | DCH-16 | The reworked Seller Feed: Browse-shaped filter card with the shared Clear filters control, Manage Saved Sellers as a modal, FilteredEmpty, and the bottom pager |
| `seller-feed-image-sizes/` | DCH-49 | The feed's gallery grid before (fixed 19rem columns crushing the md/lg cards) and after (columns sized to the image) |
| `seller-feed-details/` | DCH-52 | An expanded card: live image carousel (2/3), Item specifics grid, plain-text description — and the per-card inline error state |
| `seller-feed-dismiss/` | DCH-51 | The "not interested" ✕ on each card, the "N hidden" count with two items excluded from the feed, and the review/un-hide dialog |
| `seller-feed-list-view/` | DCH-50 | The cards/list toggle in the toolbar, the list view's full-width rows, and the card grid beside it |
| `seller-filter/` | DCH-44 | Saved Listings' Seller facet, open / picked / empty |
| `wishlist-bulk-add/` | DCH-45 | Select mode → Add to wishlist, and its notices |
| `wishlist-sharing/` | DCH-46 | Share dialog (unconfigured / ready / live) and its settings |
