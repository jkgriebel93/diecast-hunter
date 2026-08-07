# Implementation order for open DCH tickets

As of 2026-08-07 (rev 15: the whole UI track merged (DCH-20, 21, 32, 33, 34, 35), DCH-36 filed, DCH-16 parked, DCH-30
deployed pending its console verification). Seventeen tickets are merged — DCH-8, DCH-9,
DCH-10, DCH-11, DCH-12, DCH-14, DCH-15, DCH-17, DCH-18, DCH-22, DCH-28, DCH-29, DCH-30,
DCH-31, DCH-32, DCH-33, DCH-34, DCH-35 — and DCH-19 spawned five follow-ups, of which only
DCH-36 is open. The list is seven substantive items plus the roadmap buckets.

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
| 1 | DCH-36 | `ErrorBanner` retitles authored prose | Filed from DCH-34. A presentation decision, not a mechanical fix. `Modal` now exists, so a notice variant has somewhere obvious to live. |

**DCH-21 is done, and the roadmap's UI work with it.** Settings is four tabs — Accounts,
Sync, Search & matching, Extension — with the choice persisted so you reopen where you left.

The tabs are the visible part; the substantive change is underneath. Two cards were doing
more than one job: the diecastregistry.com card held the sign-in *and* four registry
maintenance tools, and the eBay card held API keys *and* two search preferences. Every
sub-block is now its own card, filed by what it is rather than by which integration it
happened to arrive with — credentials for both services together, registry tools under Sync,
search preferences under Search.

The ticket suggested an "Appearance/Display" group. There is nothing to put in it: theme and
font scale live in the sidebar footer and aren't Settings state at all. Moving them would be
a change to where those controls live, which is a different decision from organizing what's
already here.

**DCH-20 is done.** The Saved Listing card is collapsed by default and its expanded state
is three labelled groups (match & valuation / details / actions) instead of seven flat rows.

Two things worth knowing. The accordion was **mostly already built** — `useMinimized` and
`MinimizeToggle` already existed and `ListingCard` already hid most of itself when minimized;
what was missing was the default, a collapsed row worth scanning, and any grouping in the
expanded state. And `lib/minimized.tsx` changed shape: it stores an explicit
`key -> boolean` map (`minimized-items.v2`) rather than a set of collapsed keys, because
"absent" and "expanded" are not the same thing once one page wants a different default from
another. There's a v1 migration and tests for it — a bug there would silently spring every
collapsed card open.

**The whole DCH-19 follow-up set is now closed** (DCH-32/33/34/35). The UI has a shared
`Modal`, danger classes, formatting helpers and a filter contract, all enforced by
`src/lib/conventions.test.ts` rather than by review.

**DCH-35 is done, and its headline claim was wrong.** The ticket led with "Clear filters
exists on exactly one screen" and called it the highest-value item. Three screens had one:
Collection ("Clear filters", conditional), Listings ("Clear all filters", always visible) and
Seller feed ("Reset", always visible). The audit's table also said Seller feed had no search
box; it has had one all along. The real gaps were Registry, Browse and Wishlist — three
screens, not six — plus normalizing the three that already existed to one label and one
visibility rule.

That makes **four for four** on checking the audit's numbers first: DCH-34 inflated, DCH-32
slightly pessimistic, DCH-33 accurate, DCH-35 overstated. The habit has paid for itself every
time; DCH-20's "5,626 lines, worst on every axis" is the next claim worth measuring before
planning against it.

Two constraints worth not rediscovering:

*eBay sort values are wire format.* Browse, Seller feed and Saved searches send `sort`
straight to the Browse API, and Saved searches persists it in SQLite. Renaming those to
`field-asc` would break the request and every saved row, so they keep eBay's values — their
labels already followed the vocabulary. `sortOptions.ts` states the exemption once, and the
convention test reads it from there.

*Wishlist filtering and drag-reorder can't both be live.* Reordering a filtered subset would
write that partial order back over the full list. Dragging is disabled while a search is
active, ranks shown are the entry's true stack-rank rather than its position in the subset,
and the UI says why.

**DCH-33 is done**, and it clears the last dependency on the two redesigns: `Modal` and the
danger classes both exist, so DCH-20 and DCH-21 can start whenever you want them.

Its numbers were the accurate ones — 10 / 6 / 6, essentially as the audit reported. That
makes three for three on "verify the count first": DCH-34's was inflated, DCH-32's was
slightly pessimistic, and this one held.

