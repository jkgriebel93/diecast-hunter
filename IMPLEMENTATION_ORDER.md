# Implementation order for open DCH tickets

As of 2026-08-04 (rev 5: DCH-22 shipped and verified on main — installers build; DCH-28
promoted back to #5 because it blocks Worker deploys; DCH-29 added for the CI gates DCH-22
couldn't turn on). DCH-8,
DCH-11, DCH-17, DCH-18, and DCH-22 are merged; DCH-9 (sold-data spike) is Done. Key departure from the roadmap buckets: **DCH-10 moves down a few slots** — the spike
concluded comps build on the DCH-8 archive, which only started accumulating sold prices on
2026-08-03. A few weeks of watchlist syncs make comps v1 immediately useful instead of empty.
Compounding tickets (training data, CI safety) go first.

## Ship now

| # | Ticket | What | Why here |
| --- | --- | --- | --- |
| ~~1~~ | ~~DCH-11~~ | Confirm/correct registry match from the extension | ✅ Shipped (PR #15, merged 2026-08-04). |
| ~~2~~ | ~~DCH-17~~ | Thousands separators | ✅ Shipped (PR #16, merged 2026-08-04). |
| ~~3~~ | ~~DCH-18~~ | Nicer error messages | ✅ Shipped (PR #17, merged 2026-08-04). |
| ~~4~~ | ~~DCH-22~~ | Build pipeline (installer + `cargo test` / `tsc -b` / `pnpm test` gates on main) | ✅ Shipped (PR #19, merged 2026-08-04) and verified on main: all three jobs green, 14 MB msi+nsis artifact per commit. |
| 5 | DCH-28 | Worker: D1 write failures swallowed; stale test asserts the opposite | **Promoted back from #7 (High).** `deploy-worker.yml` gates deploys on `pnpm test`, so this stale test currently **blocks any Worker deploy** — a consequence missed when it was demoted. Still decide the contract (classify errors / absorb retries / keep + alert) before coding; option 3 is ~1h and unblocks deploys immediately. |
| 6 | DCH-10 | Completed-auction comps | By now the archive has weeks of sold data with registry links. ~2–4 days per spike estimate. |

## Contained features

| # | Ticket | What | Notes |
| --- | --- | --- | --- |
| 7 | DCH-15 | Year-range filters | Small, no dependencies. |
| 8 | DCH-29 | Enable the three CI gates DCH-22 left out (rustfmt, clippy, worker tests) | Each fails against main today, so DCH-22 documented rather than added them. Independent — ship separately. The rustfmt one needs a standalone repo-wide reformat commit; the worker-tests one is blocked by DCH-28. |
| 9 | DCH-12 | My Collection entries not in DCR | Needs value-basis decision + DCR-sync-prune safety. |
| 10 | DCH-14 | Saved pre-searches, cached & filtered live | Rides the pre-warm machinery. |
| 11 | DCH-16 | Improve Saved Seller browsing | Write the problem statement first — currently a one-liner. |

## UI track (dependency-fixed order)

| # | Ticket | What |
| --- | --- | --- |
| 12 | DCH-19 | UI audit + standardization guidelines |
| 13 | DCH-20 | Redesign Saved Listing detail panel (follows audit checklist) |
| 14 | DCH-21 | Reorganize Settings screen (follows audit checklist) |

## Later

| # | Ticket | What | Notes |
| --- | --- | --- | --- |
| 15 | DCH-25 | "Production ready" definition spike | Spawns the real production work items — goes before them. |
| 16 | DCH-24 | User documentation | After UI standardization so screenshots don't go stale. |
| 17 | DCH-23 | Performance profiling pass | When something is actually slow, or pre-production. |
| 18 | DCH-13 | Photo-tagging feasibility spike | Flagged likely-expensive; confirm or kill cheaply. |
| 19 | DCH-26 | Lionel website integration | Expansion waits for solid core; needs use-case decision. |
| 20 | DCH-27 | Revive Facebook Marketplace integration | Plugs back into the listing-receiver architecture. |
