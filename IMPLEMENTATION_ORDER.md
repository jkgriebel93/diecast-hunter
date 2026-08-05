# Implementation order for open DCH tickets

As of 2026-08-05 (rev 8: DCH-14 and DCH-31 shipped; DCH-30 filed for the last item that had
been living only in prose). Twelve tickets are merged — DCH-8, DCH-9, DCH-10, DCH-11,
DCH-14, DCH-15, DCH-17, DCH-18, DCH-22, DCH-28, DCH-29, DCH-31 — leaving nine substantive
items plus the roadmap buckets.

The ordering principle has not changed: compounding work (training data, CI safety, anything
that makes later tickets cheaper or safer) goes before features that only pay off once.

## What shipped, and what it changed

| Ticket | Outcome |
| --- | --- |
| DCH-8 | Ended/removed listings archive with an `end_reason`. **This is the comps data source.** |
| DCH-9 | Spike: every external sold-price source is closed to us. Build on the archive. |
| DCH-10 | Sold-price comps on the Listings page and the extension overlay. |
| DCH-11 | Confirm/correct registry match from the extension. |
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
| 1 | DCH-30 | Alert on `deletion_insert_failed` | Dashboard config, not code. The last piece of the DCH-28 compliance story — until it exists, a lost deletion notification is invisible. |
| 2 | DCH-12 | My Collection entries not in DCR | **Blocked on two decisions.** (a) What value basis to use for an entry with no registry entry — there's no retail/wholesale to inherit. (b) How such rows survive `sync::dcr_collection`, which treats DCR as the source of truth and prunes local rows missing from My Garage. Settle both before coding. |
| 3 | DCH-16 | Improve Saved Seller browsing | Still a one-liner ticket. Write the problem statement first; it can't be estimated as written. |

## UI track (dependency-fixed order)

Worth doing as a run rather than piecemeal — 20 and 21 both execute the checklist 19 produces.

| # | Ticket | What |
| --- | --- | --- |
| 4 | DCH-19 | UI audit + standardization guidelines |
| 5 | DCH-20 | Redesign Saved Listing detail panel (follows audit checklist) |
| 6 | DCH-21 | Reorganize Settings screen (follows audit checklist) |

## Later

| # | Ticket | What | Notes |
| --- | --- | --- | --- |
| 7 | DCH-25 | "Production ready" definition spike | Spawns the real production work items — goes before them. |
| 8 | DCH-24 | User documentation | After UI standardization so screenshots don't go stale. |
| 9 | DCH-23 | Performance profiling pass | When something is actually slow, or pre-production. |
| 10 | DCH-13 | Photo-tagging feasibility spike | Flagged likely-expensive; confirm or kill cheaply. |
| 11 | DCH-26 | Lionel website integration | Expansion waits for solid core; needs use-case decision. |
| 12 | DCH-27 | Revive Facebook Marketplace integration | Plugs back into the listing-receiver architecture. |

## Open items that aren't tickets

- ~~Cloudflare alert on `deletion_insert_failed`~~ — now **DCH-30**.
- **Roadmap buckets DCH-2 … DCH-7 may be closeable.** DCH-2 ("Listing lifecycle &
  valuation") has had all its children — DCH-8, DCH-9, DCH-10 — shipped. They're High
  priority in the board view, which makes the backlog look busier than it is.
- ~~Extension needs repackaging~~ — solved by **DCH-31**. CI uploads a
  `diecast-hunter-extension-<sha>` artifact on every run; download it from the run for the
  commit you want. That artifact is how DCH-10's comps rows and DCH-11's verdict buttons
  finally reach a browser. Installing it is still a manual load-unpacked step — Chrome Web
  Store publishing was explicitly out of scope.
