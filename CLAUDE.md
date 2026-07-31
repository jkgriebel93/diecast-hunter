# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (enforced by `packageManager` in package.json). Do not use npm/yarn.

- `pnpm install` — install JS deps
- `pnpm tauri dev` — run the desktop app (starts Vite on :1420 + Tauri shell). Use this for end-to-end work; first build is slow due to Rust deps.
- `pnpm dev` — frontend only (no Tauri shell; `invoke` calls will fail)
- `pnpm build` — `tsc -b && vite build` (TypeScript typecheck + production frontend bundle)
- `pnpm tauri build` — produce Windows installers (msi + nsis)
- `pnpm tauri icon path/to/source.png` — regenerate `src-tauri/icons/` from a ≥1024px source

Rust side (run from `src-tauri/`):

- `cargo test` — runs all Rust tests, including the parser tests in `src/dcr/parse.rs`
- `cargo test parse_details_line` — single test by name
- `cargo check` — fast compile check without linking
- `cargo fmt` / `cargo clippy` — formatting / lints

## Architecture

Tauri 2 app: **Rust backend ↔ React/TS frontend** communicating exclusively through `#[tauri::command]` handlers invoked from JS via `@tauri-apps/api/core`'s `invoke()`.

### Backend layers (`src-tauri/src/`)

- `lib.rs` — Tauri builder; constructs `AppState { db: Db }` in `setup()` and registers it with `handle.manage()`. New commands must be added to the `invoke_handler!` list here.
- `commands.rs` — every `#[tauri::command]` lives here. Commands take `State<'_, AppState>` and return `AppResult<T>` (= `Result<T, AppError>`). `AppError` is `Serialize`, so errors propagate to the frontend as structured values.
- `db.rs` — sqlx `SqlitePool` (WAL mode, foreign keys on). Migrations under `src-tauri/migrations/` run automatically at startup via `sqlx::migrate!()`. The DB lives at the OS data dir resolved by `directories::ProjectDirs("com", "DiecastHunter", "DiecastHunter")` — on Windows that's `%APPDATA%\DiecastHunter\DiecastHunter\data\diecast-hunter.sqlite`.
- `settings.rs` — split persistence: non-secret KV in the `settings` table (`get`/`set`/`delete`); secrets in the OS keyring via `keyring` crate under service `"DiecastHunter"` (`secret_get`/`secret_set`/`secret_delete`). Use the `KEY_*` (DB) and `ENTRY_*` (keyring) constants; never store passwords or OAuth tokens in SQLite.
- `dcr/` — diecastregistry.com integration. `client.rs` is the cookie-jar `reqwest` client + login flow; `parse.rs` is pure HTML/string parsing (heavily unit-tested — fixtures in `src-tauri/fixtures/dcr/`); `collection.rs` glues the two for the My Garage pages; `register.rs` is the add-to-garage form-submission flow; `delete.rs` is the remove-from-garage flow: a single XHR POST to `/MyGarage/{assetGuid}/Delete` with an empty body (IIS needs `Content-Length: 0` or it 411s; no anti-forgery token). Responses: `{"success":true}` deleted; bare `{"success":false,"url":"/MyGarage"}` = asset not in the garage; `{"success":false,"message":…}` = rejected for a reason. The browser's `ConfirmDeleteDiecast` modal GET is human-only chrome and 500s for missing assets — don't use it programmatically. **AJAX-gated endpoints:** several DCR MVC actions that back modals (notably `/MyGarage/RegisterDiecast/{id}`) check `Request.IsAjaxRequest()` server-side and return 404 → `/error/404` for plain GETs. Use `DcrClient::get_html_xhr` (sets `X-Requested-With: XMLHttpRequest` + jQuery-style `Accept`) for those, not `get_html`. Symptom when you forget: a `network error: HTTP status client error (404 Not Found) for url (.../error/404)` from a path the browser handles fine.
- `ebay/` — eBay API integration. `client.rs` (`EbayClient` + `EbayEnvironment` for prod/sandbox), `browse.rs` (Browse API item lookups via app access token / Client Credentials grant), `search.rs` (Browse search), `offers.rs` + `trading.rs` (offer/Trading API surfaces backing the Offers page and watchlist), `category.rs` (category lookups), `oauth.rs` (user-OAuth connect flow — `authorize_url` / `exchange_code` / `get_user_access_token` / `status` / `disconnect`), `parse.rs` (e.g. `extract_legacy_item_id` from URLs). Tokens go in the keyring, not SQLite.
- `sync/` — orchestration that reads from a remote source and writes to SQLite. One file per flow: `dcr_collection.rs` (full sync also prunes local rows missing from My Garage — DCR is the source of truth), `dcr_remove.rs` (delete one entry on DCR then locally; a not-found on DCR still deletes locally and is reported as neutral, not an error), `dcr_registry.rs`, `ebay_watchlist.rs`, `ebay_listing.rs`, `driver_assoc.rs`, `registry_link.rs`, `registry_prewarm.rs`. Add new "pull/receive from remote → upsert locally" flows here, not in `commands.rs`.
- Listing↔registry linkage is manual only. The UI's **Match…** button on the Listings page opens the registry-search dialog, which calls `sync::registry_link::link_listing_to_registry` to write the `listing_matches` row (always `user_confirmed = 1`, `confidence = 100`). `clear_listing_match` / `reject_listing_match` are the unlink and mark-no-match paths. There is no automatic registry scorer.
- Listing→driver association IS automatic. `sync::driver_assoc::associate_listing_driver` runs after every listing add/refresh and writes `listings.driver_id` based on a token match of the title against the drivers table (most-specific name wins). A startup backfill in `lib.rs::setup()` re-scans any listings with NULL `driver_id`. The auto-driver is independent of the manual registry link — the UI groups by registry-match driver first, falls back to auto-driver, then "Unmatched".
- `listings.driver_id_user_set = 1` is the manual override flag. Set by `commands::set_listing_driver` (pick a driver) and `clear_listing_driver` (pin to no driver); cleared by `reset_listing_driver`, which also re-runs detection. `set_listing_driver` upserts the local `drivers` row by normalized name, so users can tag a listing with a driver that wasn't yet in the table. Auto-association skips any row where this flag is set, including under `force = true` — `reset_listing_driver` is the only supported way to drop the pin.
- `progress.rs` — typed progress events emitted to the frontend via Tauri's event system during long-running syncs. Use these instead of ad-hoc `app.emit()` calls so the frontend's progress UI stays consistent.

