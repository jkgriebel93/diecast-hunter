/**
 * Seller facet on Saved Listings (DCH-44).
 *
 * Sellers aren't a table — they're whatever usernames the loaded rows happen
 * to carry, so the option list is derived from the rows on every render
 * rather than fetched. That keeps it honest: an option can never offer a
 * seller that would return nothing.
 *
 * Selection is a set of {@link SellerKey}. Empty means the facet is off, and
 * multiple keys OR together — the same contract as the checkbox facets in
 * `LISTING_FACETS`. It is rendered as a popover rather than a checkbox list
 * because the list is unbounded: a stack of one row per seller is exactly
 * what DCH-43 had to undo.
 */

/** A seller's identity for filtering: the lower-cased username, or `null`
 *  for rows that have no seller at all. `null` is a real bucket, not an
 *  absence — without it, checking every seller in the list would silently
 *  drop those rows with no way to bring them back. */
export type SellerKey = string | null;

/** Normalize a row's `seller_username` to its filter key. eBay usernames are
 *  case-insensitive, so two spellings must not become two options. */
export function sellerKey(username: string | null | undefined): SellerKey {
  const trimmed = username?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/** Label for the no-seller bucket, in the popover and in the trigger. */
export const NO_SELLER_LABEL = "(no seller)";

export interface SellerOption {
  key: SellerKey;
  /** The username as it was stored, for display. */
  label: string;
  /** How many rows this option would show — see `sellerOptions`. */
  count: number;
}

/** The minimum a row needs to take part. Structural so the tests don't have
 *  to build a whole `ListingRow`. */
export interface HasSeller {
  seller_username: string | null;
}

/**
 * Distinct sellers across the given rows, most listings first.
 *
 * Callers pass the rows that pass *every other* filter, so the counts read as
 * "how many would I see if I picked this seller?" — the same faceted meaning
 * the checkbox facets and the driver picker use. The no-seller bucket is only
 * offered when such a row exists; an option that can only ever show zero rows
 * is noise.
 *
 * Ties break on the display name so the order is stable between renders
 * rather than depending on which row was seen first.
 */
export function sellerOptions(rows: readonly HasSeller[]): SellerOption[] {
  const byKey = new Map<SellerKey, SellerOption>();
  for (const row of rows) {
    const key = sellerKey(row.seller_username);
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    byKey.set(key, {
      key,
      label: key === null ? NO_SELLER_LABEL : row.seller_username!.trim(),
      count: 1,
    });
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}

/** Whether a row survives the seller facet. An empty selection is the facet
 *  being off, not "match nothing". */
export function passesSellerFilter(
  username: string | null,
  selected: ReadonlySet<SellerKey>,
): boolean {
  return selected.size === 0 || selected.has(sellerKey(username));
}

/**
 * What the closed popover says. One seller is worth naming — it's the case
 * where the label alone tells you what you're looking at; past that a count
 * is more legible than a truncated list, and the checkmarks inside are the
 * detail.
 *
 * A selected seller that is no longer among the options still counts: it is
 * narrowing the list (to nothing, usually), and reporting "All sellers" while
 * the screen is empty is the failure the DCH-35 contract exists to prevent.
 */
export function sellerFilterLabel(
  selected: ReadonlySet<SellerKey>,
  options: readonly SellerOption[],
): string {
  if (selected.size === 0) return "All sellers";
  if (selected.size === 1) {
    const [only] = selected;
    const match = options.find((o) => o.key === only);
    if (match) return match.label;
    return only === null ? NO_SELLER_LABEL : only;
  }
  return `${selected.size} sellers`;
}
