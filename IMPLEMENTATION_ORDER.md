# Implementation order for open DCH tickets

Rev 16, 2026-08-07. Twenty tickets merged. The roadmap's **UI track is finished** (epic DCH-5
closed), **DCH-25 defined what "production ready" means** and spawned DCH-37…41, and
**DCH-30 is verified**.

What's left divides cleanly: five tickets for remote access, five older backlog items, and
one parked story. Everything in the older backlog is Low priority — not an accident of
triage, but the honest state after the substantive work landed.

The ordering principle is unchanged: compounding work — anything that makes later tickets
cheaper or safer — goes before features that only pay off once.

## Next up

| # | Ticket | What | Why here |
| --- | --- | --- | --- |
| 1 | DCH-23 | Performance profiling pass | Findings note plus follow-ups. No known slowness driving it. |
| 2 | DCH-13 | Photo-tagging feasibility | Spike. Flagged likely-expensive; confirm or kill cheaply. |
| 3 | DCH-26 | Lionel website integration | Scope still open — needs a use case before an implementation. |
| 4 | DCH-27 | Revive Facebook Marketplace | Its stated precondition (matching/valuation epics) is met, but the real blocker was never sequencing: FB has no API, and the previous integration was removed deliberately. |
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
