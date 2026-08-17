// Filtering and sorting for registry search results (DCH-59).
//
// Split out of Registry.tsx so the pure half of the results pipeline is
// unit-testable: the page defers the filter inputs (`useDeferredValue`) and
// bounds the rendered list, and these functions are what guarantee the
// numbers and ordering stay the same while it does.

import type { ProductionSearchResult } from "@/lib/tauri";

export type RegistrySortMode =
  | "registry"
  | "driver-asc"
  | "year-desc"
  | "year-asc"
  | "retail-value-desc"
  | "retail-value-asc"
  | "production-qty-asc"
  | "production-qty-desc";

/** How many result cards render before "Show more" (DCH-59). A broad local
 *  search returns thousands of rows; the page stays interactive by mounting
 *  them a page at a time. */
export const REGISTRY_RESULTS_PAGE = 200;

/** Parse a user-typed dollar amount ("25", "$12.50") into cents; null when
 *  blank or unparseable, which means "no bound". */
export function parseDollars(s: string): number | null {
  const t = s.trim().replace(/^\$/, "");
  if (t === "") return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

/** True when the value satisfies the bounds. With no bounds set, a null
 *  value passes; once either bound is set, unvalued items are excluded. */
export function inRange(
  cents: number | null,
  min: number | null,
  max: number | null,
): boolean {
  if (min === null && max === null) return true;
  if (cents === null) return false;
  if (min !== null && cents < min) return false;
  if (max !== null && cents > max) return false;
  return true;
}

/** The result-narrowing inputs exactly as typed — parsing happens here so
 *  the page can defer the whole object with one `useDeferredValue`. */
export interface RegistryResultFilterInputs {
  /** Free-text narrowing across driver/scheme/oem/brand/scale/make/year. */
  q: string;
  retailMin: string;
  retailMax: string;
  wholesaleMin: string;
  wholesaleMax: string;
}

/** Narrow the returned results. Returns the input array untouched when
 *  nothing is narrowing, so memo consumers keep referential equality. */
export function filterRegistryResults(
  results: ProductionSearchResult[],
  inputs: RegistryResultFilterInputs,
): ProductionSearchResult[] {
  const rMin = parseDollars(inputs.retailMin);
  const rMax = parseDollars(inputs.retailMax);
  const wMin = parseDollars(inputs.wholesaleMin);
  const wMax = parseDollars(inputs.wholesaleMax);
  const q = inputs.q.trim().toLowerCase();
  if (rMin === null && rMax === null && wMin === null && wMax === null && !q) {
    return results;
  }
  const matchesText = (r: ProductionSearchResult) =>
    !q ||
    [
      r.driver_name,
      r.scheme_text,
      r.oem,
      r.brand,
      r.scale,
      r.make,
      r.year === null ? null : String(r.year),
    ]
      .filter(Boolean)
      .some((f) => (f as string).toLowerCase().includes(q));
  return results.filter(
    (r) =>
      matchesText(r) &&
      inRange(r.retail_value_cents, rMin, rMax) &&
      inRange(r.wholesale_value_cents, wMin, wMax),
  );
}

/** Order the results. "registry" is the no-axis mode (DCH-35 exemption):
 *  whatever order diecastregistry.com returned, untouched — the input array
 *  itself comes back so referential equality survives. Every other mode
 *  sorts a copy. */
export function sortRegistryResults(
  results: ProductionSearchResult[],
  sortMode: RegistrySortMode,
): ProductionSearchResult[] {
  if (sortMode === "registry") return results;
  const nullsLast = (av: number | null, bv: number | null) => {
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv;
  };
  const list = [...results];
  list.sort((a, b) => {
    switch (sortMode) {
      case "driver-asc":
        return (
          a.driver_name.localeCompare(b.driver_name) ||
          (b.year ?? 0) - (a.year ?? 0)
        );
      case "year-desc":
        return nullsLast(b.year, a.year);
      case "year-asc":
        return nullsLast(a.year, b.year);
      case "retail-value-desc":
        return nullsLast(b.retail_value_cents, a.retail_value_cents);
      case "retail-value-asc":
        return nullsLast(a.retail_value_cents, b.retail_value_cents);
      case "production-qty-asc":
        return nullsLast(a.seq_produced_total, b.seq_produced_total);
      case "production-qty-desc":
        return nullsLast(b.seq_produced_total, a.seq_produced_total);
    }
  });
  return list;
}
