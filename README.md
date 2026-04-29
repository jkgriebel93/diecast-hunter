# Diecast Hunter

Desktop app (Windows 11) for managing a NASCAR diecast collection. Imports
your collection from [diecastregistry.com](https://diecastregistry.com),
tracks saved listings on eBay and Facebook Marketplace, and compares listing
prices against the registry's retail/wholesale values.

## Stack

- **Tauri 2** shell with a Rust backend
- **React 18 + TypeScript + Vite** frontend, styled with Tailwind CSS
- **SQLite** via `sqlx` for local storage
- **OS keyring** (Windows Credential Manager on Win11) for secrets

## Prerequisites (Windows 11)

1. **Rust toolchain** — install via [rustup](https://rustup.rs/) (1.78+).
2. **Node.js 20+**.
3. **pnpm 10+** — `npm install -g pnpm` (or follow https://pnpm.io/installation).
4. **Microsoft Edge WebView2 runtime** — preinstalled on Windows 11.
5. **Visual Studio Build Tools 2022** with the *Desktop development with C++*
   workload (needed by the Rust linker).

## Getting started

```powershell
pnpm install
pnpm tauri dev
```

The first build is slow (Rust deps); subsequent builds are fast.

## Project layout

```
.
├── src/                  # React + TypeScript frontend
│   ├── components/       # Shared UI (Sidebar, etc.)
│   ├── pages/            # Dashboard, Collection, Listings, Settings
│   └── lib/tauri.ts      # Typed wrappers around Tauri invoke()
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs        # Tauri builder + setup
│   │   ├── commands.rs   # #[tauri::command] handlers exposed to JS
│   │   ├── db.rs         # sqlx pool + migration runner
│   │   ├── settings.rs   # KV settings (DB) + secrets (keyring)
│   │   └── error.rs      # AppError, serializable to the frontend
│   ├── migrations/       # SQL migrations applied at startup
│   ├── icons/            # App icons (placeholder; replace before release)
│   ├── capabilities/     # Tauri capability/permission config
│   └── tauri.conf.json
└── package.json
```

The SQLite database is created at:

- Windows: `%APPDATA%\DiecastHunter\DiecastHunter\data\diecast-hunter.sqlite`

## Replacing placeholder icons

`src-tauri/icons/` ships with solid-blue placeholders. To regenerate from a
real source PNG (≥1024px square):

```powershell
pnpm tauri icon path\to\source.png
```

## Roadmap

This is milestone 1 of 6. See conversation history for the full plan.

- [x] **M1**: Scaffold (this commit) — Tauri shell, SQLite, settings screen.
- [ ] **M2**: diecastregistry.com sync (login + master registry + collection).
- [ ] **M3**: Browser extension companion for capturing eBay/FB listings.
- [ ] **M4**: Listing → registry matcher and grouped browse UI.
- [ ] **M5**: eBay API integration (read-only, then write/buy/bid).
- [ ] **M6**: Value comparison view.
