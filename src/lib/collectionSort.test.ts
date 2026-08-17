// The pure half of DCH-66: the two-level Collection ordering. What matters
// here is that the levels are genuinely independent — a driver ordering
// never peeks at years, an item ordering never peeks at driver names — and
// that null years/values keep their pre-split sink-to-the-bottom treatment.
import { describe, expect, it } from "vitest";
import type { CollectionRow } from "@/lib/tauri";
import {
  compareFlat,
  compareGroups,
  compareItems,
  type GroupSortView,
} from "./collectionSort";

function row(overrides: Partial<CollectionRow>): CollectionRow {
  return {
    collection_id: 0,
    asset_guid: "a",
    driver_id: null,
    driver_name: null,
    year: null,
    year_raced: null,
    car_number: null,
    diecast_type: null,
    registration_number: null,
    oem: null,
    brand: null,
    scale: null,
    make: null,
    finish: null,
    production_qty: null,
    scheme_text: null,
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
    ...overrides,
  };
}

function group(
  name: string,
  itemCount: number,
  retailTotal: number,
): GroupSortView {
  return {
    driver_name: name,
    items: Array.from({ length: itemCount }, () => row({})),
    retail_total_cents: retailTotal,
  };
}

describe("compareGroups", () => {
  const gordon = group("Jeff Gordon", 3, 30000);
  const larson = group("Kyle Larson", 5, 10000);

  it("orders each axis independently", () => {
    expect([larson, gordon].sort(compareGroups("driver-asc"))).toEqual([
      gordon,
      larson,
    ]);
    expect([larson, gordon].sort(compareGroups("value-desc"))).toEqual([
      gordon,
      larson,
    ]);
    expect([gordon, larson].sort(compareGroups("count-desc"))).toEqual([
      larson,
      gordon,
    ]);
  });
});

describe("compareItems", () => {
  const y98 = row({ year: 1998, retail_value_cents: 12000 });
  const y02 = row({ year: 2002, retail_value_cents: 4000 });
  const unvalued = row({ year: null, retail_value_cents: null });

  it("year sorts sink null years to the bottom in both directions", () => {
    expect([unvalued, y98, y02].sort(compareItems("year-desc"))).toEqual([
      y02,
      y98,
      unvalued,
    ]);
    expect([unvalued, y02, y98].sort(compareItems("year-asc"))).toEqual([
      y98,
      y02,
      unvalued,
    ]);
  });

  it("value-desc reads the car's own retail, not the group total", () => {
    expect([y02, unvalued, y98].sort(compareItems("value-desc"))).toEqual([
      y98,
      y02,
      unvalued,
    ]);
  });
});

describe("compareFlat", () => {
  it("driver-asc groups by name, then newest car first — the flat echo of the grouped default", () => {
    const a = row({ driver_name: "Chase Elliott", year: 2016 });
    const b = row({ driver_name: "Chase Elliott", year: 2021 });
    const c = row({ driver_name: "Kyle Larson", year: 2015 });
    expect([c, a, b].sort(compareFlat("driver-asc"))).toEqual([b, a, c]);
  });

  it("delegates the item orderings unchanged", () => {
    const y98 = row({ year: 1998 });
    const y02 = row({ year: 2002 });
    expect([y98, y02].sort(compareFlat("year-desc"))).toEqual([y02, y98]);
  });
});
