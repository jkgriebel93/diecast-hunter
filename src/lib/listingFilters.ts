// Filtering and faceting for the Saved Listings page (DCH-58).
//
// Split out of Listings.tsx for two reasons: the per-facet predicates and
// the one-pass facet aggregation are pure and worth unit-testing, and the
// page previously answered every facet count with its own full pass over
// the rows (~15 passes per keystroke at 1,000+ listings). The shape here is
// one predicate per facet, composed by `passesFacetFilters`, and
// `computeListingFacetData` walking the rows once to produce every count
// the sidebar needs.
//
// Search text is deliberately NOT part of the facet-filter state: the page
// applies it first via a precomputed per-row haystack (`buildSearchHaystack`,
// built once per load, not per keystroke) and hands the already-searched
// rows to these functions.

import type { ListingRow, ReceivedOffer } from "@/lib/tauri";
import { passesSellerFilter, type SellerKey } from "@/lib/sellerFilter";
import { inYearRange, type YearRange } from "@/lib/yearRange";

export type StatusOption = "active" | "ended" | "archived";
/** "confirmed"/"unconfirmed" split matched listings by user verification;
 *  "unmatched" = no registry entry (including user-marked no-match rows). */
export type MatchOption = "confirmed" | "unconfirmed" | "unmatched";
export type OfferOption = "unresponded" | "with" | "without";
/** Buying-format facet. "bin" = fixed price that does NOT take offers;
 *  "offers" = accepts Best Offers (fixed or auction). */
export type TypeOption = "auction" | "bin" | "offers";

/** Everything the sidebar can narrow by, minus search text (see module doc). */
export interface ListingFacetFilters {
  status: Set<StatusOption>;
  match: Set<MatchOption>;
  offer: Set<OfferOption>;
  type: Set<TypeOption>;
  /** "all" = no group filter; "none" = zero groups; else a group id string. */
  group: string;
  excluded: Set<number>;
  /** "all", "none", or `d:<lowercased driver name>`. */
  driver: string;
  seller: Set<SellerKey>;
  /** Bounds on the matched registry entry's year; unset = no year filter. */
  year: YearRange;
  offersByItemId: Map<string, ReceivedOffer>;
}

/** Listings table stores eBay item ids as v1|<legacy>|0; the messages
 *  API returns just the legacy segment, so we extract it for lookups. */
export function legacyIdFromExternalId(external_id: string): string {
  const parts = external_id.split("|");
  return parts.length >= 2 && /^\d+$/.test(parts[1]) ? parts[1] : external_id;
}

/** The row's searchable text, lower-cased. Built once per row per load and
 *  cached by the page — never rebuilt per keystroke. */
