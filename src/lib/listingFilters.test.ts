// The load-bearing claim of DCH-58's one-pass faceting: for every facet
// option, `computeListingFacetData`'s count equals the naive recount —
// filter the rows with that facet's selection replaced by the single option
// and every other filter as-is. The naive recount here IS the old
// implementation's semantics, so these tests are the drift guard between
// the fast path and the meaning of the numbers in the sidebar.

import { describe, expect, it } from "vitest";
import type { ListingRow, ReceivedOffer } from "@/lib/tauri";
import { EMPTY_YEAR_RANGE } from "@/lib/yearRange";
import {
  buildSearchHaystack,
  computeListingFacetData,
  legacyIdFromExternalId,
  passesFacetFilters,
  type ListingFacetFilters,
  type MatchOption,
  type OfferOption,
  type StatusOption,
  type TypeOption,
} from "./listingFilters";

let nextId = 1;
function mkRow(overrides: Partial<ListingRow> = {}): ListingRow {
  const id = nextId++;
  return {
    listing_id: id,
    seller_code: "ebay",
    external_id: `v1|${1000 + id}|0`,
    url: "https://ebay.example/itm",
    title: `Listing ${id}`,
    price_cents: 1000,
    shipping_cents: 500,
    currency: "USD",
    condition: null,
    listing_type: "fixed",
    accepts_offers: false,
    status: "active",
    is_archived: false,
    end_reason: null,
    archived_at: null,
    end_time: null,
    seller_username: null,
    seller_rating: null,
    image_url: null,
    saved_at: 0,
    last_seen_at: 0,
    registry_entry_id: null,
    match_confidence: null,
    match_user_confirmed: false,
    matched_by: null,
    match_reasons: [],
    matched_driver_name: null,
    matched_scheme_text: null,
    matched_year: null,
    matched_oem: null,
    matched_brand: null,
    matched_scale: null,
    matched_retail_cents: null,
    matched_wholesale_cents: null,
    matched_detail_url: null,
    deal_score: null,
    comps: null,
    comp_score: null,
    auto_driver_id: null,
    auto_driver_name: null,
    auto_driver_user_set: false,
    group_ids: [],
    oem: null,
    brand: null,
    finish: null,
    make: null,
    is_race_win: false,
    is_autographed: false,
    production_count: null,
    attrs_from_match: false,
    attributes_user_set: false,
    ...overrides,
  } as ListingRow;
}

function mkOffer(itemId: string, isRead: boolean): ReceivedOffer {
  return {
    message_id: `m-${itemId}`,
    item_id: itemId,
    item_title: "t",
    item_web_url: "https://ebay.example",
    item_image_url: null,
    original_price_cents: null,
    offer_price_cents: null,
    currency: "USD",
    discount_percent: null,
    is_read: isRead,
    received_at: 0,
    expires_at: null,
  } as ReceivedOffer;
}

function emptyFilters(): ListingFacetFilters {
  return {
    status: new Set(),
    match: new Set(),
    offer: new Set(),
    type: new Set(),
    group: "all",
    excluded: new Set(),
    driver: "all",
    seller: new Set(),
    year: EMPTY_YEAR_RANGE,
    offersByItemId: new Map(),
  };
}

/** A deliberately messy population: every status/match/type/offer shape,
 *  overlapping groups, mixed drivers and sellers, a year spread. */
