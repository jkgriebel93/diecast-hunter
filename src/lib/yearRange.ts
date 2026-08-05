/** Year-range filtering (DCH-15).
 *
 *  Two shapes of consumer, so two shapes of helper:
 *
 *  - **Server-backed searches** (registry search, the Match… dialog) already
 *    send `years: string[]` to a Rust command that turns it into a SQL `IN`
 *    and, for the remote path, into discrete DCR form fields. Rather than add
 *    `year_min` / `year_max` parameters to both paths, a range is *expanded*
 *    into that existing list by [`yearsInRange`]. The DCR form needs discrete
 *    years regardless, so expansion isn't a workaround — it's the shape the
 *    remote search actually wants.
 *  - **Client-side lists** (Collection, Listings) filter rows already in
 *    memory, where a numeric comparison is the natural thing: [`inYearRange`].
 *
 *  Kept free of Tauri and React imports so it can be unit-tested directly.
 */

/** NASCAR's first season. Mirrors `EARLIEST_YEAR` in `tauri.ts`, which bounds
 *  the year dropdowns; re-declared here to keep this module dependency-free. */
export const EARLIEST_YEAR = 1948;

/** An open-ended year range. `null` on either side means "unbounded that
 *  way", so `{from: 1998, to: null}` reads as "1998 or later". */
export interface YearRange {
  from: number | null;
  to: number | null;
}

export const EMPTY_YEAR_RANGE: YearRange = { from: null, to: null };

/** Parse a year out of a dropdown value. Returns null for blanks and for
 *  anything non-numeric or implausible, so a malformed option can never
 *  silently become a bound. */
export function parseYear(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  // Upper bound is generous: registry entries can be a model year ahead of
  // the calendar, and this only needs to reject garbage.
  if (n < EARLIEST_YEAR || n > 2200) return null;
  return n;
}

/** True when no bound is set — i.e. the filter is inactive. */
export function isEmptyRange(range: YearRange): boolean {
  return range.from === null && range.to === null;
}

/** Put the bounds in order.
 *
 *  A user who picks From 2003 / To 1998 means the same span as 1998–2003, and
 *  silently swapping is friendlier than showing zero results and making them
 *  work out why. Every consumer normalizes before comparing, so the UI can
 *  leave the two dropdowns independent. */
export function normalizeRange(range: YearRange): YearRange {
  const { from, to } = range;
  if (from !== null && to !== null && from > to) return { from: to, to: from };
  return { from, to };
}

/** Does a single year fall inside the range? A null year (unknown) is
 *  excluded whenever any bound is set — "1998–2003" shouldn't return rows we
 *  can't date — but passes when the filter is inactive. */
export function inYearRange(
  year: number | null | undefined,
  range: YearRange,
): boolean {
  const { from, to } = normalizeRange(range);
  if (from === null && to === null) return true;
  if (year === null || year === undefined) return false;
  if (from !== null && year < from) return false;
  if (to !== null && year > to) return false;
  return true;
}

/** Expand a range into the subset of `options` that falls inside it.
 *
 *  Intersecting with the caller's option list (rather than generating every
 *  integer between the bounds) means we only ever send years the source
 *  actually offers, and keeps the payload proportional to real data instead
 *  of to the width of the range. Order follows `options`, which the year
 *  dropdowns already sort newest-first.
 *
 *  Returns [] for an inactive range — callers treat that as "no year filter",
 *  the same as before this existed. */
export function yearsInRange(options: string[], range: YearRange): string[] {
  if (isEmptyRange(range)) return [];
  return options.filter((opt) => inYearRange(parseYear(opt), range));
}

/** Short human label for the active range, e.g. "1998–2003", "1998 or later",
 *  "up to 2003". Null when nothing is set. */
export function describeRange(range: YearRange): string | null {
  const { from, to } = normalizeRange(range);
  if (from === null && to === null) return null;
  if (from !== null && to !== null) {
    return from === to ? `${from}` : `${from}–${to}`;
  }
  if (from !== null) return `${from} or later`;
  return `up to ${to}`;
}
