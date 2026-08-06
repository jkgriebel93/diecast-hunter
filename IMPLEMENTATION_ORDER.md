# Implementation order for open DCH tickets

As of 2026-08-06 (rev 10: DCH-12 shipped; DCH-30 re-scoped from Cloudflare to Sentry, code
shipped, console steps outstanding). Thirteen tickets are merged — DCH-8, DCH-9,
DCH-10, DCH-11, DCH-12, DCH-14, DCH-15, DCH-17, DCH-18, DCH-22, DCH-28, DCH-29, DCH-31 —
leaving eight substantive items plus the roadmap buckets.

The ordering principle has not changed: compounding work (training data, CI safety, anything
that makes later tickets cheaper or safer) goes before features that only pay off once.

## What shipped, and what it changed

| Ticket | Outcome |
| --- | --- |
| DCH-8 | Ended/removed listings archive with an `end_reason`. **This is the comps data source.** |
| DCH-9 | Spike: every external sold-price source is closed to us. Build on the archive. |
| DCH-10 | Sold-price comps on the Listings page and the extension overlay. |
| DCH-11 | Confirm/correct registry match from the extension. |
| DCH-12 | Manually-added collection entries. Introduced `registry_entries.source`; cost basis lives in `my_collection.paid_cents`, separate from DCR's appraisal. |
| DCH-31 | Cross-platform extension packaging, built and uploaded by CI on every run. |
| DCH-14 | Named registry pre-searches. Caches `registry_entries` via the saved filter combo; refreshed by the overnight auto-sync. |
| DCH-15 | Year-range filters on registry search, the Match… dialog, Listings, and Collection. |
| DCH-17 | Thousands separators via shared `Intl.NumberFormat` helpers. |
| DCH-18 | Error translation layer + `ErrorBanner`. |
| DCH-22 | CI: installers on main, plus build/test gates. |
| DCH-28 | Worker deletion-write contract: bounded retry, honest outcome log. |
| DCH-29 | rustfmt / clippy / prettier / worker-test gates. Tree is clean against all four. |

Two things worth carrying forward:

- **Comps will look thin for a while.** The archive only began recording sold prices on
  2026-08-03, so most entries won't clear the 2-sale bar for several more watchlist syncs.
  The Listings page falls back to registry retail until then — the pre-DCH-10 behavior, not
  a broken state. Revisit comp quality once there are a few weeks of data.
- **`cargo fmt` and `pnpm format` are now safe to run repo-wide.** DCH-29 landed one
  mechanical commit per formatter, so neither rewrites untouched files any more. Use
  `pnpm format`, not `npx prettier` — the latter resolves an unpinned version.

## Next up

| # | Ticket | What | Why here |
| --- | --- | --- | --- |
| 1 | DCH-16 | Improve Saved Seller browsing | Still a one-liner ticket. Write the problem statement first; it can't be estimated as written. |

DCH-30 turned out **not** to be dashboard config: Cloudflare has no way to alert on a
discrete log event — Workers Logs can't alert at all, and Notifications alert types are
threshold-shaped. The Worker now reports `deletion_insert_failed` to Sentry itself. The code
shipped; creating the Sentry project, setting `SENTRY_DSN`, and confirming the alert rule are
manual console steps, tracked on the ticket.

`registry_entries.source` is new as of DCH-12, and it is now the guard every DCR-facing
registry flow relies on. Anything added later that walks `registry_entries` and then talks to
diecastregistry.com about what it found needs `source <> 'local'` — a manual entry has no
detail page, so a lookup for one either 404s or, worse, matches something else.

## UI track (dependency-fixed order)

Worth doing as a run rather than piecemeal — 20 and 21 both execute the checklist 19 produces.

| # | Ticket | What |
| --- | --- | --- |
| 2 | DCH-19 | UI audit + standardization guidelines |
| 3 | DCH-20 | Redesign Saved Listing detail panel (follows audit checklist) |
| 4 | DCH-21 | Reorganize Settings screen (follows audit checklist) |

## Later

| # | Ticket | What | Notes |
| --- | --- | --- | --- |
| 5 | DCH-25 | "Production ready" definition spike | Spawns the real production work items — goes before them. |
| 6 | DCH-24 | User documentation | After UI standardization so screenshots don't go stale. |
| 7 | DCH-23 | Performance profiling pass | When something is actually slow, or pre-production. |
| 8 | DCH-13 | Photo-tagging feasibility spike | Flagged likely-expensive; confirm or kill cheaply. |
| 9 | DCH-26 | Lionel website integration | Expansion waits for solid core; needs use-case decision. |
| 10 | DCH-27 | Revive Facebook Marketplace integration | Plugs back into the listing-receiver architecture. |

## Open items that aren't tickets

- ~~Cloudflare alert on `deletion_insert_failed`~~ — became **DCH-30**, and then stopped
  being a Cloudflare thing at all. See the note under "Next up".
- ~~Roadmap buckets DCH-2 … DCH-7 may be closeable~~ — checked on 2026-08-06. DCH-2 is
  already closed; DCH-3 through DCH-7 each still have at least one open child, so none of
  them is closeable yet. Nothing to do here until those children land.
- ~~Extension needs repackaging~~ — solved by **DCH-31**. CI uploads a
  `diecast-hunter-extension-<sha>` artifact on every run; download it from the run for the
  commit you want. That artifact is how DCH-10's comps rows and DCH-11's verdict buttons
  finally reach a browser. Installing it is still a manual load-unpacked step — Chrome Web
  Store publishing was explicitly out of scope.