function fixtureRows(): {
  rows: ListingRow[];
  offers: Map<string, ReceivedOffer>;
} {
  nextId = 1;
  const rows = [
    mkRow({
      title: "Jeff Gordon DuPont 1:24",
      matched_driver_name: "Jeff Gordon",
      registry_entry_id: 11,
      match_user_confirmed: true,
      matched_year: 1998,
      seller_username: "SellerA",
      listing_type: "auction",
      group_ids: [1],
    }),
    mkRow({
      title: "Gordon Chromalusion",
      auto_driver_name: "Jeff Gordon",
      matched_year: null,
      seller_username: "sellera",
      listing_type: "fixed",
      accepts_offers: true,
      group_ids: [1, 2],
    }),
    mkRow({
      title: "Earnhardt Goodwrench",
      matched_driver_name: "Dale Earnhardt",
      registry_entry_id: 12,
      match_user_confirmed: false,
      matched_year: 2000,
      seller_username: "SellerB",
      status: "ended",
      group_ids: [2],
    }),
    mkRow({
      title: "Labonte Kellogg's",
      auto_driver_name: "Terry Labonte",
      status: "ended",
      is_archived: true,
      end_reason: "sold",
      seller_username: null,
      listing_type: "auction",
      accepts_offers: true,
    }),
    mkRow({
      title: "Mystery diecast race win",
      is_race_win: true,
      seller_username: "SellerC",
      group_ids: [3],
    }),
    mkRow({
      title: "Autographed Elite",
      is_autographed: true,
      registry_entry_id: 13,
      match_user_confirmed: true,
      matched_driver_name: "Jeff Gordon",
      matched_year: 2002,
      is_archived: true,
      status: "ended",
    }),
  ];
  const offers = new Map<string, ReceivedOffer>();
  // Unread offer on row 1 (active), read offer on row 3 (ended).
  offers.set(
    legacyIdFromExternalId(rows[0].external_id),
    mkOffer(legacyIdFromExternalId(rows[0].external_id), false),
  );
  offers.set(
    legacyIdFromExternalId(rows[2].external_id),
    mkOffer(legacyIdFromExternalId(rows[2].external_id), true),
  );
  return { rows, offers };
}

/** The old implementation's shape: recount from scratch with one facet's
 *  selection replaced. */
function naiveCount(
  rows: ListingRow[],
  f: ListingFacetFilters,
  override: Partial<ListingFacetFilters>,
): number {
  const merged = { ...f, ...override };
  return rows.filter((r) => passesFacetFilters(r, merged)).length;
}

function expectFacetDataMatchesNaive(
  rows: ListingRow[],
  f: ListingFacetFilters,
) {
  const data = computeListingFacetData(rows, f);
  for (const o of ["active", "ended", "archived"] as StatusOption[]) {
    expect(data.counts.status[o], `status.${o}`).toBe(
      naiveCount(rows, f, { status: new Set([o]) }),
    );
  }
  for (const o of ["confirmed", "unconfirmed", "unmatched"] as MatchOption[]) {
    expect(data.counts.match[o], `match.${o}`).toBe(
      naiveCount(rows, f, { match: new Set([o]) }),
    );
  }
  for (const o of ["unresponded", "with", "without"] as OfferOption[]) {
    expect(data.counts.offer[o], `offer.${o}`).toBe(
      naiveCount(rows, f, { offer: new Set([o]) }),
    );
  }
  for (const o of ["auction", "bin", "offers"] as TypeOption[]) {
    expect(data.counts.type[o], `type.${o}`).toBe(
      naiveCount(rows, f, { type: new Set([o]) }),
    );
  }
  // Driver options: every filter except driver.
  expect(data.driver.allCount, "driver.allCount").toBe(
    naiveCount(rows, f, { driver: "all" }),
  );
  const noDriver = rows.filter(
    (r) =>
      passesFacetFilters(r, { ...f, driver: "all" }) &&
      (r.matched_driver_name ?? r.auto_driver_name) === null,
  ).length;
  expect(data.driver.noneCount, "driver.noneCount").toBe(noDriver);
  // Seller rows: every filter except seller.
  expect(
    data.sellerRows.map((r) => r.listing_id),
    "sellerRows",
  ).toEqual(
    rows
      .filter((r) => passesFacetFilters(r, { ...f, seller: new Set() }))
      .map((r) => r.listing_id),
  );
}

