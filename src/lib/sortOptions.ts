/** One vocabulary for every sort dropdown (DCH-35).
 *
 *  The audit found the same three concepts spelled three ways: driver A–Z was
 *  `driver-asc` on Collection, a bare `driver` on Registry and `name` on
 *  Listings; newest-first was "Newest year first", "Year newest first" and
 *  "Newest first". Nothing was broken — it just meant the same dropdown read
 *  differently depending on which screen you were on.
 *
 *  The `low → high` arrow idiom was already consistent across all three, so
 *  it's adopted rather than replaced.
 *
 *  **Wire values are exempt.** Browse, Seller feed and Saved searches send
 *  their sort straight to eBay's Browse API (`price`, `-price`,
 *  `newlyListed`, `endingSoonest`), and Saved searches persists it in SQLite.
 *  Renaming those would break the API call and every saved row, so those
 *  three keep eBay's values — their *labels* already follow the vocabulary
 *  below. `isWireSort` marks them so the convention test doesn't flag them.
 */

export type SortDirection = "asc" | "desc";

/** How a field orders, which decides how its direction reads to a person.
 *  "Z → A" and "high → low" and "newest → oldest" all mean `desc`; saying
 *  `desc` in the UI would be the developer's word, not the user's. */
export type SortKind = "alpha" | "numeric" | "chronological";

const ENDPOINTS: Record<SortKind, [string, string]> = {
  alpha: ["A", "Z"],
  numeric: ["low", "high"],
  chronological: ["oldest", "newest"],
};

/** `sortLabel("Driver", "alpha", "asc")` → `"Driver A → Z"`.
 *  `sortLabel("Retail value", "numeric", "desc")` → `"Retail value high → low"`.
 *  `sortLabel("Year", "chronological", "desc")` → `"Year newest → oldest"`. */
export function sortLabel(
  field: string,
  kind: SortKind,
  dir: SortDirection,
): string {
  const [low, high] = ENDPOINTS[kind];
  const [from, to] = dir === "asc" ? [low, high] : [high, low];
  return `${field} ${from} → ${to}`;
}

/** `sortValue("year", "desc")` → `"year-desc"`. Kebab-cases a multi-word
 *  field so the value stays greppable: `sortValue("retail value", "asc")`
 *  is `"retail-value-asc"`. */
export function sortValue(field: string, dir: SortDirection): string {
  const slug = field
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}-${dir}`;
}

/** A sort value that isn't a field ordering at all and so has no direction:
 *  the registry's own ordering, or eBay's relevance ranking. These stay as
 *  they are — inventing `relevance-desc` would imply an axis that doesn't
 *  exist. */
export const NON_DIRECTIONAL = new Set(["registry", "best-match", ""]);

/** eBay Browse API sort values. Not ours to rename — see the module note. */
export const WIRE_SORTS = new Set([
  "",
  "price",
  "-price",
  "newlyListed",
  "endingSoonest",
]);

export function isWireSort(value: string): boolean {
  return WIRE_SORTS.has(value);
}

/** Does this value follow the `field-asc` / `field-desc` convention?
 *  Used by the convention test; exported so the rule and the implementation
 *  can't drift apart. */
export function isConventionalSortValue(value: string): boolean {
  if (NON_DIRECTIONAL.has(value) || isWireSort(value)) return true;
  return /^[a-z0-9]+(-[a-z0-9]+)*-(asc|desc)$/.test(value);
}
