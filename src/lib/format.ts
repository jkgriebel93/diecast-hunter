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