describe("computeListingFacetData equals the naive per-option recount", () => {
  it("with no filters set", () => {
    const { rows, offers } = fixtureRows();
    const f = { ...emptyFilters(), offersByItemId: offers };
    expectFacetDataMatchesNaive(rows, f);
  });

  it("with a status selection narrowing the other facets", () => {
    const { rows, offers } = fixtureRows();
    const f: ListingFacetFilters = {
      ...emptyFilters(),
      status: new Set<StatusOption>(["active"]),
      offersByItemId: offers,
    };
    expectFacetDataMatchesNaive(rows, f);
  });

  it("with several facets at once", () => {
    const { rows, offers } = fixtureRows();
    const f: ListingFacetFilters = {
      ...emptyFilters(),
      status: new Set<StatusOption>(["active", "archived"]),
      match: new Set<MatchOption>(["confirmed", "unmatched"]),
      type: new Set<TypeOption>(["auction", "offers"]),
      driver: "d:jeff gordon",
      group: "1",
      offersByItemId: offers,
    };
    expectFacetDataMatchesNaive(rows, f);
  });

  it("with the offer facet and group exclusions engaged", () => {
    const { rows, offers } = fixtureRows();
    const f: ListingFacetFilters = {
      ...emptyFilters(),
      offer: new Set<OfferOption>(["unresponded"]),
      excluded: new Set([2]),
      offersByItemId: offers,
    };
    expectFacetDataMatchesNaive(rows, f);
  });

  it("with the year filter dropping unmatched rows", () => {
    const { rows, offers } = fixtureRows();
    const f: ListingFacetFilters = {
      ...emptyFilters(),
      year: { from: 1998, to: 2001 },
      offersByItemId: offers,
    };
    expectFacetDataMatchesNaive(rows, f);
  });

  it("driver options carry faceted counts and count-desc order", () => {
    const { rows, offers } = fixtureRows();
    const data = computeListingFacetData(rows, {
      ...emptyFilters(),
      offersByItemId: offers,
    });
    const gordon = data.driver.options.find((o) => o.value === "d:jeff gordon");
    expect(gordon?.count).toBe(3);
    // Sorted most-listings-first.
    expect(data.driver.options[0]?.value).toBe("d:jeff gordon");
  });
});

describe("facet predicate edges", () => {
  it("ended-but-archived rows count as archived, not ended", () => {
    nextId = 1;
    const archived = mkRow({ status: "ended", is_archived: true });
    const f = emptyFilters();
    const data = computeListingFacetData([archived], f);
    expect(data.counts.status.ended).toBe(0);
    expect(data.counts.status.archived).toBe(1);
  });

  it("an offer on an ended listing counts as responded", () => {
    nextId = 1;
    const row = mkRow({ status: "ended" });
    const key = legacyIdFromExternalId(row.external_id);
    const f: ListingFacetFilters = {
      ...emptyFilters(),
      status: new Set<StatusOption>(["ended"]),
      offersByItemId: new Map([[key, mkOffer(key, false)]]),
    };
    const data = computeListingFacetData([row], f);
    expect(data.counts.offer.with).toBe(1);
    expect(data.counts.offer.unresponded).toBe(0);
  });

  it("type options overlap: an offer-taking auction counts under both", () => {
    nextId = 1;
    const row = mkRow({ listing_type: "auction", accepts_offers: true });
    const data = computeListingFacetData([row], emptyFilters());
    expect(data.counts.type.auction).toBe(1);
    expect(data.counts.type.offers).toBe(1);
    expect(data.counts.type.bin).toBe(0);
  });
});

describe("buildSearchHaystack", () => {
  it("includes attribute-derived phrases and lower-cases everything", () => {
    nextId = 1;
    const row = mkRow({
      title: "Jeff GORDON DuPont",
      matched_scheme_text: "#24 Pepsi Daytona",
      is_race_win: true,
      is_autographed: true,
      finish: "Chrome",
    });
    const hay = buildSearchHaystack(row);
    expect(hay).toContain("jeff gordon dupont");
    expect(hay).toContain("#24 pepsi daytona");
    expect(hay).toContain("race win");
    expect(hay).toContain("autograph autographed");
    expect(hay).toContain("chrome");
    expect(hay).toBe(hay.toLowerCase());
  });
});

describe("legacyIdFromExternalId", () => {
  it("extracts the legacy segment and falls back to the raw id", () => {
    expect(legacyIdFromExternalId("v1|123456|0")).toBe("123456");
    expect(legacyIdFromExternalId("v1|not-numeric|0")).toBe("v1|not-numeric|0");
    expect(legacyIdFromExternalId("plain")).toBe("plain");
  });
});