### Schema relationships

`drivers` is the normalization root. `paint_schemes` and `registry_entries` reference it; `my_collection` references `registry_entries`; `listings` (eBay) get linked back to `registry_entries` via `listing_matches` (manual links only — see `sync/registry_link.rs`); `listing_history` is a price/status time series. When adding tables, follow the convention of `*_cents INTEGER` for money and `INTEGER` Unix timestamps for time.

`raw_json` columns on `registry_entries`, `my_collection`, and `listings` deliberately store the source payload so we can re-derive fields without re-fetching. `list_collection_for_driver` in `commands.rs` shows the pattern: pull `raw_json` and re-parse it for fields not yet promoted to columns.

### Frontend (`src/`)

- All backend calls go through `src/lib/tauri.ts`, which exports a single `api` object wrapping `invoke<T>()` calls. Add new commands here with their TS types — keep these in sync with the Rust `Serialize` structs in `commands.rs`.
- Navigation is a split-view **workspace**, not a router (react-router was removed). `src/lib/views.tsx` is the registry of pages (`ViewId` → component); `src/lib/workspace.tsx` is the context+reducer holding the editor-group state: an array of panes (max 3, side by side), each with its own open tabs and active tab, plus one focused pane. State persists to `localStorage` (`workspace.v1`). `Workspace.tsx` lays out panes with draggable dividers; `EditorPane.tsx` is one group's tab strip + stacked tab content (inactive tabs stay mounted, hidden, to preserve state). The `Sidebar` opens a view into the focused pane (or a new pane via the hover "open to the side" button); cross-page links inside pages use `<ViewLink to=…>` (`src/components/ViewLink.tsx`) instead of `<Link>`. To add a page: add it to `VIEWS` in `views.tsx` and to the `links` nav tree in `Sidebar.tsx`. Pages must stay zero-prop and router-free. The `@/` import alias maps to `src/`.
- Styling: Tailwind. `clearScreen: false` in `vite.config.ts` and `watch.ignored: ["**/src-tauri/**"]` are intentional — don't remove.

### Adding a backend command

1. Write `pub async fn foo(state: State<'_, AppState>, ...) -> AppResult<T>` in `commands.rs` (or a new module).
2. Register it in the `invoke_handler!` list in `lib.rs`.
3. Add a typed wrapper in `src/lib/tauri.ts`.
4. Tauri converts camelCase JS args to snake_case Rust params automatically — pass `{ driverId }` from JS for a `driver_id: i64` Rust param.

### Cloudflare Worker (`worker/`)

Separate pnpm project — its own `package.json`, `wrangler.toml`, and `tsconfig.json`. Single-file Worker (`src/index.ts`) that satisfies eBay's Marketplace Account Deletion compliance so the prod keyset is unlocked. It (1) responds to eBay's GET verification challenge with the SHA-256 hash, (2) queues deletion POSTs in Cloudflare KV (`DELETIONS` binding), (3) exposes an authenticated polling API the desktop app drains on launch. Two secrets via `wrangler secret put`: `EBAY_VERIFICATION_TOKEN` (32–80 chars, shared with eBay) and `APP_SHARED_SECRET` (Bearer token between Worker and desktop app). Run `pnpm dev` (wrangler local on :8787) / `pnpm deploy` from inside `worker/`. ECDSA signature verification of inbound notifications is intentionally not implemented yet — see `worker/README.md` for the threat-model rationale.

## Roadmap context

The app is built in milestones (M1–M6 in README.md). M1 (scaffold), M2 (DCR My Garage sync), M3 (lazy-enrich registry detail pages), and M4 (eBay direct integration — Browse API, watchlist sync, deal score, registry search/manual linking) are done. M5 (Facebook Marketplace browser extension) was built and then removed for now — the `listings.seller_id` scheme still supports non-eBay sellers, and old FB rows may exist in user databases. The `extension/` directory now hosts an eBay extension instead: a content script on `ebay.com/itm/*` pages that shows the DCR match + valuation via the embedded `listing_receiver` localhost server (127.0.0.1, Bearer shared secret in the keyring; routes `/health`, `POST /match/preview` (non-persisting scorer preview), `POST /listings/watch`). Settings → "Browser extension & background" exposes the endpoint/secret plus tray-mode (`app.run_in_background` hides the window on close instead of exiting; tray icon reopens) and start-at-login (tauri-plugin-autostart). M6 — Bid / Buy It Now actions — is gated on eBay Buy API approval and not started. The `listings` / `listing_matches` / `listing_history` tables are populated by the eBay watchlist sync; `listing_matches` is filled only by manual links from the registry-search dialog.
