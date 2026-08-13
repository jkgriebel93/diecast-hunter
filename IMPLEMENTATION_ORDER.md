# Implementation order for open DCH tickets

Rev 19, 2026-08-13. **DCH-56 shipped**: the watchlist sync now skips no-change
`listing_history` observations, and a one-time migration collapsed the 97.4% of existing
rows that recorded nothing (keeping each run's first + last row so spans survive). Epic
**DCH-62** (from the DCH-23 [findings
note](https://thistlegrow.atlassian.net/wiki/spaces/DCH/pages/53018626)) remains the front
of the queue; DCH-53 (rev 17) and DCH-55 (rev 18) are already in.

The ordering principle is unchanged: compounding work — anything that makes later tickets
cheaper or safer — goes before work that only pays off once.

## Performance epic (DCH-62) — the remaining six

No Jira links between these; the dependencies below are code-level. Three tracks: DCR
traffic (57, 61), sync efficiency (54), frontend + startup (58, 59, 60).

| # | Ticket | What | Why here |
| --- | --- | --- | --- |
| 1 | DCH-54 | One `EbayClient` per watchlist sync | High priority, sequenced after 55/56 because all three touch `ebay_watchlist`/`ebay_listing` — this completes the eBay-sync work in one contiguous stretch. Its AC asks for before/after timings, which are only meaningful now that 55's commit overhead is gone. |
| 2 | DCH-57 | Reuse the cached DCR session | Extends the session cache to prewarm, presearch, form-options and the auto-sync — the same `auto_sync.rs` neighborhood DCH-53 just modified. Also fixes the double page-walk on zero-result searches. |
| 3 | DCH-61 | Loosen the 800 ms DCR rate floor | Deliberately last on the DCR track: it's a politeness-policy decision, not a bug fix, and it reshapes the same `dcr/client.rs` limiter 57 works around. With 53's cap and 57's session reuse in, this is the remaining multiplier on walk time. Low priority — skippable if DCR politeness feels wrong. |
| 4 | DCH-58 | Listings page: keystroke + mutation work | Biggest frontend payoff (the page everyone lives in), and it establishes the patterns 59 and 60 consume: `memo` + deferred search, mutations returning the updated row, `detail_url` promoted out of `raw_json`. |
| 5 | DCH-59 | Registry results: bound + memoize | Same medicine as 58 (`useDeferredValue`, `React.memo`, bounded lists) applied to Registry — cheaper done immediately after, while the patterns are fresh and reusable. |
| 6 | DCH-60 | Startup: defer + scope the backfill | Last because it consumes both sides: 55's batched backfill writes (now in) and 58's shared `list_listings` result are two of its acceptance criteria's building blocks. What remains is the scoping (37 MB `raw_json` scan → only-unattributed rows) and `spawn_blocking` hygiene. |

Track note: the two frontend tickets (58, 59) share no files with the backend track, so if a
backend PR is waiting on review, 58 can start early without rebasing risk.

## Next up (after the epic)

| # | Ticket | What | Why here |
| --- | --- | --- | --- |
| 1 | DCH-13 | Photo-tagging feasibility | Spike. Flagged likely-expensive; confirm or kill cheaply. |
| 2 | DCH-26 | Lionel website integration | Scope still open — needs a use case before an implementation. |
| 3 | DCH-27 | Revive Facebook Marketplace | Its stated precondition (matching/valuation epics) is met, but the real blocker was never sequencing: FB has no API, and the previous integration was removed deliberately. |
| — | DCH-42 | Database backup and restore | Filed from DCH-25. Only the manually-entered slice is genuinely at risk — DCR data re-syncs — but the sold-listings archive can't be backfilled at all. |

**DCH-16 is parked** (On Hold). The original complaint was forgotten and never written down.
Rather than invent one, wait and see whether the UI track resolved it.

## Remote access (DCH-25's output)

Deferred by decision on 2026-08-07 until the older backlog above is done. Full reasoning:
[What "production ready" means, and the read-only mobile
path](https://thistlegrow.atlassian.net/wiki/spaces/DCH/pages/51609602).

The short version: the goal is reaching the data from a phone, and **sync doesn't deliver
that**. Syncing SQLite gives you two desktops that each run the full Rust backend; a phone
can't run that backend at all. So the desktop stays the source of truth and publishes a
read-only projection.

| Ticket | What | Note |
| --- | --- | --- |
| DCH-37 | Publish a snapshot from the desktop | **Measure the real database first** — its size decides DCH-38's transport |
| DCH-38 | Worker: receive, store, serve it | Also decides same-Worker-or-separate from the deletion records |
| DCH-39 | Auth for the mobile view | **High.** Gates DCH-40 in practice |
| DCH-40 | The mobile read-only view | Collection, wishlist, comps |
| DCH-41 | Spike: full-use architecture | Deliberately not started until there's evidence reading isn't enough |

## What shipped

| Ticket | Outcome |
| --- | --- |
| DCH-8 | Ended/removed listings archive with an `end_reason`. **This is the comps data source.** |
| DCH-9 | Spike: every external sold-price source is closed to us. Build on the archive. |
| DCH-10 | Sold-price comps on the Listings page and the extension overlay. |
| DCH-11 | Confirm/correct registry match from the extension. |
| DCH-12 | Manually-added collection entries. Introduced `registry_entries.source`. |
| DCH-14 | Named registry pre-searches, refreshed by the overnight auto-sync. |
| DCH-15 | Year-range filters on registry search, Match…, Listings, Collection. |
| DCH-17 | Thousands separators via shared `Intl.NumberFormat` helpers. |
| DCH-18 | Error translation layer + `ErrorBanner`. |
| DCH-19 | UI audit. Spawned DCH-32…35. |
| DCH-20 | Listing card collapsed by default; expanded state grouped into three. |
| DCH-21 | Settings in four tabs, each concern its own card. |
| DCH-22 | CI: installers on main, plus build/test gates. |
| DCH-25 | Defined "production ready". Corrected the goal from sync to remote read. |
| DCH-28 | Worker deletion-write contract: bounded retry, honest outcome log. |
| DCH-29 | rustfmt / clippy / prettier / worker-test gates. Tree is clean against all four. |
| DCH-30 | Worker reports `deletion_insert_failed` to Sentry. Cloudflare cannot alert on a discrete log event, so the alert had to come from the Worker itself. |
| DCH-31 | Cross-platform extension packaging, built and uploaded by CI on every run. |
| DCH-32 | Shared `Modal`; ten hand-built dialogs migrated. |
| DCH-33 | `.btn-danger` / `.link-danger` and one red ramp. |
| DCH-34 | `formatCount` / `formatDateTime` adoption; the `String(e)` prefix fix. |
| DCH-35 | Filter contract and one sort vocabulary across seven list screens. |
| DCH-36 | `NoticeBanner` — a third message channel for authored prose. |
| DCH-24 | [User guide](https://thistlegrow.atlassian.net/wiki/spaces/DCH/pages/51609624) in Confluence — five pages, written against the standardized UI. |
| DCH-43 | Collapsible facet sections on Saved Listings' filter sidebar. Added the dev-only screenshot harness (`docs/screenshots/README.md`). |
| DCH-44 | Seller facet on Saved Listings, as a popover. Moved **Clear filters** into the panel header. |
| DCH-45 | Bulk **Add to wishlist** from Select mode, with inline list creation. Bulk bar messages now carry a tone. |
| DCH-46 | Share a wishlist by public link via the Worker, plus a zero-infra **Copy as text**. First app→Worker channel. |
| DCH-47 | Saved Listings' filter panel rebuilt as a scrolling accordion (Design A): every section collapses with a summary in its header, the middle scrolls, search and **Clear filters** are pinned. Shared `AnchoredMenu` for the three filter dropdowns. |
| DCH-48 | **Share selection…** on Saved Listings — an ad-hoc set of listings published through the DCH-46 pipeline. New `shares` table, `render_listings`, and an Active links card in Settings. The Worker needed no changes. |
| DCH-23 | Performance profiling pass against the production DB (2026-08-12). [Findings note](https://thistlegrow.atlassian.net/wiki/spaces/DCH/pages/53018626) records method and measurements; also records what was measured-and-fine (local search SQL, the `list_listings` join, the comps design). Spawned epic DCH-62 (DCH-53…61). |
| DCH-53 | Capped + prioritized DCR enrichment (`auto_sync.enrich_max_entries`, default 500). Referenced entries (collection, listing match, wishlist) first, oldest first; unreferenced prewarm stubs are enriched once, never re-refreshed — the standing ~47k-requests/month re-walk is gone, not just spread out. Force refresh all remains uncapped. |
| DCH-55 | `synchronous=NORMAL` under WAL; hot sync loops write in transactions (per garage page, 100-row batches for prewarm/presearch, one tx for watchlist archival, 200-row batches for the driver backfill); the shared `driver_upsert` collapses INSERT+SELECT to `RETURNING id` behind a per-run memo. Cancel checks sit between batches, so no long uncancellable transaction. |
| DCH-56 | `listing_history` only records change: an observation identical to the listing's latest row (price, shipping, status — NULLs compare equal) is skipped; first observations and reverts still write. Migration 0031 collapsed existing runs to first + last row each. The table is still write-only — nothing reads it yet — so the sparser shape constrains nothing. |

## Things worth not rediscovering

**Verify a ticket's numbers before planning against them.** Five for five during the UI
track: DCH-34's counts were inflated (its "21 hand-rolled error divs" were mostly
destructive-button hovers, i.e. DCH-33's subject), DCH-32's were slightly pessimistic, DCH-35
overstated its headline finding ("Clear filters exists on exactly one screen" — three had
one), and DCH-33's and DCH-20's held up. You can't tell which without looking, and looking
costs minutes.

**The UI conventions are enforced, not agreed.** Twelve rules in `src/lib/conventions.test.ts`
cover formatting helpers, `ErrorBanner`, `Modal`, the z-scale, danger classes, the sort
vocabulary, and authored-prose routing. Each was confirmed to fail on an injected violation.
This matters because DCH-17 and DCH-18 both shipped helpers that were quietly bypassed for
months under review alone. Read `CLAUDE.md` for the rules; the tests are what stop a
regression.

**`registry_entries.source` is the guard every DCR-facing flow relies on.** Anything that
walks `registry_entries` and then asks diecastregistry.com about what it found needs
`source <> 'local'` — a manual entry has no detail page, so a lookup either 404s or, worse,
matches something else.

**eBay sort values are wire format.** Browse, Seller feed and Saved searches send `sort`
straight to the Browse API, and Saved searches persists it in SQLite. They are exempt from
the `field-asc` vocabulary; `lib/sortOptions.ts` states that once and the convention test
reads it from there.

**Comps skew low by design.** A comp is the *last observed* price, not a receipt — an auction
synced before it closed records the bid at sync time. The archive only began recording sold
prices on 2026-08-03, so coverage is still thin and the Listings page falls back to registry
retail. That's the pre-DCH-10 behaviour, not a broken state.

**A sticky panel's height is a hard budget, and managing the budget was the wrong fix.**
DCH-43 and DCH-44 both treated the Listings filter sidebar's resting height as the lever:
collapse what's off by default, tighten the rhythm, move **Clear filters** somewhere safer.
Each bought room and none bought a bound, so DCH-44's Seller section put the panel back over
the fold within a day. The reason the obvious fix — cap it and let it scroll — was rejected
twice is that the three filter dropdowns were `position: absolute` *inside* the panel, so an
`overflow` on their scroll parent clipped them. DCH-47 moved them to `position: fixed` first
(`lib/anchoredMenu.ts`), which made the scroller free, and the budget stopped existing.
The general shape: when a layout constraint keeps costing you, check whether one dependency
is what makes it a constraint at all.

**Percentage heights don't work against a flex-sized parent.** `flex-1 min-h-0` on a box and
`h-full overflow-y-auto` on the scroller inside it looks tidier than putting both on one
element, and silently doesn't work: the parent has no *specified* height, so the child's
`height: 100%` is indefinite and falls back to the content's own height. The result is a
scroller exactly as tall as its contents — no scrollbar, no overflow, and the clipping done
by whatever ancestor has `overflow-hidden`. It looks identical to the bug you were fixing.

**A `fixed` menu still lives in the DOM where you rendered it.** Fixed positioning escapes an
ancestor's *clipping*, but not its *scrolling*: autofocusing an input inside a menu rendered
in a scroller's subtree makes the browser scroll that ancestor to "reveal" an element that
never moved, so the panel jumps every time a menu opens. Portal to `document.body`.

**Measure the panel at 520px, not 700px, with the screenshot harness.** 700px is where the
old panel broke; the current one has to hold at any height, and the interesting failures
(footer past the fold, floor on the scroll region) only appear well below that.

**A share is a document, so the Worker never learns what's in it.** `/api/share`
takes an HTML blob and a TTL, which is why DCH-48 added a second share *kind* without
touching `worker/` at all. Anything new that wants a public link needs a renderer and a
row — not an endpoint. The two things that are not negotiable on that page: every URL
that reaches an `href` goes through `export::safe_http_url` (it is served from the
user's own domain, so a bad URL there is stored XSS), and anything the app *inferred*
rather than copied from the source — deal score, comps — is off unless the dialog
explicitly turned it on.

**A refused clipboard is not an error.** It surfaced in the headless screenshot run,
where `navigator.clipboard` always fails: the share had been published, the link was on
screen, and the dialog said "Something went wrong." Copy failures are partial success
(`NoticeBanner` `tone="warning"`), and the same defect still exists in
`ShareWishlistDialog` from DCH-46 — left alone because DCH-48's acceptance criteria said
wishlist sharing was unchanged.

**`cargo fmt` and `pnpm format` are safe repo-wide.** DCH-29 landed one mechanical commit per
formatter, so neither rewrites untouched files. Use `pnpm format`, not `npx prettier` — the
latter resolves an unpinned version.

## Open items that aren't tickets

- ~~Cloudflare alert on `deletion_insert_failed`~~ — became **DCH-30**, then stopped being a
  Cloudflare thing at all. Verified end to end on 2026-08-07; evidence is on the ticket. One
  thing it could not prove: the **fingerprint is untested**, because that was the first
  occurrence. If two separate `DeletionInsertFailed` issues ever appear in Sentry, that's the
  bug.
- ~~Roadmap buckets DCH-2 … DCH-7 may be closeable~~ — **DCH-5 closed 2026-08-07**, all nine
  children done. DCH-2 was already closed. DCH-3, DCH-4, DCH-6 and DCH-7 each still have an
  open child.
- ~~Extension needs repackaging~~ — solved by **DCH-31**. CI uploads a
  `diecast-hunter-extension-<sha>` artifact on every run. Installing it is still a manual
  load-unpacked step; Chrome Web Store publishing was explicitly out of scope.
- ~~Backup and restore is only half-solved~~ — filed as **DCH-42**. A published snapshot is an
  off-machine copy of the *display* data, but it excludes `raw_json` and settings, so it is
  not a restore path. The ticket also records the WAL trap: copying the `.sqlite` file while
  the app runs can miss committed data still in the `-wal`.