export function buildSearchHaystack(row: ListingRow): string {
  return [
    row.title,
    row.matched_driver_name,
    row.matched_scheme_text,
    row.seller_username,
    row.matched_oem,
    row.matched_brand,
    row.oem,
    row.brand,
    row.finish,
    row.make,
    row.part_number,
    row.is_race_win && "race win",
    row.is_autographed && "autograph autographed",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// ----- per-facet predicates, one per sidebar section -----
// Archived is its own status bucket: "Ended" means ended-but-not-yet-archived
// (a transient state between enrichment and the sync's archive pass), so the
// default active-only filter keeps archived history out of the deal-hunting
// views until explicitly requested.

export function passesStatus(
  row: ListingRow,
  status: Set<StatusOption>,
): boolean {
  if (status.size === 0) return true;
  return (
    (status.has("active") && row.status === "active") ||
    (status.has("ended") && row.status === "ended" && !row.is_archived) ||
    (status.has("archived") && row.is_archived)
  );
}

export function passesMatch(row: ListingRow, match: Set<MatchOption>): boolean {
  if (match.size === 0) return true;
  const matched = row.registry_entry_id !== null;
  return (
    (match.has("confirmed") && matched && row.match_user_confirmed) ||
    (match.has("unconfirmed") && matched && !row.match_user_confirmed) ||
    (match.has("unmatched") && !matched)
  );
}

export function passesType(row: ListingRow, type: Set<TypeOption>): boolean {
  if (type.size === 0) return true;
  return (
    (type.has("auction") && row.listing_type === "auction") ||
    (type.has("bin") && row.listing_type === "fixed" && !row.accepts_offers) ||
    (type.has("offers") && row.accepts_offers)
  );
}

export function passesOffer(
  row: ListingRow,
  offer: Set<OfferOption>,
  offersByItemId: Map<string, ReceivedOffer>,
): boolean {
  if (offer.size === 0) return true;
  const o = offersByItemId.get(legacyIdFromExternalId(row.external_id));
  const hasOffer = o !== undefined;
  // Heuristic for "user already responded": either the notification was
  // opened (eBay flips <Read> on the inbox UI when you open the message —
  // which the web accept/decline flow does), or the underlying listing has
  // ended (signal that the offer was accepted and the item sold).
  // Conservative: a missing listing is treated as "still active" so users
  // who haven't run watchlist sync still see their offers.
  const responded = hasOffer && (o.is_read || row.status === "ended");
  return (
    (offer.has("with") && hasOffer) ||
    (offer.has("without") && !hasOffer) ||
    (offer.has("unresponded") && hasOffer && !responded)
  );
}

/** The driver filter matches the registry-match driver first, then the
 *  auto/manual tag — the same precedence the by-driver view uses. */
export function passesDriverFilter(row: ListingRow, driver: string): boolean {
  if (driver === "all") return true;
  const name = row.matched_driver_name ?? row.auto_driver_name;
  if (driver === "none") return name === null;
  return name !== null && `d:${name.toLowerCase()}` === driver;
}

export function passesGroupFilter(row: ListingRow, group: string): boolean {
  if (group === "all") return true;
  if (group === "none") return row.group_ids.length === 0;
  return row.group_ids.includes(Number(group));
}

export function passesExcludedGroups(
  row: ListingRow,
  excluded: Set<number>,
): boolean {
  if (excluded.size === 0) return true;
  return !row.group_ids.some((id) => excluded.has(id));
}

/** Every facet ANDed together — the predicate behind the visible list.
 *  Callers apply search text separately (see module doc). */
export function passesFacetFilters(
  row: ListingRow,
  f: ListingFacetFilters,
): boolean {
  return (
    passesStatus(row, f.status) &&
    passesMatch(row, f.match) &&
    passesType(row, f.type) &&
    // Year comes from the registry match: a listing's own title year is
    // unreliable (race season vs. release year), and an unmatched row has
    // no trustworthy year at all — so it drops out once a bound is set.
    inYearRange(row.matched_year, f.year) &&
    passesDriverFilter(row, f.driver) &&
    passesSellerFilter(row.seller_username, f.seller) &&
    passesGroupFilter(row, f.group) &&
    passesExcludedGroups(row, f.excluded) &&
    passesOffer(row, f.offer, f.offersByItemId)
  );
}

export interface ListingFacetCounts {
  status: Record<StatusOption, number>;
  match: Record<MatchOption, number>;
  offer: Record<OfferOption, number>;
  type: Record<TypeOption, number>;
}

export interface ListingDriverOptions {
  options: { value: string; name: string; count: number }[];
  noneCount: number;
  allCount: number;
}

export interface ListingFacetData {
  counts: ListingFacetCounts;
  driver: ListingDriverOptions;
  /** Rows passing every filter except the seller facet — the input the
   *  seller popover's option builder wants. */
  sellerRows: ListingRow[];
}

/** Every sidebar aggregate in one pass over the (already search-filtered)
 *  rows. Each count answers "how many listings would I see if I picked this
 *  option?" — i.e. it is computed with every OTHER filter still applied,
 *  which is why each facet's tallies gate on the other facets' predicates
 *  and not its own. */
export function computeListingFacetData(
  rows: readonly ListingRow[],
  f: ListingFacetFilters,
): ListingFacetData {
  const counts: ListingFacetCounts = {
    status: { active: 0, ended: 0, archived: 0 },
    match: { confirmed: 0, unconfirmed: 0, unmatched: 0 },
    offer: { unresponded: 0, with: 0, without: 0 },
    type: { auction: 0, bin: 0, offers: 0 },
  };
  const byDriverKey = new Map<string, { name: string; count: number }>();
  let noneCount = 0;
  let allCount = 0;
  const sellerRows: ListingRow[] = [];

  for (const row of rows) {
    const s = passesStatus(row, f.status);
    const m = passesMatch(row, f.match);
    const t = passesType(row, f.type);
    const o = passesOffer(row, f.offer, f.offersByItemId);
    const yr = inYearRange(row.matched_year, f.year);
    const dr = passesDriverFilter(row, f.driver);
    const se = passesSellerFilter(row.seller_username, f.seller);
    const gr = passesGroupFilter(row, f.group);
    const ex = passesExcludedGroups(row, f.excluded);

    const common = yr && se && gr && ex && dr;

    if (common && m && t && o) {
      // Which single-option status sets this row would satisfy.
      if (row.status === "active") counts.status.active++;
      if (row.status === "ended" && !row.is_archived) counts.status.ended++;
      if (row.is_archived) counts.status.archived++;
    }
    if (common && s && t && o) {
      const matched = row.registry_entry_id !== null;
      if (matched && row.match_user_confirmed) counts.match.confirmed++;
      if (matched && !row.match_user_confirmed) counts.match.unconfirmed++;
      if (!matched) counts.match.unmatched++;
    }
    if (common && s && m && o) {
      // Type options overlap: an offer-taking auction counts under both.
      if (row.listing_type === "auction") counts.type.auction++;
      if (row.listing_type === "fixed" && !row.accepts_offers)
        counts.type.bin++;
      if (row.accepts_offers) counts.type.offers++;
    }
    if (common && s && m && t) {
      const offer = f.offersByItemId.get(
        legacyIdFromExternalId(row.external_id),
      );
      const hasOffer = offer !== undefined;
      const responded = hasOffer && (offer.is_read || row.status === "ended");
      if (hasOffer) counts.offer.with++;
      if (!hasOffer) counts.offer.without++;
      if (hasOffer && !responded) counts.offer.unresponded++;
    }

    // Driver combobox: every filter applies except driver.
    if (yr && se && gr && ex && s && m && t && o) {
      allCount++;
      const name = row.matched_driver_name ?? row.auto_driver_name;
      if (!name) {
        noneCount++;
      } else {
        const key = name.toLowerCase();
        const entry = byDriverKey.get(key);
        if (entry) entry.count++;
        else byDriverKey.set(key, { name, count: 1 });
      }
    }

    // Seller popover: every filter applies except seller.
    if (yr && gr && ex && dr && s && m && t && o) sellerRows.push(row);
  }

  const options = Array.from(byDriverKey.entries())
    .map(([key, v]) => ({ value: `d:${key}`, name: v.name, count: v.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    counts,
    driver: { options, noneCount, allCount },
    sellerRows,
  };
}
