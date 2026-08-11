/**
 * Collapsible checkbox-facet sections in a filter panel (DCH-43).
 *
 * Saved Listings' filter sidebar is `sticky`, so a panel taller than the
 * scrollport is not merely inconvenient — its tail is *unreachable*. Once the
 * panel sticks at the top, scrolling the page no longer moves it, and the
 * controls below the fold (the year range, the group include/exclude pair)
 * can never be brought into view. Four facets stacked at full height is what
 * pushed it over on a short window.
 *
 * The first fix (DCH-43) was to keep the panel's resting height small by
 * collapsing the facets that are off by default. An internal scroller was
 * the other candidate and was passed over then, because the driver picker
 * and the exclude menu were absolutely-positioned popovers anchored inside
 * the panel and an `overflow` on their scroll parent would have clipped
 * them.
 *
 * DCH-47 took the scroller anyway, after moving those menus onto
 * `position: fixed` (see `anchoredMenu.ts`) so nothing anchors inside the
 * panel any more. Collapsing is no longer load-bearing for reachability —
 * it is now about the panel's resting *legibility*, and the height budget is
 * enforced by the scroll region in `filterPanel.ts`.
 *
 * The constraint that survives both is the DCH-35 filter contract — a filter
 * that is narrowing the list must say so. A collapsed facet hides its
 * checkboxes, so its header carries a `FilterSummary` instead (which
 * replaced DCH-43's bare count badge: "1" said that something was filtering
 * but not what to). {@link dishonestFacetDefaults} keeps the weaker
 * first-visit promise: nothing starts both collapsed and already narrowing.
 */

export interface FacetSection {
  /** Stable identifier. It is part of the persisted collapse key, so
   *  renaming one silently resets that facet for existing users. */
  key: string;
  label: string;
  /** Collapsed on first visit, before the user has expressed an opinion.
   *  Only legal when {@link defaultSelected} is empty. */
  defaultCollapsed: boolean;
  /** Options checked before the user touches anything. */
  defaultSelected: readonly string[];
}

/** Collapse key for one facet, in the `"<kind>:<id>"` shape the shared
 *  minimized store expects. Namespaced by page so two screens with a
 *  "Status" facet don't collapse each other's. */
export function facetSectionKey(page: string, facet: string): string {
  return `facet:${page}:${facet}`;
}

/** The checkbox facets on Saved Listings' filter panel, in render order.
 *
 *  Status stays open: it is the one facet that starts with a selection, and
 *  it is the filter users reach for most. The other three start empty —
 *  collapsed they hide nothing that is narrowing the list. */
export const LISTING_FACETS: readonly FacetSection[] = [
  {
    key: "status",
    label: "Status",
    defaultCollapsed: false,
    defaultSelected: ["active"],
  },
  { key: "match", label: "Match", defaultCollapsed: true, defaultSelected: [] },
  { key: "offer", label: "Offer", defaultCollapsed: true, defaultSelected: [] },
  { key: "type", label: "Type", defaultCollapsed: true, defaultSelected: [] },
];

/** Look up a facet by key. Throws rather than returning undefined — a
 *  missing facet is a typo at a call site, not a runtime condition. */
export function facetSection(
  facets: readonly FacetSection[],
  key: string,
): FacetSection {
  const found = facets.find((f) => f.key === key);
  if (!found) throw new Error(`unknown facet section: ${key}`);
  return found;
}

/** A fresh selection Set for a facet's default state — the single source of
 *  truth for "what is checked before the user touches anything", so the
 *  page's initial state, its Clear filters reset and the honesty invariant
 *  below all read the same table.
 *
 *  The cast narrows to the page's own option union. It is safe by
 *  construction and unchecked by design: a facet's options live in the page
 *  (they carry per-option labels and live counts), so this module holds only
 *  their values. A typo would show up as a default that filters nothing. */
export function facetDefaultSelection<T extends string>(
  facets: readonly FacetSection[],
  key: string,
): Set<T> {
  return new Set(facetSection(facets, key).defaultSelected as readonly T[]);
}

/**
 * The invariant behind the whole design: nothing may start both collapsed
 * and already narrowing the list, because on first visit there is no badge
 * to read and no reason to open the section. Returns the offending keys.
 */
export function dishonestFacetDefaults(
  facets: readonly FacetSection[],
): string[] {
  return facets
    .filter((f) => f.defaultCollapsed && f.defaultSelected.length > 0)
    .map((f) => f.key);
}
