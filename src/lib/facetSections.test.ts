import { describe, expect, it } from "vitest";
import {
  LISTING_FACETS,
  dishonestFacetDefaults,
  facetBadgeCount,
  facetDefaultSelection,
  facetSection,
  facetSectionKey,
  type FacetSection,
} from "./facetSections";

describe("facetSectionKey", () => {
  it("namespaces by page so two screens don't share collapse state", () => {
    expect(facetSectionKey("listings", "status")).toBe("facet:listings:status");
    expect(facetSectionKey("listings", "status")).not.toBe(
      facetSectionKey("collection", "status"),
    );
  });

  it("gives each facet on a page its own key", () => {
    const keys = LISTING_FACETS.map((f) => facetSectionKey("listings", f.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("facetSection", () => {
  it("finds a facet by key", () => {
    expect(facetSection(LISTING_FACETS, "match").label).toBe("Match");
  });

  it("throws on an unknown key rather than returning undefined", () => {
    // A missing facet is a typo at a call site. Silently rendering a
    // label-less, never-collapsing section would hide it.
    expect(() => facetSection(LISTING_FACETS, "nope")).toThrow(
      /unknown facet section/,
    );
  });
});

describe("facetDefaultSelection", () => {
  it("returns the facet's checked-by-default options", () => {
    expect([...facetDefaultSelection(LISTING_FACETS, "status")]).toEqual([
      "active",
    ]);
    expect(facetDefaultSelection(LISTING_FACETS, "match").size).toBe(0);
  });

  it("returns a fresh Set each call", () => {
    // The page holds this in state and mutates copies of it; a shared Set
    // would let one screen's edit leak into the next reset.
    const a = facetDefaultSelection(LISTING_FACETS, "status");
    const b = facetDefaultSelection(LISTING_FACETS, "status");
    expect(a).not.toBe(b);
    a.clear();
    expect(b.size).toBe(1);
  });
});

describe("facetBadgeCount", () => {
  it("shows the checked count on a collapsed facet", () => {
    expect(facetBadgeCount(true, new Set(["a", "b"]))).toBe(2);
  });

  it("shows nothing on a collapsed facet that is checking nothing", () => {
    expect(facetBadgeCount(true, new Set())).toBeNull();
  });

  it("shows nothing while the checkboxes are on screen", () => {
    // Expanded, the checkmarks are the indicator; a badge beside them would
    // be a second way to say the same thing.
    expect(facetBadgeCount(false, new Set(["a"]))).toBeNull();
    expect(facetBadgeCount(false, new Set())).toBeNull();
  });
});

describe("default collapse state stays honest (DCH-35)", () => {
  it("never starts a facet collapsed while it is already narrowing", () => {
    // On first visit there is no badge to read yet — the user has expressed
    // no collapse opinion, so a section that both hides itself and filters
    // is a filter with no way to discover it.
    expect(dishonestFacetDefaults(LISTING_FACETS)).toEqual([]);
  });

  it("catches a facet that starts collapsed with a selection", () => {
    const bad: FacetSection[] = [
      {
        key: "status",
        label: "Status",
        defaultCollapsed: true,
        defaultSelected: ["active"],
      },
      {
        key: "type",
        label: "Type",
        defaultCollapsed: true,
        defaultSelected: [],
      },
    ];
    expect(dishonestFacetDefaults(bad)).toEqual(["status"]);
  });

  it("still collapses something, or the panel is as tall as before", () => {
    // DCH-43 exists because four full-height facets pushed the sticky panel
    // past the scrollport. Defaults that expand everything would ship the
    // collapse control and none of the fix.
    expect(LISTING_FACETS.some((f) => f.defaultCollapsed)).toBe(true);
  });
});
