# Implementation order for open DCH tickets

As of 2026-08-06 (rev 11: DCH-19's audit done, DCH-16 parked, DCH-30 deployed pending its
console verification). Fourteen tickets are merged — DCH-8, DCH-9, DCH-10, DCH-11, DCH-12,
DCH-14, DCH-15, DCH-17, DCH-18, DCH-22, DCH-28, DCH-29, DCH-30, DCH-31 — and DCH-19 spawned
four follow-ups, so the open list is eleven substantive items plus the roadmap buckets.

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
| DCH-30 | Worker reports `deletion_insert_failed` to Sentry. Cloudflare cannot alert on a discrete log event, so the alert had to come from the Worker itself. |
| DCH-19 | UI audit. Confirmed the app is broadly consistent; the divergence is modals, destructive actions, helper adoption, and filter rows. Spawned DCH-32…35. |
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
| 1 | DCH-32 | Shared `Modal` component | The audit's biggest finding. Eleven hand-built dialogs, four z-layers, Escape on only two. Do it before DCH-20/21, which both add dialogs. |
| 2 | DCH-33 | `.btn-danger` / `.link-danger` | Small, and DCH-20 needs it — the listing panel is full of destructive actions with no shared treatment. |
| 3 | DCH-35 | Filter-row parity | "Clear filters" exists on one screen of seven. |
| — | DCH-36 | `ErrorBanner` retitles authored prose | Filed from DCH-34. Order it with DCH-32/33 if a shared notice variant falls out of that work; it's a presentation decision, not a mechanical fix. |

**DCH-34 is done**, and half of it was a false alarm worth recording, because the same
mistake is easy to repeat when reading the audit's other findings.

The audit reported "21 hand-rolled error divs". That number came from counting `text-red-*`
occurrences, and almost all of them are `hover:text-red-400` on destructive icon buttons —
which is **DCH-33's** subject, not DCH-18's. Exactly one genuine hand-rolled error box
existed (`ManualEntryDialog`'s save failure, added by DCH-12 after the helper landed). The
"visible defect today" framing in the ticket was wrong; `ErrorBanner` adoption was already
essentially complete. Treat the audit's other raw-grep counts (DCH-33's especially) as
upper bounds until someone eyeballs the hits.

The `formatCount` half was real, and bigger than stated once dates were separated out: of
the 19 `toLocaleString()` calls, 8 were counts and 11 were `new Date(x * 1000)`. The date
half had a live bug — a null timestamp coerces to 0 and renders the Unix epoch as a
plausible-looking sync time — so `formatDateTime` is new in `lib/format.ts` and all 19 sites
now route through a helper.

Both rules are now enforced by `src/lib/conventions.test.ts` rather than by review. That is
the part worth copying: DCH-17 and DCH-18 each shipped a helper and were quietly bypassed
for months, and a checklist line would not have caught the twentieth violation either.

**DCH-16 is parked** (On Hold). The original complaint was forgotten and never written down;
rather than invent one, wait and see whether the UI track resolves it. Reasoning and the
technical context are on the ticket.

DCH-30 turned out **not** to be dashboard config: Cloudflare has no way to alert on a
discrete log event — Workers Logs can't alert at all, and Notifications alert types are
threshold-shaped. The Worker now reports `deletion_insert_failed` to Sentry itself, and is
deployed. What remains is running `POST /api/test-alert` against it and confirming the mail
arrives — the "observed firing" criterion.

`registry_entries.source` is new as of DCH-12, and it is now the guard every DCR-facing
registry flow relies on. Anything added later that walks `registry_entries` and then talks to
diecastregistry.com about what it found needs `source <> 'local'` — a manual entry has no
detail page, so a lookup for one either 404s or, worse, matches something else.

## UI track (dependency-fixed order)

DCH-19 is done. Its output is the [UI Audit and Standardization
Guidelines](https://thistlegrow.atlassian.net/wiki/spaces/DCH/pages/51183617) page, whose
conventions checklist is what the two redesigns execute against.

Do DCH-32/33 (shared `Modal`, danger classes) **before** these two: both redesigns add
dialogs and destructive actions, and building them against the hand-rolled patterns would
mean redoing the work.

| # | Ticket | What |
| --- | --- | --- |
| 4 | DCH-20 | Redesign Saved Listing detail panel — 5,626 lines, the audit's worst offender on every axis |
| 5 | DCH-21 | Reorganize Settings screen — 21 buttons with no hierarchy between sections |

## Later

| # | Ticket | What | Notes |
| --- | --- | --- | --- |
| 6 | DCH-25 | "Production ready" definition spike | Spawns the real production work items — goes before them. |
| 7 | DCH-24 | User documentation | After UI standardization so screenshots don't go stale. |
| 8 | DCH-23 | Performance profiling pass | When something is actually slow, or pre-production. |
| 9 | DCH-13 | Photo-tagging feasibility spike | Flagged likely-expensive; confirm or kill cheaply. |
| 10 | DCH-26 | Lionel website integration | Expansion waits for solid core; needs use-case decision. |
| 11 | DCH-27 | Revive Facebook Marketplace integration | Plugs back into the listing-receiver architecture. |

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
