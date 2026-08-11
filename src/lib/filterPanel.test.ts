import { describe, expect, it } from "vitest";
import {
  ANY_SUMMARY,
  LISTING_CONTROL_SECTIONS,
  MIN_PANEL_HEIGHT,
  controlSection,
  facetSummary,
  groupSummary,
  scrollEdgeState,
  stickyPanelMaxHeight,
  yearSummary,
} from "./filterPanel";
import { LISTING_FACETS, facetSection } from "./facetSections";
import { EMPTY_YEAR_RANGE } from "./yearRange";

const STATUS = [
  { value: "active", label: "Active" },
  { value: "ended", label: "Ended" },
  { value: "archived", label: "Archived" },
];
const MATCH = [
  { value: "confirmed", label: "Confirmed" },
  { value: "unconfirmed", label: "Unconfirmed" },
  { value: "unmatched", label: "Unmatched" },
];

describe("facetSummary", () => {
  it("names the one checked option", () => {
    // The point of the summary over DCH-43's count badge: "1" told you a
    // hidden facet was filtering, not what it was filtering to.
    expect(facetSummary(MATCH, new Set(["unmatched"]), [])).toEqual({
      text: "Unmatched",
      active: true,
    });
  });

  it("counts past one rather than truncating a list", () => {
    expect(
      facetSummary(MATCH, new Set(["confirmed", "unmatched"]), []).text,
    ).toBe("2 selected");
  });

  it("says Any when nothing is checked", () => {
    expect(facetSummary(MATCH, new Set(), [])).toEqual({
      text: ANY_SUMMARY,
      active: false,
    });
  });

  it("does not call a facet sitting at its default active", () => {
    // Status ships checked on Active. Painting it accent would put the panel
    // permanently in a filtering-you-didn't-ask-for state.
    expect(facetSummary(STATUS, new Set(["active"]), ["active"])).toEqual({
      text: "Active",
      active: false,
    });
  });

  it("calls a facet cleared away from a non-empty default active", () => {
    // Unchecking Active shows ended and archived rows too — a real change
    // from the default, and one `activeFilterCount` already counts.
    expect(facetSummary(STATUS, new Set(), ["active"])).toEqual({
      text: ANY_SUMMARY,
      active: true,
    });
  });

  it("falls back to the raw value when the option has gone", () => {
    // Options come from the loaded rows, so a selection can outlive the
    // option that offered it. Blank would be worse than unlovely.
    expect(facetSummary(MATCH, new Set(["retired"]), []).text).toBe("retired");
  });
});

describe("yearSummary", () => {
  it("reuses the range's own words", () => {
    expect(yearSummary({ from: 1998, to: 2003 })).toEqual({
      text: "1998–2003",
      active: true,
    });
    expect(yearSummary({ from: 1998, to: null }).text).toBe("1998 or later");
  });

  it("says Any for an unset range", () => {
    expect(yearSummary(EMPTY_YEAR_RANGE)).toEqual({
      text: ANY_SUMMARY,
      active: false,
    });
  });
});

describe("groupSummary", () => {
  it("says Any when neither control is set", () => {
    expect(groupSummary("all", null, 0)).toEqual({
      text: ANY_SUMMARY,
      active: false,
    });
  });

  it("names the selected group", () => {
    expect(groupSummary("7", "Goodwrench hunt", 0)).toEqual({
      text: "Goodwrench hunt",
      active: true,
    });
  });

  it("reports exclusions on their own", () => {
    expect(groupSummary("all", null, 1)).toEqual({
      text: "1 excluded",
      active: true,
    });
  });

  it("reports both halves when both are set", () => {
    // Group is two controls under one header. A summary that showed only the
    // select would hide an exclusion that is narrowing the list — exactly
    // the dishonesty a collapsed section has to avoid.
    expect(groupSummary("none", null, 3).text).toBe("Ungrouped · 3 excluded");
  });

  it("survives a group whose name is not loaded yet", () => {
    expect(groupSummary("7", null, 0).text).toBe("1 group");
  });
});