Two decisions worth not re-deriving:

*Severity picks the confirmation; form picks the class.* The ticket coupled them
(irreversible → `.btn-danger`, reversible → `.link-danger`), which doesn't survive contact:
Collection's Remove is irreversible but sits inline beside a plain-text "Edit", where a solid
button would be absurd. So the rule is now two independent questions — rendered as a button →
`.btn-danger`, rendered as inline text or a bare icon → `.link-danger`; irreversible →
confirm naming what dies, reversible → don't. Every criterion still holds.

*The red shade is measured, not chosen by eye.* A destructive button must not read as fainter
than `.btn-primary` beside it, and the obvious red-600 fails that in dark mode — 4.03 WCAG
contrast against the page versus accent's 5.29. The ramp is red-500 in dark and red-700 in
light, both of which clear it. If the danger tokens are ever retuned, re-measure rather than
eyeballing; the failure is invisible in one theme.

**DCH-32 is done.** `src/components/Modal.tsx` owns every dialog; ten call sites across six
files migrated. Two things about it are worth knowing before touching dialogs again:

*The stacking layer is derived, not declared.* `GroupEditorDialog` is opened both from the
Listings toolbar and from inside `ManageGroupsDialog`, so a `layer` prop would have to differ
per call site and would be wrong the first time a third site appeared. `src/lib/modalStack.ts`
tracks which dialogs are open; `Modal` reads its own depth from it. That same stack is what
makes Escape close only the topmost dialog — every open modal has a `window` keydown
listener, so without it one Escape collapses the whole stack. Keeping the stack a plain module
of pure functions is what let the tricky part be unit-tested at all.

*Top-aligned dialogs were converted deliberately.* Seven of the ten were `items-start` with
four different `pt-` values; three were centred. Everything is centred now. The tall ones
(`max-h-[85vh]`, `h-[92vh]`) look identical either way; the short ones genuinely moved, and
that was the call rather than an accident — the ticket's last criterion asked for it to be one
or the other on purpose.

The audit was accurate here, unlike DCH-34's half — with two small exceptions recorded on the
ticket: backdrop-click was already present on SavedSearches and SellerFeed (via
`stopPropagation`, not absent as reported), and Wishlist's "Escape" was an input-level
`onKeyDown` on a rename field, not dialog dismissal. So Escape genuinely worked in **one** of
ten dialogs before this, not two.

**DCH-34 is done**, and half of it was a false alarm worth recording, because the same
mistake is easy to repeat when reading the audit's other findings.

The audit reported "21 hand-rolled error divs". That number came from counting `text-red-*`
occurrences, and almost all of them are `hover:text-red-400` on destructive icon buttons —
which is **DCH-33's** subject, not DCH-18's. Exactly one genuine hand-rolled error box
existed (`ManualEntryDialog`'s save failure, added by DCH-12 after the helper landed). The
"visible defect today" framing in the ticket was wrong; `ErrorBanner` adoption was already
essentially complete. The lesson generalized: check the audit's raw-grep counts against the
actual hits before planning. (DCH-33's later turned out to be accurate — the point is that
you can't tell which without looking.)

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

## UI track

The dependency ordering this section used to express is satisfied: DCH-32 gave the redesigns
`Modal`, DCH-33 gave them the danger classes, DCH-34 the formatting helpers and DCH-35 the
filter contract — the four things DCH-20 and DCH-21 would otherwise have had to redo. Both
now sit in "Next up" above.

The standing reference is the [UI Audit and Standardization
Guidelines](https://thistlegrow.atlassian.net/wiki/spaces/DCH/pages/51183617) page, but the
conventions themselves are in `CLAUDE.md` and enforced by `src/lib/conventions.test.ts` —
read those first; they're the ones that fail a build.

## Later

| # | Ticket | What | Notes |
| --- | --- | --- | --- |
| 4 | DCH-25 | "Production ready" definition spike | Spawns the real production work items — goes before them. |
| 5 | DCH-24 | User documentation | After UI standardization so screenshots don't go stale. |
| 6 | DCH-23 | Performance profiling pass | When something is actually slow, or pre-production. |
| 7 | DCH-13 | Photo-tagging feasibility spike | Flagged likely-expensive; confirm or kill cheaply. |
| 8 | DCH-26 | Lionel website integration | Expansion waits for solid core; needs use-case decision. |
| 9 | DCH-27 | Revive Facebook Marketplace integration | Plugs back into the listing-receiver architecture. |

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
