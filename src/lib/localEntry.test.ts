import { describe, expect, it } from "vitest";
import {
  EMPTY_MANUAL_ENTRY_FORM,
  findLocalDuplicates,
  formFromRow,
  parseIntField,
  parsePriceToCents,
  toInput,
  validateManualEntry,
  type ManualEntryForm,
} from "./localEntry";
import type { CollectionRow } from "./tauri";

const form = (over: Partial<ManualEntryForm> = {}): ManualEntryForm => ({
  ...EMPTY_MANUAL_ENTRY_FORM,
  driverName: "Jeff Gordon",
  schemeText: "#24 DuPont",
  ...over,
});

const row = (over: Partial<CollectionRow> = {}): CollectionRow => ({
  collection_id: 1,
  asset_guid: "asset-1",
  driver_id: 1,
  driver_name: "Jeff Gordon",
  year: 1998,
  year_raced: null,
  car_number: "24",
  diecast_type: null,
  registration_number: null,
  oem: "Action",
  brand: null,
  scale: "1:24",
  make: null,
  finish: null,
  production_qty: null,
  scheme_text: "#24 DuPont",
  image_url: null,
  detail_url: null,
  retail_value_cents: null,
  wholesale_value_cents: null,
  registry_int_id: null,
  enriched: false,
  is_local: false,
  paid_cents: null,
  condition: null,
  notes: null,
  din: null,
  local_image_path: null,
  ...over,
});

describe("parsePriceToCents", () => {
  it("accepts what people actually type", () => {
    expect(parsePriceToCents("45")).toBe(4500);
    expect(parsePriceToCents("45.00")).toBe(4500);
    expect(parsePriceToCents("$139.98")).toBe(13998);
    expect(parsePriceToCents("1,299.99")).toBe(129999);
    expect(parsePriceToCents("  45.5 ")).toBe(4550);
  });

  it("rounds rather than truncating, so a stray digit doesn't lose a cent", () => {
    expect(parsePriceToCents("19.999")).toBe(2000);
    // Binary floating point makes 19.99 * 100 come out as 1998.9999…;
    // truncation would silently store $19.98.
    expect(parsePriceToCents("19.99")).toBe(1999);
  });

  it("distinguishes blank from unparseable", () => {
    expect(parsePriceToCents("")).toBeNull();
    expect(parsePriceToCents("   ")).toBeNull();
    expect(parsePriceToCents("free")).toBeUndefined();
    expect(parsePriceToCents("12.34.56")).toBeUndefined();
    expect(parsePriceToCents(".")).toBeUndefined();
    expect(parsePriceToCents("-5")).toBeUndefined();
  });
});

describe("parseIntField", () => {
  it("parses counts and rejects everything else", () => {
    expect(parseIntField("2508")).toBe(2508);
    expect(parseIntField("2,508")).toBe(2508);
    expect(parseIntField("")).toBeNull();
    expect(parseIntField("12.5")).toBeUndefined();
    expect(parseIntField("many")).toBeUndefined();
    expect(parseIntField("-3")).toBeUndefined();
  });
});

describe("validateManualEntry", () => {
  it("passes a minimal entry — driver and scheme are the only requirements", () => {
    expect(validateManualEntry(form())).toEqual([]);
  });

  it("requires a driver and a scheme", () => {
    expect(validateManualEntry(form({ driverName: "  " }))).toContain(
      "Driver name is required.",
    );
    expect(validateManualEntry(form({ schemeText: "" }))).toEqual([
      "Scheme/description is required — it titles the entry.",
    ]);
  });

  it("reports every problem at once rather than one per attempt", () => {
    const errors = validateManualEntry(
      form({ driverName: "", year: "nope", price: "free" }),
    );
    expect(errors).toHaveLength(3);
  });

  it("catches an out-of-range year before it reaches the backend", () => {
    expect(validateManualEntry(form({ year: "20255" }))[0]).toMatch(
      /between 1900 and 2100/,
    );
    expect(validateManualEntry(form({ year: "1998" }))).toEqual([]);
  });

  it("treats a blank DIN as absent — most diecasts aren't numbered", () => {
    expect(validateManualEntry(form({ din: "" }))).toEqual([]);
  });

  it("rejects a DIN that isn't a counting number", () => {
    expect(validateManualEntry(form({ din: "one" }))).toContain(
      "DIN must be a whole number.",
    );
    expect(validateManualEntry(form({ din: "0" }))).toContain(
      "DIN must be 1 or greater.",
    );
  });

  it("rejects a DIN past the end of the production run", () => {
    expect(
      validateManualEntry(form({ din: "3000", productionQty: "2500" })),
    ).toContain("DIN 3000 is higher than the production quantity of 2500.");
    expect(
      validateManualEntry(form({ din: "2500", productionQty: "2500" })),
    ).toEqual([]);
    // Unknown run size can't contradict anything...
    expect(validateManualEntry(form({ din: "3000" }))).toEqual([]);
    // ...and neither can 0, which is the prototype convention rather than a
    // run of none.
    expect(validateManualEntry(form({ din: "1", productionQty: "0" }))).toEqual(
      [],
    );
  });
});

