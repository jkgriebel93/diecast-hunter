// Collection ordering (DCH-66), split by level. One SortMode used to drive
// both the driver groups and the cars inside them, which made "drivers A
// to Z, newest car first within each" inexpressible — and made the year
// options ambiguous: while grouped they secretly reordered *drivers* by
// their newest car while the cars themselves stayed fixed at year-desc.
// Split out of Collection.tsx so the comparators are unit-testable.

import type { CollectionRow } from "@/lib/tauri";

/** Ordering of the driver groups. Year deliberately isn't here any more —
 *  with the levels split it is a property of the cars, not the drivers. */
export type DriverSort = "driver-asc" | "value-desc" | "count-desc";

/** Ordering of the cars inside one driver's panel. No driver option: every
 *  car in the panel shares one. */
export type GroupItemSort = "year-desc" | "year-asc" | "value-desc";

/** Ordering of the flat (ungrouped) list. */
export type FlatSort = "driver-asc" | "year-desc" | "year-asc" | "value-desc";

/** The group fields the driver-level orderings read. Structural, so the
 *  page's richer view type satisfies it without a cast. */
export interface GroupSortView {
  driver_name: string;
  items: CollectionRow[];
  retail_total_cents: number;
}

export function compareGroups(
  sort: DriverSort,
): (a: GroupSortView, b: GroupSortView) => number {
  switch (sort) {
    case "driver-asc":
      return (a, b) => a.driver_name.localeCompare(b.driver_name);
    case "value-desc":
      return (a, b) => b.retail_total_cents - a.retail_total_cents;
    case "count-desc":
      return (a, b) => b.items.length - a.items.length;
  }
}

/** Missing values keep their pre-split treatment: a null year or value
 *  counts as 0 descending and as 9999/∞-ish ascending, i.e. unvalued rows
 *  sink to the bottom either way. */
export function compareItems(
  sort: GroupItemSort,
): (a: CollectionRow, b: CollectionRow) => number {
  switch (sort) {
    case "year-desc":
      return (a, b) => (b.year ?? 0) - (a.year ?? 0);
    case "year-asc":
      return (a, b) => (a.year ?? 9999) - (b.year ?? 9999);
    case "value-desc":
      return (a, b) =>
        (b.retail_value_cents ?? 0) - (a.retail_value_cents ?? 0);
  }
}

export function compareFlat(
  sort: FlatSort,
): (a: CollectionRow, b: CollectionRow) => number {
  if (sort === "driver-asc") {
    // Driver name, then newest car within a driver — the flat echo of the
    // grouped default.
    return (a, b) =>
      (a.driver_name ?? "").localeCompare(b.driver_name ?? "") ||
      (b.year ?? 0) - (a.year ?? 0);
  }
  return compareItems(sort);
}
