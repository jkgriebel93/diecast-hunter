# Diecast Hunter — eBay browser extension

Shows the diecastregistry.com match and valuation for the eBay item you're
viewing, computed by your Diecast Hunter desktop app. Manifest V3; works in
Firefox 121+ and any recent Chromium browser. The extension is deliberately
dumb: it extracts the title/price from the page and renders whatever the
app answers — all matching (including the learned weights), valuation, and
deal scoring happen locally in the app.

## How it works

- `content.js` runs on `ebay.com/itm/*` pages, extracts the listing title
  and price, and renders a small panel (bottom-right, shadow DOM).
- `background.js` proxies requests to the app's embedded localhost server
  (`listing_receiver`, default `http://localhost:17381`), authenticated
  with a Bearer shared secret:
  - `POST /match/preview` — non-persisting match + valuation for the panel
  - `POST /listings/watch` — the panel's "Watch in app" button; same flow
    as the in-app Watch button (adds to the eBay watchlist and saves
    locally)
  - `GET /health` — powers the "app isn't running" state
- `options.html` stores the endpoint root URL and the shared secret
  (`chrome.storage.local`).

## Setup

1. In the desktop app: **Settings → Browser extension & background** —
   copy the endpoint URL and shared secret. Optionally enable
   "keep running in the background" so the panel works while the app
   window is closed.
2. Package and load the extension:
   - `pnpm ext:package` builds `extension/diecast-hunter-ebay.zip`.
   - **Firefox (temporary, gone on restart)**: `about:debugging` → This
     Firefox → Load Temporary Add-on → pick the `.zip`. (Current Firefox
     builds expect a packaged `.xpi`/`.zip`, not a bare `manifest.json`.)
   - **Firefox Developer Edition (persistent)**: `about:config` → set
     `xpinstall.signatures.required` to `false`, then `about:addons` →
     gear menu → Install Add-on From File… → pick the `.zip`. Unsigned
     installs survive restarts on Dev Edition/Nightly only.
   - **Chrome/Edge**: `chrome://extensions` → Developer mode → Load
     unpacked → pick the `extension/` folder.
3. Open the extension's options page and paste the endpoint + secret.
4. Browse any eBay item page.

## Notes

- Firefox uses the `background.scripts` entry, Chrome the
  `service_worker` one — both point at the same file.
- The panel needs the app's registry cache: drivers you haven't pre-warmed
  (Registry page) will report "no cached registry entries".
