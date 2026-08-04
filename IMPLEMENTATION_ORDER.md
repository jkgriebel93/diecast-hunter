# Implementation order for open DCH tickets

As of 2026-08-04 (rev 2: DCH-11 shipped, DCH-17 in review, DCH-28 added). DCH-8 (archiving)
and DCH-11 (extension match verdicts) are merged; DCH-9 (sold-data spike) delivered, pending
review. Key departure from the roadmap buckets: **DCH-10 moves down a few slots** — the spike
concluded comps build on the DCH-8 archive, which only started accumulating sold prices on
2026-08-03. A few weeks of watchlist syncs make comps v1 immediately useful instead of empty.
Compounding tickets (training data, CI safety) go first.

## Ship now

| # | Ticket | What | Why here |
| --- | --- | --- | --- |
| ~~1~~ | ~~DCH-11~~ | Confirm/correct registry match from the extension | ✅ Shipped (PR #15, merged 2026-08-04). |
| ~~2~~ | ~~DCH-17~~ | Thousands separators | ✅ In review (PR #16). |
| 3 | DCH-18 | Nicer error messages | Quick win; `AppError` already structured — presentation only. |
| 4 | DCH-28 | Worker Bug: deletion notification acknowledged with 200 when the D1 write fails | Small fix, real data-loss/compliance exposure in prod — eBay never redelivers an acknowledged notification. Surfaced by DCH-17's test-harness work. |
| 5 | DCH-22 | Build pipeline (installer + `cargo test` / `tsc -b` / `pnpm test` gates on main) | Cheap insurance that protects every later ticket; earlier = more payback. Now that vitest exists (DCH-17), gate on it too. |
| 6 | DCH-10 | Completed-auction comps | By now the archive has weeks of sold data with registry links. ~2–4 days per spike estimate. |

## Contained features

| # | Ticket | What | Notes |
| --- | --- | --- | --- |
| 7 | DCH-15 | Year-range filters | Small, no dependencies. |
| 8 | DCH-12 | My Collection entries not in DCR | Needs value-basis decision + DCR-sync-prune safety. |
| 9 | DCH-14 | Saved pre-searches, cached & filtered live | Rides the pre-warm machinery. |
| 10 | DCH-16 | Improve Saved Seller browsing | Write the problem statement first — currently a one-liner. |

## UI track (dependency-fixed order)

| # | Ticket | What |
| --- | --- | --- |
| 11 | DCH-19 | UI audit + standardization guidelines |
| 12 | DCH-20 | Redesign Saved Listing detail panel (follows audit checklist) |
| 13 | DCH-21 | Reorganize Settings screen (follows audit checklist) |

## Later

| # | Ticket | What | Notes |
| --- | --- | --- | --- |
| 14 | DCH-25 | "Production ready" definition spike | Spawns the real production work items — goes before them. |
| 15 | DCH-24 | User documentation | After UI standardization so screenshots don't go stale. |
| 16 | DCH-23 | Performance profiling pass | When something is actually slow, or pre-production. |
| 17 | DCH-13 | Photo-tagging feasibility spike | Flagged likely-expensive; confirm or kill cheaply. |
| 18 | DCH-26 | Lionel website integration | Expansion waits for solid core; needs use-case decision. |
| 19 | DCH-27 | Revive Facebook Marketplace integration | Plugs back into the listing-receiver architecture. |

Housekeeping: move DCH-9 to Done once the spike write-up is reviewed.