describe("toInput", () => {
  it("converts a filled form, trimming blanks to null", () => {
    const input = toInput(
      form({
        driverName: "  Jeff Gordon  ",
        year: "1998",
        oem: " Action ",
        brand: "   ",
        price: "$45.00",
        productionQty: "2,508",
        din: "1832",
      }),
    );
    expect(input.din).toBe(1832);
    expect(input.driverName).toBe("Jeff Gordon");
    expect(input.year).toBe(1998);
    expect(input.oem).toBe("Action");
    expect(input.brand).toBeNull();
    expect(input.paidCents).toBe(4500);
    expect(input.productionQty).toBe(2508);
    // No appraisal is ever synthesized from the purchase price — the whole
    // point of keeping cost basis separate.
    expect(input).not.toHaveProperty("retailValueCents");
  });

  it("refuses to submit an invalid form", () => {
    expect(() => toInput(form({ driverName: "" }))).toThrow(/invalid entry/);
  });
});

describe("formFromRow", () => {
  it("round-trips an entry through the edit dialog unchanged", () => {
    const original = form({
      year: "2001",
      price: "45.00",
      oem: "Action",
      scale: "1:24",
      din: "412",
      productionQty: "2508",
    });
    const input = toInput(original);
    const stored = row({
      driver_name: input.driverName,
      scheme_text: input.schemeText,
      year: input.year,
      oem: input.oem,
      scale: input.scale,
      car_number: null,
      paid_cents: input.paidCents,
      din: input.din,
      production_qty: input.productionQty,
      is_local: true,
    });
    expect(toInput(formFromRow(stored))).toEqual(input);
  });

  it("renders a missing price as blank, not as $0.00", () => {
    expect(formFromRow(row({ paid_cents: null })).price).toBe("");
    expect(formFromRow(row({ paid_cents: 0 })).price).toBe("0.00");
  });
});

describe("findLocalDuplicates", () => {
  it("flags a manual entry that DCR has since started listing", () => {
    const manual = row({ collection_id: 10, is_local: true });
    const synced = row({ collection_id: 11, asset_guid: "asset-2" });
    const dupes = findLocalDuplicates([manual, synced]);
    expect(dupes.get(10)?.collection_id).toBe(11);
  });

  it("ignores punctuation, case and spacing differences in the scheme", () => {
    const manual = row({
      collection_id: 10,
      is_local: true,
      driver_name: "jeff gordon",
      scheme_text: "24  dupont",
    });
    const synced = row({ collection_id: 11, scheme_text: "#24 DuPont" });
    expect(findLocalDuplicates([manual, synced]).has(10)).toBe(true);
  });

  it("does not flag the same scheme at a different scale", () => {
    // A 1:24 and a 1:64 of one paint scheme are two different cars, and
    // owning both is normal.
    const manual = row({ collection_id: 10, is_local: true, scale: "1:64" });
    const synced = row({ collection_id: 11, scale: "1:24" });
    expect(findLocalDuplicates([manual, synced]).size).toBe(0);
  });

  it("does not flag a different year or a different driver", () => {
    const manual = row({ collection_id: 10, is_local: true, year: 1997 });
    const synced = row({ collection_id: 11, year: 1998 });
    expect(findLocalDuplicates([manual, synced]).size).toBe(0);

    const otherDriver = row({ collection_id: 12, driver_name: "Kyle Busch" });
    expect(
      findLocalDuplicates([
        row({ collection_id: 10, is_local: true }),
        otherDriver,
      ]).size,
    ).toBe(0);
  });

  it("never flags two manual entries against each other", () => {
    // Two hand-typed copies of the same car is a mistake the user can see;
    // the point of this flag is specifically the invisible DCR collision.
    const a = row({ collection_id: 10, is_local: true });
    const b = row({ collection_id: 11, is_local: true });
    expect(findLocalDuplicates([a, b]).size).toBe(0);
  });

  it("is empty when nothing was added by hand", () => {
    expect(findLocalDuplicates([row(), row({ collection_id: 2 })]).size).toBe(
      0,
    );
  });
});
