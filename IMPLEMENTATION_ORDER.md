# Implementation order for open DCH tickets

As of 2026-08-05 (rev 6: DCH-10, DCH-28 and DCH-29 shipped; DCH-15 is green and awaiting
merge in PR #25). Nine tickets are merged — DCH-8, DCH-9, DCH-10, DCH-11, DCH-17, DCH-18,
DCH-22, DCH-28, DCH-29 — which empties the "ship now" and "contained features" tiers of the
previous rev and leaves ten substantive items plus the roadmap buckets.

The ordering principle has not changed: compounding work (training data, CI safety, anything
that makes later tickets cheaper or safer) goes before features that only pay off once.

## What shipped, and what it changed

| Ticket | Outcome |
| --- | --- |
| DCH-8 | Ended/removed listings archive with an `end_reason`. **This is the comps data source.** |
| DCH-9 | Spike: every external sold-price source is closed to us. Build on the archive. |
| DCH-10 | Sold-price comps on the Listings page and the extension overlay. |
| DCH-11 | Confirm/correct registry match from the extension. |
| DCH-15 | Year-range filters on registry search, the Match… dialog, Listings, and Collection. *(PR #25, green, not yet merged.)* |
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
| 1 | DCH-14 | Saved pre-searches, cached & filtered live | The lowest-friction item left: rides the existing pre-warm machinery and needs no decisions first. |
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

- **Cloudflare alert on `deletion_insert_failed`.** DCH-28 made the event stable and
  alertable and documented how, but the alert itself is dashboard config outside this repo.
  Until it exists, a lost deletion notification is only visible to someone reading logs.
  Flagged in `worker/README.md`.
- **Roadmap buckets DCH-2 … DCH-7 may be closeable.** DCH-2 ("Listing lifecycle &
  valuation") has had all its children — DCH-8, DCH-9, DCH-10 — shipped. They're High
  priority in the board view, which makes the backlog look busier than it is.
- **Extension needs repackaging** (`pnpm ext:package`) plus a desktop rebuild before
  DCH-11's confirm/reject buttons and DCH-10's comps rows appear in a real browser.
