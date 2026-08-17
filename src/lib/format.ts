/** Shared numeric display formatting. Kept free of Tauri imports so it can
 *  be unit-tested outside the app shell. */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const COUNT = new Intl.NumberFormat("en-US");

/** "$1,234.56" — money is stored as `*_cents` integers app-wide; this is
 *  the display layer for it. Em dash for missing values. */
export function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return USD.format(cents / 100);
}

/** "12,500" — thousands-separated integer for counts and quantities. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return COUNT.format(n);
}

/** "12,500 results." / "1 result." / "48 of 12,500 results." — the one
 *  vocabulary for result counts on search surfaces (DCH-72), taken from the
 *  Registry page (the reference list screen, DCH-35). The narrowed form
 *  renders only when the filters are actually excluding something, and it
 *  always uses the plural noun — "1 of 3 result" reads as a typo. Irregular
 *  plurals pass both forms ("entry", "entries"). */
export function formatResultCount(
  shown: number,
  total: number,
  one = "result",
  many = `${one}s`,
): string {
  if (shown === total)
    return `${formatCount(total)} ${total === 1 ? one : many}.`;
  return `${formatCount(shown)} of ${formatCount(total)} ${many}.`;
}

/** "1/23/2026, 4:05:00 PM" — a stored Unix timestamp as a local date+time.
 *
 *  Takes *seconds*, because that's what every timestamp column in the schema
 *  holds; the `* 1000` belongs here rather than at eleven call sites.
 *
 *  Em dash for missing values, which is the point of routing through a
 *  helper at all. A NULL `last_synced_at` is an ordinary state, and the
 *  inline form got it wrong two different ways: `undefined * 1000` is NaN
 *  and renders the literal string "Invalid Date", while `null * 1000` is 0
 *  and renders the Unix epoch — a plausible-looking date that is simply not
 *  true. The second is the worse failure, and the harder one to notice. */
export function formatDateTime(unixSeconds: number | null | undefined): string {
  const d = toDate(unixSeconds);
  return d === null ? "—" : d.toLocaleString();
}

/** Shared guard for the three date formatters: null for anything that
 *  wouldn't render as a real date. */
function toDate(unixSeconds: number | null | undefined): Date | null {
  if (unixSeconds === null || unixSeconds === undefined) return null;
  if (!Number.isFinite(unixSeconds)) return null;
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date only ("1/23/2026") and time only ("4:05:00 PM"), for the places
 *  where the other half is noise — a cache-warm date doesn't need a
 *  timestamp, and a token expiry today doesn't need the date. Same missing-
 *  value contract as `formatDateTime`, which is the point of routing through
 *  helpers rather than calling `toLocaleDateString` inline. */
export function formatDate(unixSeconds: number | null | undefined): string {
  const d = toDate(unixSeconds);
  return d === null ? "—" : d.toLocaleDateString();
}

export function formatTime(unixSeconds: number | null | undefined): string {
  const d = toDate(unixSeconds);
  return d === null ? "—" : d.toLocaleTimeString();
}

/** Coarse time until a future event, e.g. "in 2 days", for auction end
 *  times (DCH-20). The card previously rendered a full
 *  `formatDateTime` timestamp — "ends 8/9/2026, 1:39:14 PM" — which is the
 *  wrong shape for scanning a list: what matters is whether it ends soon,
 *  and the exact second only matters in the last hour, when this switches to
 *  minutes anyway.
 *
 *  Returns "ended" for anything in the past, so callers don't need a
 *  separate branch for a listing that closed while the page was open.
 *
 *  `now` is injectable so tests don't depend on the wall clock. */
export function formatUntil(
  unixSeconds: number | null | undefined,
  now: number = Date.now() / 1000,
): string {
  if (unixSeconds === null || unixSeconds === undefined) return "—";
  if (!Number.isFinite(unixSeconds)) return "—";
  const secs = unixSeconds - now;
  if (secs <= 0) return "ended";
  const mins = secs / 60;
  if (mins < 1) return "in under a minute";
  if (mins < 60) return `in ${Math.round(mins)} min`;
  const hours = mins / 60;
  if (hours < 24)
    return `in ${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  const days = hours / 24;
  if (days < 14)
    return `in ${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  return `in ${Math.round(days / 7)} weeks`;
}

/** Coarse age of a past event, e.g. "3 weeks ago", for sold-comp recency.
 *  Deliberately imprecise: the question a comp answers is "is this still the
 *  current market?", not "what date exactly?". Future timestamps clamp to
 *  "today" rather than reading as negative.
 *
 *  `now` is injectable so tests don't depend on the wall clock. */
export function formatAgo(
  unixSeconds: number,
  now: number = Date.now() / 1000,
): string {
  const days = Math.max(0, (now - unixSeconds) / 86400);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${Math.round(days)} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}
