/** Driver suggestions for the manual collection-entry dialog.
 *
 *  # Why this isn't the collection's driver list
 *
 *  Collection's filter row derives its driver dropdown from the rows on
 *  screen, which is right for a filter: offering a driver you own nothing by
 *  would be an option that returns an empty list. The manual-entry dialog was
 *  handed that same list, where the rule is backwards — you are adding a car
 *  the registry doesn't list, and the *first* car by a given driver is exactly
 *  the case the suggestions went silent on. Drivers already known locally from
 *  watched listings, wishlist entries or registry searches were missing too.
 *
 *  So the dialog asks for drivers directly rather than being handed a list,
 *  and this module is where the three sources are reconciled.
 *
 *  # Ordering
 *
 *  Drivers you already collect come first, most-owned first. Without that,
 *  the handful of names you actually type would sit below a few thousand DCR
 *  entries in the empty-input dropdown, which would make the field worse than
 *  the too-short list it replaces. Everything else follows alphabetically:
 *  other locally-known drivers, then names known only to diecastregistry.com.
 */

import {
  api,
  type DriverGroup,
  type DriverOption,
  type FormOptionRow,
} from "./tauri";

/**
 * Fetch and merge the three sources.
 *
 * Deliberately uncached, unlike `attributeOptions`. All three queries hit
 * local SQLite — `registry_form_options` is a cache table, not a DCR round
 * trip — and the list has to reflect a driver the user invented in this very
 * dialog a moment ago. A session cache would leave their own new driver
 * missing from its own suggestions until a restart, which is the same class
 * of gap this module exists to close.
 *
 * A failure returns an empty list rather than throwing: the field is a
 * free-text input with suggestions attached, so losing the suggestions costs
 * convenience, not the ability to save.
 */
export async function loadDriverSuggestions(): Promise<string[]> {
  try {
    const [local, owned, dcr] = await Promise.all([
      api.listDrivers(),
      api.listDriversWithCounts(),
      api.listRegistryFormOptions("driver"),
    ]);
    return mergeDriverSuggestions(local, owned, dcr);
  } catch {
    return [];
  }
}

/** Loose key for reconciling the three sources. DCR's form options carry
 *  their own `normalized`, and the local `drivers` table its
 *  `normalized_name`, but those are produced by different code paths, so
 *  comparison happens on a key this module derives from the display name
 *  itself. */
function key(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Merge the local drivers table, the collection's per-driver counts, and
 * diecastregistry.com's driver vocabulary into one suggestion list.
 *
 * `local` supplies the display spelling for anything known locally — a name
 * the user has already seen in the app beats DCR's spelling of it, since that
 * is what the rest of their collection reads.
 */
export function mergeDriverSuggestions(
  local: DriverOption[],
  owned: DriverGroup[],
  dcr: FormOptionRow[],
): string[] {
  const ownedCount = new Map<number, number>();
  for (const g of owned) ownedCount.set(g.driver_id, g.item_count);

  const seen = new Set<string>();
  const mine: { name: string; count: number }[] = [];
  const others: string[] = [];

  for (const d of local) {
    const name = d.name.trim();
    const k = key(name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const count = ownedCount.get(d.id);
    if (count !== undefined && count > 0) mine.push({ name, count });
    else others.push(name);
  }

  for (const o of dcr) {
    const name = o.display.trim();
    const k = key(name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    others.push(name);
  }

  mine.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  others.sort((a, b) => a.localeCompare(b));
  return [...mine.map((m) => m.name), ...others];
}
