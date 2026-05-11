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
- `dcr/` — diecastregistry.com integration. `client.rs` is the cookie-jar `reqwest` client + login flow; `parse.rs` is pure HTML/string parsing (heavily unit-tested — fixtures in `src-tauri/fixtures/dcr/`); `collection.rs` glues the two for the My Garage pages.
- `ebay/` — eBay API integration. `client.rs` (`EbayClient` + `EbayEnvironment` for prod/sandbox), `browse.rs` (Browse API item lookups via app access token / Client Credentials grant), `search.rs` (Browse search), `offers.rs` + `trading.rs` (offer/Trading API surfaces backing the Offers page and watchlist), `category.rs` (category lookups), `oauth.rs` (user-OAuth connect flow — `authorize_url` / `exchange_code` / `get_user_access_token` / `status` / `disconnect`), `parse.rs` (e.g. `extract_legacy_item_id` from URLs). Tokens go in the keyring, not SQLite.
- `sync/` — orchestration that reads from a remote source and writes to SQLite. One file per flow: `dcr_collection.rs`, `dcr_registry.rs`, `ebay_watchlist.rs`, `ebay_listing.rs`, `fb_listing.rs` (inbound from the browser extension), `registry_link.rs`, `registry_prewarm.rs`, `listing_match.rs`. Add new "pull/receive from remote → upsert locally" flows here, not in `commands.rs`.
- `matcher/` — heuristic matcher that links a `listings` row back to a `registry_entries` row (driver / year / paint scheme / scale), producing `listing_matches` rows with a confidence score. The `user_confirmed` flag on a match is the training signal — preserve it when re-running matches.
- `listing_receiver/` — small `axum` HTTP server bound to `127.0.0.1:17381` that the Facebook Marketplace browser extension POSTs to. Authenticated with a shared secret stored in the keyring; payload schema is documented in `extension/README.md`. Lifetime is managed from `lib.rs`'s `setup()`.
- `progress.rs` — typed progress events emitted to the frontend via Tauri's event system during long-running syncs. Use these instead of ad-hoc `app.emit()` calls so the frontend's progress UI stays consistent.

### Schema relationships

`drivers` is the normalization root. `paint_schemes` and `registry_entries` reference it; `my_collection` references `registry_entries`; `listings` (eBay/FB Marketplace) get linked back to `registry_entries` via `listing_matches` (with confidence + user-confirmed flag for matcher learning); `listing_history` is a price/status time series. When adding tables, follow the convention of `*_cents INTEGER` for money and `INTEGER` Unix timestamps for time.

`raw_json` columns on `registry_entries`, `my_collection`, and `listings` deliberately store the source payload so we can re-derive fields without re-fetching. `list_collection_for_driver` in `commands.rs` shows the pattern: pull `raw_json` and re-parse it for fields not yet promoted to columns.

### Frontend (`src/`)

- All backend calls go through `src/lib/tauri.ts`, which exports a single `api` object wrapping `invoke<T>()` calls. Add new commands here with their TS types — keep these in sync with the Rust `Serialize` structs in `commands.rs`.
- Routing: `react-router-dom` v6. Pages: `Dashboard`, `Collection`, `Browse` (eBay search), `Listings` (saved listings + matches), `Offers` (eBay offers driven by watchlist), `Settings`. The `@/` import alias maps to `src/`.
- Styling: Tailwind. `clearScreen: false` in `vite.config.ts` and `watch.ignored: ["**/src-tauri/**"]` are intentional — don't remove.

### Adding a backend command

1. Write `pub async fn foo(state: State<'_, AppState>, ...) -> AppResult<T>` in `commands.rs` (or a new module).
2. Register it in the `invoke_handler!` list in `lib.rs`.
3. Add a typed wrapper in `src/lib/tauri.ts`.
4. Tauri converts camelCase JS args to snake_case Rust params automatically — pass `{ driverId }` from JS for a `driver_id: i64` Rust param.

### Cloudflare Worker (`worker/`)

Separate pnpm project — its own `package.json`, `wrangler.toml`, and `tsconfig.json`. Single-file Worker (`src/index.ts`) that satisfies eBay's Marketplace Account Deletion compliance so the prod keyset is unlocked. It (1) responds to eBay's GET verification challenge with the SHA-256 hash, (2) queues deletion POSTs in Cloudflare KV (`DELETIONS` binding), (3) exposes an authenticated polling API the desktop app drains on launch. Two secrets via `wrangler secret put`: `EBAY_VERIFICATION_TOKEN` (32–80 chars, shared with eBay) and `APP_SHARED_SECRET` (Bearer token between Worker and desktop app). Run `pnpm dev` (wrangler local on :8787) / `pnpm deploy` from inside `worker/`. ECDSA signature verification of inbound notifications is intentionally not implemented yet — see `worker/README.md` for the threat-model rationale.

### Browser extension (`extension/`)

Plain JS Manifest V3 extension (no build step) for capturing Facebook Marketplace items into the desktop app. The popup pulls OpenGraph metadata from the active tab and POSTs it to the desktop app's `listing_receiver` server on `127.0.0.1:17381` with a shared-secret Bearer token. See `extension/README.md` for the wire format and install steps (`about:debugging` for Firefox, `chrome://extensions` "Load unpacked" for Chromium). The shared secret is generated by the desktop app and surfaced in **Settings → Browser-extension receiver**.

## Roadmap context

The app is built in milestones (M1–M6 in README.md). M1 (scaffold), M2 (DCR My Garage sync), M3 (lazy-enrich registry detail pages), M4 (eBay direct integration — Browse API, watchlist sync, matcher, deal score, manual override, registry search), and M5 (Facebook Marketplace browser extension) are done. M6 — Bid / Buy It Now actions — is gated on eBay Buy API approval and not started. The `listings` / `listing_matches` / `listing_history` tables are now populated by the eBay watchlist sync and the FB Marketplace receiver.