describe("the section tables", () => {
  it("starts Status and Driver open and everything else collapsed", () => {
    const open = [
      ...LISTING_FACETS.filter((f) => !f.defaultCollapsed).map((f) => f.key),
      ...LISTING_CONTROL_SECTIONS.filter((s) => !s.defaultCollapsed).map(
        (s) => s.key,
      ),
    ];
    expect(open).toEqual(["status", "driver"]);
  });

  it("gives every section a distinct key across both tables", () => {
    // Both tables feed one `facetSectionKey` namespace, so a collision would
    // make two sections collapse each other.
    const keys = [
      ...LISTING_FACETS.map((f) => f.key),
      ...LISTING_CONTROL_SECTIONS.map((s) => s.key),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("throws on an unknown key rather than rendering a blank header", () => {
    expect(() => controlSection("colour")).toThrow(/colour/);
    expect(() => facetSection(LISTING_FACETS, "colour")).toThrow(/colour/);
  });
});

describe("stickyPanelMaxHeight", () => {
  const GAP = 16;

  it("leaves a gap below the panel", () => {
    expect(stickyPanelMaxHeight(668, GAP)).toBe(652);
  });

  it("insets the panel equally at both ends once it is stuck", () => {
    // Stuck, the panel's top sits `gap` below the scrollport's, so the
    // space it has is the port height less one gap — and taking another
    // leaves it symmetrically inset. A flush footer reads as cut off.
    const port = 700;
    expect(stickyPanelMaxHeight(port - GAP, GAP)).toBe(port - GAP * 2);
  });

  it("shrinks the panel while it still sits below the page header", () => {
    // The bug this replaced: sizing against the port's *full* height is
    // right only while stuck. At rest the panel starts under the header, so
    // a panel that tall hangs its footer — Clear filters — past the fold
    // until you scroll, which is the original defect in miniature.
    const port = 488;
    const atRest = stickyPanelMaxHeight(port - 78, GAP);
    const stuck = stickyPanelMaxHeight(port - GAP, GAP);
    expect(atRest).toBeLessThan(stuck);
  });

  it("measures the scrollport, not the window", () => {
    // `100vh - 2rem` overshoots by the height of EditorPane's tab strip.
    const viewport = 700;
    const tabStrip = 33;
    expect(stickyPanelMaxHeight(viewport - tabStrip, GAP)).toBeLessThan(
      stickyPanelMaxHeight(viewport, GAP),
    );
  });

  it("stops shrinking at a floor rather than becoming a peephole", () => {
    expect(stickyPanelMaxHeight(120, GAP)).toBe(MIN_PANEL_HEIGHT);
  });
});

describe("scrollEdgeState", () => {
  it("reports no edges when the content fits", () => {
    expect(scrollEdgeState(0, 300, 300)).toEqual({
      scrollable: false,
      atTop: true,
      atBottom: true,
    });
  });

  it("marks the bottom edge as cut when parked at the top", () => {
    expect(scrollEdgeState(0, 900, 400)).toEqual({
      scrollable: true,
      atTop: true,
      atBottom: false,
    });
  });

  it("marks both edges as cut in the middle", () => {
    expect(scrollEdgeState(200, 900, 400)).toMatchObject({
      atTop: false,
      atBottom: false,
    });
  });

  it("marks the top edge as cut when scrolled to the end", () => {
    expect(scrollEdgeState(500, 900, 400)).toMatchObject({
      atTop: false,
      atBottom: true,
    });
  });

  it("tolerates sub-pixel rounding at both ends", () => {
    // Without this the fades flicker at a resting scroll position, which
    // looks like a bug in the thing that exists to explain the scrolling.
    expect(scrollEdgeState(1, 900, 400).atTop).toBe(true);
    expect(scrollEdgeState(499, 900, 400).atBottom).toBe(true);
  });

  it("treats a one-pixel overflow as not scrollable", () => {
    expect(scrollEdgeState(0, 401, 400).scrollable).toBe(false);
  });
});
