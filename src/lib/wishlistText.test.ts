import { describe, expect, it } from "vitest";
import { wishLine, wishlistToText } from "./wishlistText";
import type { WishlistEntry, WishlistListing } from "./tauri";

function listing(over: Partial<WishlistListing> = {}): WishlistListing {
  return {
    listing_id: 1,
    seller_code: "ebay",
    title: "A car",
    url: "https://ebay.test/1",
    price_cents: 5000,
    shipping_cents: 500,
    currency: "USD",
    status: "active",
    end_time: null,
    image_url: null,
    linked_at: 0,
    ...over,
  };
}

function entry(over: Partial<WishlistEntry> = {}): WishlistEntry {
  return {
    entry_id: 1,
    wishlist_id: 1,
    registry_entry_id: 1,
    registry_guid: "guid",
    driver_name: "Kyle Larson",
    year: 2024,
    oem: "Chevrolet",
    brand: "Action",
    scale: "1/24",
    make: "CWC",
    scheme_text: "Valvoline",
    production_qty: null,
    retail_value_cents: null,
    wholesale_value_cents: null,
    image_url: null,
    detail_url: null,
    notes: null,
    added_at: 0,
    sort_rank: 0,
    listings: [],
    ...over,
  };
}

describe("wishLine", () => {
  it("reads like a person naming a car", () => {
    expect(wishLine(entry())).toBe(
      "2024 Kyle Larson — Valvoline · 1/24 · Action",
    );
  });

  it("survives a wish with almost nothing on it", () => {
    const line = wishLine(
      entry({
        driver_name: null,
        year: null,
        scheme_text: null,
        scale: null,
        brand: null,
      }),
    );
    expect(line).toBe("(unknown driver)");
    expect(line).not.toContain("—");
  });

  it("omits missing parts without leaving separators behind", () => {
    const line = wishLine(entry({ scale: null, brand: null }));
    expect(line).toBe("2024 Kyle Larson — Valvoline");
    expect(line).not.toMatch(/·\s*$/);
  });
});

describe("wishlistToText", () => {
  it("leads with the list name and counts the cars", () => {
    const text = wishlistToText("Hunts", [entry(), entry({ entry_id: 2 })]);
    expect(text.startsWith("Hunts\n")).toBe(true);
    expect(text).toContain("2 cars · Diecast Hunter");
  });

  it("singularizes one car", () => {
    expect(wishlistToText("Hunts", [entry()])).toContain("1 car · ");
  });

  it("names the list even when it's empty", () => {
    // Pasting a bare heading says "nothing on it yet"; pasting an empty
    // string looks like the button is broken.
    const text = wishlistToText("Hunts", []);
    expect(text).toContain("Hunts");
    expect(text).toContain("(nothing on this list yet)");
  });

  it("omits notes by default", () => {
    // Same privacy default as a public link — this text gets pasted into
    // the same places.
    const text = wishlistToText("Hunts", [entry({ notes: "seller owes me" })]);
    expect(text).not.toContain("seller owes me");
  });

  it("includes notes when asked, indented under their wish", () => {
    const text = wishlistToText("Hunts", [entry({ notes: "under $80" })], {
      includeNotes: true,
    });
    expect(text).toContain("    under $80");
  });

  it("indents every line of a multi-line note", () => {
    const text = wishlistToText("Hunts", [entry({ notes: "one\ntwo" })], {
      includeNotes: true,
    });
    expect(text).toContain("    one");
    expect(text).toContain("    two");
  });

  it("omits candidate prices by default", () => {
    const text = wishlistToText("Hunts", [
      entry({ listings: [listing({ price_cents: 12345 })] }),
    ]);
    expect(text).not.toContain("$");
  });

  it("quotes the cheapest candidate, shipping included", () => {
    const text = wishlistToText(
      "Hunts",
      [
        entry({
          listings: [
            listing({ listing_id: 1, price_cents: 9000, shipping_cents: 0 }),
            listing({ listing_id: 2, price_cents: 5000, shipping_cents: 500 }),
          ],
        }),
      ],
      { includeCandidates: true },
    );
    expect(text).toContain("$55.00 delivered");
    expect(text).toContain("(+1 more)");
  });

  it("treats a missing shipping cost as zero rather than dropping the row", () => {
    const text = wishlistToText(
      "Hunts",
      [
        entry({
          listings: [listing({ price_cents: 7000, shipping_cents: null })],
        }),
      ],
      { includeCandidates: true },
    );
    expect(text).toContain("$70.00 delivered");
  });

  it("skips candidates with no price at all", () => {
    // An unpriced listing can't be quoted, and "undefined delivered" is
    // worse than saying nothing.
    const text = wishlistToText(
      "Hunts",
      [entry({ listings: [listing({ price_cents: null })] })],
      { includeCandidates: true },
    );
    expect(text).not.toContain("delivered");
  });

  it("appends the share link when there is one", () => {
    const text = wishlistToText("Hunts", [entry()], {
      shareUrl: "https://w.test/w/abc",
    });
    expect(text.trimEnd().endsWith("https://w.test/w/abc")).toBe(true);
  });

  it("says nothing about a link when the list isn't shared", () => {
    const text = wishlistToText("Hunts", [entry()], { shareUrl: null });
    expect(text).not.toContain("http");
  });

  it("bullets every wish", () => {
    const text = wishlistToText("Hunts", [
      entry({ entry_id: 1 }),
      entry({ entry_id: 2, driver_name: "Chase Elliott" }),
    ]);
    expect(text.match(/^• /gm)).toHaveLength(2);
    expect(text).toContain("Chase Elliott");
  });
});
