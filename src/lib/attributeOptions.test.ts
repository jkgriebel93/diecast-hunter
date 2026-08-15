import { describe, expect, it } from "vitest";
import { prepareTypeOptions } from "./attributeOptions";
import type { FormOptionRow } from "./tauri";

const opt = (display: string): FormOptionRow => ({
  value: display,
  display,
  normalized: display.toLowerCase(),
});

describe("prepareTypeOptions", () => {
  it("sorts alphabetically so a long list is scannable", () => {
    expect(
      prepareTypeOptions([opt("Truck"), opt("Stock Car"), opt("Dragster")]),
    ).toEqual(["Dragster", "Stock Car", "Truck"]);
  });

  it("drops the 'All Diecast' catch-all", () => {
    // It is a search filter meaning "don't filter". As the type of one car it
    // says nothing, and writing it would produce a value no type filter
    // anywhere else would match.
    expect(prepareTypeOptions([opt("All Diecast"), opt("Truck")])).toEqual([
      "Truck",
    ]);
  });

  it("drops blanks and case-insensitive duplicates", () => {
    // DCR's form carries an empty placeholder radio, and the same type can
    // appear twice with different casing across the page's radio groups —
    // both would render as an empty or repeated suggestion.
    expect(
      prepareTypeOptions([
        opt("Stock Car"),
        opt("   "),
        opt("stock car"),
        opt("Truck"),
      ]),
    ).toEqual(["Stock Car", "Truck"]);
  });

  it("returns nothing when the options cache is empty", () => {
    // The dialog degrades to free-form inputs rather than showing an empty
    // dropdown, so this has to be an empty list and not a throw.
    expect(prepareTypeOptions([])).toEqual([]);
  });
});
