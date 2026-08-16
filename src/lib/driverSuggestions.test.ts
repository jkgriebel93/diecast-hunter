import { describe, expect, it } from "vitest";
import { mergeDriverSuggestions } from "./driverSuggestions";
import type { DriverGroup, DriverOption, FormOptionRow } from "./tauri";

const local = (id: number, name: string): DriverOption => ({
  id,
  name,
  normalized_name: name.toLowerCase().replace(/\s+/g, "-"),
  listing_count: 0,
});

const owned = (driver_id: number, item_count: number): DriverGroup => ({
  driver_id,
  driver_name: `driver-${driver_id}`,
  item_count,
  retail_total_cents: 0,
  wholesale_total_cents: 0,
});

const dcr = (display: string): FormOptionRow => ({
  value: `guid-${display}`,
  display,
  normalized: display.toLowerCase(),
});

describe("mergeDriverSuggestions", () => {
  it("puts drivers you collect first, most-owned first", () => {
    // Without this the handful of names actually typed would sit below a few
    // thousand DCR entries in the empty-input dropdown.
    const out = mergeDriverSuggestions(
      [
        local(1, "Jeff Gordon"),
        local(2, "Kyle Busch"),
        local(3, "Alan Kulwicki"),
      ],
      [owned(1, 12), owned(2, 40)],
      [],
    );
    expect(out).toEqual(["Kyle Busch", "Jeff Gordon", "Alan Kulwicki"]);
  });

  it("includes locally-known drivers you own nothing by", () => {
    // The actual bug: a driver picked up from a watched listing or a registry
    // search was absent, so the first car by them got no suggestion at all.
    const out = mergeDriverSuggestions([local(1, "Ryan Blaney")], [], []);
    expect(out).toEqual(["Ryan Blaney"]);
  });

  it("adds DCR drivers the app has never seen, after the local ones", () => {
    const out = mergeDriverSuggestions(
      [local(1, "Jeff Gordon")],
      [owned(1, 3)],
      [dcr("Zane Smith"), dcr("Bobby Allison")],
    );
    expect(out).toEqual(["Jeff Gordon", "Bobby Allison", "Zane Smith"]);
  });

  it("shows one entry per driver, keeping the local spelling", () => {
    // DCR's spelling and the local one can differ in punctuation or spacing.
    // The local one wins: it is what the rest of the user's collection reads,
    // and two entries for one driver invite creating a near-duplicate.
    const out = mergeDriverSuggestions(
      [local(1, "Dale Earnhardt Jr.")],
      [],
      [dcr("Dale Earnhardt Jr"), dcr("dale  earnhardt   jr.")],
    );
    expect(out).toEqual(["Dale Earnhardt Jr."]);
  });

  it("drops blank and punctuation-only names rather than offering them", () => {
    const out = mergeDriverSuggestions(
      [local(1, "   "), local(2, "—"), local(3, "Jeff Gordon")],
      [],
      [dcr("")],
    );
    expect(out).toEqual(["Jeff Gordon"]);
  });

  it("treats a zero-count collection group as not collected", () => {
    // list_drivers_with_counts inner-joins my_collection so this shouldn't
    // arise, but a 0 must not float a driver above one with real items.
    const out = mergeDriverSuggestions(
      [local(1, "Zane Smith"), local(2, "Alan Kulwicki")],
      [owned(1, 0), owned(2, 5)],
      [],
    );
    expect(out).toEqual(["Alan Kulwicki", "Zane Smith"]);
  });

  it("returns nothing when every source is empty", () => {
    expect(mergeDriverSuggestions([], [], [])).toEqual([]);
  });
});
