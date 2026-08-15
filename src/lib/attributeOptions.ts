/** Suggestion lists for the diecast attribute fields — OEM, brand, make,
 *  finish and type — built from the cached diecastregistry.com form options
 *  (`registry_form_options`).
 *
 *  Shared rather than per-screen because the vocabulary is the same wherever
 *  these fields are edited: the Listings attribute editor and the manual
 *  collection entry dialog are describing the same set of things, and a car
 *  typed as "Action" in one place and "Action/Lionel" in the other is two
 *  rows the matcher can't relate.
 *
 *  Fetched once per app session. A failure resets the cache — so the next
 *  open retries — and the caller degrades to free-form text inputs, which is
 *  the right fallback: these are `<datalist>` suggestions, never a closed
 *  set. The registry's vocabulary doesn't cover every promo or import, and
 *  the manual-entry dialog exists precisely for cars it doesn't list.
 */

import {
  api,
  isPreferredOem,
  prepareBrandOptions,
  prepareMakeOptions,
  type FormOptionRow,
} from "./tauri";

export interface AttributeOptions {
  oems: string[];
  brands: string[];
  makes: string[];
  finishes: string[];
  /** Diecast type — "Stock Car", "Truck", and so on. Comes from the radio
   *  buttons on DCR's search form rather than a `<select>`, so its `value`
   *  and `display` are the same string. */
  types: string[];
}

export const EMPTY_ATTRIBUTE_OPTIONS: AttributeOptions = {
  oems: [],
  brands: [],
  makes: [],
  finishes: [],
  types: [],
};

/** DCR's type radios include an "All Diecast" catch-all, which is a search
 *  filter meaning "don't filter" — as the type of an individual car it is
 *  meaningless, and picking it would write a value that no other screen's
 *  filter would ever match. */
const TYPE_EXCLUSIONS = new Set(["all diecast", "all"]);

let cached: Promise<AttributeOptions> | null = null;

export function loadAttributeOptions(): Promise<AttributeOptions> {
  cached ??= Promise.all([
    api.listRegistryFormOptions("oem"),
    api.listRegistryFormOptions("brand"),
    api.listRegistryFormOptions("make"),
    api.listRegistryFormOptions("finish"),
    api.listRegistryFormOptions("diecast_type"),
  ]).then(
    ([o, b, m, f, t]) => ({
      // Stable sort floats the OEMs the user actually buys to the top.
      oems: o
        .map((x) => x.display)
        .sort(
          (a, b2) => Number(isPreferredOem(b2)) - Number(isPreferredOem(a)),
        ),
      brands: prepareBrandOptions(b).map((x) => x.display),
      makes: prepareMakeOptions(m).map((x) => x.display),
      finishes: f.map((x) => x.display),
      types: prepareTypeOptions(t),
    }),
    () => {
      cached = null;
      return EMPTY_ATTRIBUTE_OPTIONS;
    },
  );
  return cached;
}

/** Exported for the unit tests; the app should call `loadAttributeOptions`. */
export function prepareTypeOptions(types: FormOptionRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of types) {
    const display = t.display.trim();
    if (!display || TYPE_EXCLUSIONS.has(display.toLowerCase())) continue;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Drop the session cache. Call after refreshing the form options from DCR so
 *  the next dropdown open reflects the new vocabulary rather than the one
 *  loaded at startup. */
export function resetAttributeOptionsCache(): void {
  cached = null;
}
