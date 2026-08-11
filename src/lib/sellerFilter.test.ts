import { describe, expect, it } from "vitest";
import {
  NO_SELLER_LABEL,
  passesSellerFilter,
  sellerFilterLabel,
  sellerKey,
  sellerOptions,
  type SellerKey,
} from "./sellerFilter";

const rows = (...names: (string | null)[]) =>
  names.map((seller_username) => ({ seller_username }));

describe("sellerKey", () => {
  it("lower-cases so one seller isn't two options", () => {
    expect(sellerKey("DiecastDepot")).toBe("diecastdepot");
    expect(sellerKey("diecastdepot")).toBe(sellerKey("DIECASTDEPOT"));
  });

  it("treats missing, empty and whitespace-only as the no-seller bucket", () => {
    expect(sellerKey(null)).toBeNull();
    expect(sellerKey(undefined)).toBeNull();
    expect(sellerKey("")).toBeNull();
    expect(sellerKey("   ")).toBeNull();
  });

  it("trims, so a stray space doesn't split a seller in two", () => {
    expect(sellerKey(" diecast_depot ")).toBe("diecast_depot");
  });
});

describe("sellerOptions", () => {
  it("counts distinct sellers, most listings first", () => {
    const opts = sellerOptions(rows("bee", "ant", "bee", "cat", "bee", "ant"));
    expect(opts.map((o) => [o.label, o.count])).toEqual([
      ["bee", 3],
      ["ant", 2],
      ["cat", 1],
    ]);
  });

  it("breaks count ties on the label so the order doesn't depend on row order", () => {
    expect(sellerOptions(rows("zed", "amy")).map((o) => o.label)).toEqual([
      "amy",
      "zed",
    ]);
    expect(sellerOptions(rows("amy", "zed")).map((o) => o.label)).toEqual([
      "amy",
      "zed",
    ]);
  });

  it("folds case variants into one option and displays the stored spelling", () => {
    const opts = sellerOptions(rows("DiecastDepot", "diecastdepot"));
    expect(opts).toHaveLength(1);
    expect(opts[0].label).toBe("DiecastDepot");
    expect(opts[0].count).toBe(2);
  });

  it("offers the no-seller bucket only when such a row exists", () => {
    expect(sellerOptions(rows("ant", "bee")).some((o) => o.key === null)).toBe(
      false,
    );
    const withNull = sellerOptions(rows("ant", null, null));
    expect(withNull.find((o) => o.key === null)).toEqual({
      key: null,
      label: NO_SELLER_LABEL,
      count: 2,
    });
  });

  it("returns nothing for no rows", () => {
    expect(sellerOptions([])).toEqual([]);
  });
});

describe("passesSellerFilter", () => {
  it("passes everything while nothing is selected", () => {
    // Empty means the facet is off, not "match nothing" — the same contract
    // the checkbox facets use.
    const none = new Set<SellerKey>();
    expect(passesSellerFilter("ant", none)).toBe(true);
    expect(passesSellerFilter(null, none)).toBe(true);
  });

  it("ORs multiple sellers together", () => {
    const sel = new Set<SellerKey>(["ant", "bee"]);
    expect(passesSellerFilter("ant", sel)).toBe(true);
    expect(passesSellerFilter("bee", sel)).toBe(true);
    expect(passesSellerFilter("cat", sel)).toBe(false);
  });

  it("matches regardless of the stored casing", () => {
    expect(passesSellerFilter("DiecastDepot", new Set(["diecastdepot"]))).toBe(
      true,
    );
  });

  it("keeps no-seller rows out unless that bucket is checked", () => {
    expect(passesSellerFilter(null, new Set<SellerKey>(["ant"]))).toBe(false);
    expect(passesSellerFilter(null, new Set<SellerKey>([null]))).toBe(true);
  });
});

describe("sellerFilterLabel", () => {
  const options = sellerOptions(rows("ant", "bee", null));

  it("says all sellers when the facet is off", () => {
    expect(sellerFilterLabel(new Set(), options)).toBe("All sellers");
  });

  it("names a single pick", () => {
    expect(sellerFilterLabel(new Set<SellerKey>(["ant"]), options)).toBe("ant");
    expect(sellerFilterLabel(new Set<SellerKey>([null]), options)).toBe(
      NO_SELLER_LABEL,
    );
  });

  it("counts beyond one, rather than truncating a list", () => {
    expect(sellerFilterLabel(new Set<SellerKey>(["ant", "bee"]), options)).toBe(
      "2 sellers",
    );
  });

  it("still reports a selection that has left the options", () => {
    // Reporting "All sellers" over an empty screen is the failure the
    // DCH-35 contract exists to prevent, so a stale pick keeps its name.
    expect(sellerFilterLabel(new Set<SellerKey>(["gone"]), options)).toBe(
      "gone",
    );
    expect(sellerFilterLabel(new Set<SellerKey>([null]), [])).toBe(
      NO_SELLER_LABEL,
    );
  });
});
