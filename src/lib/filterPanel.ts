/**
 * The Saved Listings filter panel as a scrolling accordion (DCH-47).
 *
 * DCH-43 kept the panel short by collapsing the facets that start empty.
 * That bought room; it did not buy a bound. The panel is `sticky`, so its
 * height is a hard budget — content past the fold of the scrollport can
 * never be scrolled to, because scrolling the page is exactly what stops
 * moving the panel. Every filter added since spent against that budget, and
 * *Clear filters* sat at the bottom of the stack, so the way out of an
 * over-narrowed list was the first thing to fall off.
 *
 * The fix is to give the panel its own scroll region, with the search box
 * pinned above it and Clear pinned below it, and to let every section
 * collapse rather than only the checkbox facets. Two consequences follow,
 * and both live here:
 *
 * 1. **A collapsed section must still say what it is doing.** DCH-43 used a
 *    count badge, which could say "2" but not *which* two. A section that
 *    holds a combobox or a year range has no count to show at all. So the
 *    header carries a {@link FilterSummary} instead — the same words the
 *    control itself would show — rendered in accent when it is narrowing.
 * 2. **The panel's height has to be measured, not assumed.** The obvious
 *    `max-h-[calc(100vh-2rem)]` is wrong twice over: the panel sticks inside
 *    `EditorPane`'s scrollport rather than the window, and until it actually
 *    sticks it starts below the page header rather than at the sticky
 *    offset. Either error leaves the footer hanging just past the fold —
 *    the original bug in miniature, since that footer is *Clear filters*.
 *    See {@link useStickyMaxHeight}.
 */

import { useLayoutEffect, useState } from "react";

import { describeRange, isEmptyRange, type YearRange } from "./yearRange";

/** What one section's header shows when it is collapsed (and, since it
 *  costs nothing and helps, when it is open too). */
export interface FilterSummary {
  /** Plain words, e.g. "Any", "Unmatched", "2 selected", "1 excluded". */
  text: string;
  /** True when this section is narrowing the list, which is what earns the
   *  accent colour. Not the same as "the user touched it": Status starts on
   *  "Active", and a section sitting at its default is not narrowing
   *  anything the user didn't already agree to. */
  active: boolean;
}

/** What an untouched section says. Deliberately not "All" — the Group select
 *  already uses "All" for one of its real values, and two meanings for one
 *  word in the same panel is how a summary stops being readable. */
export const ANY_SUMMARY = "Any";

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/**
 * Summary for a checkbox facet (Status, Match, Offer, Type).
 *
 * One checked option is named, because the name is the whole answer. Past
 * one, a count beats a truncated list — "Confirmed, Unconf…" tells you less
 * than "2 selected" and takes more room to do it.
 */
export function facetSummary(
  options: readonly { value: string; label: string }[],
  selected: ReadonlySet<string>,
  defaultSelected: readonly string[],
): FilterSummary {
  const active = !setsEqual(selected, new Set(defaultSelected));
  if (selected.size === 0) return { text: ANY_SUMMARY, active };
  if (selected.size === 1) {
    const [only] = selected;
    // Falling back to the raw value keeps a stale selection legible rather
    // than blank — an option can disappear when the underlying rows change.
    const label = options.find((o) => o.value === only)?.label ?? only;
    return { text: label, active };
  }
  return { text: `${selected.size} selected`, active };
}

/** Summary for the year range, reusing the same words the range itself
 *  renders elsewhere ("1998–2003", "1998 or later"). */
export function yearSummary(range: YearRange): FilterSummary {
  return {
    text: describeRange(range) ?? ANY_SUMMARY,
    active: !isEmptyRange(range),
  };
}

/**
 * Summary for the Group section, which is two controls in one: a single-pick
 * select and a multi-pick exclude menu. Both are folded into one line
 * because they share a header — a collapsed section that reported only half
 * its state would be exactly the dishonesty the summary exists to prevent.
 */
export function groupSummary(
  groupFilter: string,
  /** Display name of the selected group, when `groupFilter` is an id. */
  groupName: string | null,
  excludedCount: number,
): FilterSummary {
  const parts: string[] = [];
  if (groupFilter === "none") parts.push("Ungrouped");
  else if (groupFilter !== "all") parts.push(groupName ?? "1 group");
  if (excludedCount > 0) {
    parts.push(`${excludedCount} excluded`);
  }
  return {
    text: parts.length > 0 ? parts.join(" · ") : ANY_SUMMARY,
    active: groupFilter !== "all" || excludedCount > 0,
  };
}

/**
 * A section holding a single control rather than a checkbox list.
 *
 * The checkbox facets keep their own table in `facetSections.ts` because
 * they carry a default *selection* as well; these carry only a label and a
 * starting collapse state. Both tables feed the same `facetSectionKey`, so a
 * user's collapse choices survived DCH-47 unchanged.
 */
export interface ControlSection {
  key: string;
  label: string;
  defaultCollapsed: boolean;
}

/** Driver stays open: it is the filter reached for most after Status, and
 *  the one whose control is least guessable from its summary. The rest
 *  start collapsed — the panel's resting height is the thing being
 *  protected, and each of these is one line of summary when shut. */
export const LISTING_CONTROL_SECTIONS: readonly ControlSection[] = [
  { key: "driver", label: "Driver", defaultCollapsed: false },
  { key: "seller", label: "Seller", defaultCollapsed: true },
  { key: "year", label: "Year", defaultCollapsed: true },
  { key: "group", label: "Group", defaultCollapsed: true },
];

/** Look up a control section by key. Throws rather than returning undefined,
 *  for the same reason `facetSection` does: a miss is a typo at a call site. */
export function controlSection(key: string): ControlSection {
  const found = LISTING_CONTROL_SECTIONS.find((s) => s.key === key);
  if (!found) throw new Error(`unknown filter section: ${key}`);
  return found;
}

/** Below this, a scrolling panel is a peephole — several sections' worth of
 *  chrome around one visible row. Past this point letting the panel overhang
 *  is the better failure: the page scrolls, and a window this short has
 *  worse problems than the filter panel. */
export const MIN_PANEL_HEIGHT = 240;

/**
 * The tallest the panel may be and still end above the fold.
 *
 * `available` is the distance from the panel's own top edge to the bottom of
 * the scrollport — measured, not assumed. Sizing against the scrollport's
 * full height instead would be right only while the panel is stuck: at rest
 * it starts below the page header, so a panel that tall hangs its footer
 * past the fold until you scroll. That footer is *Clear filters*, and it
 * being the part you have to go looking for is the whole ticket.
 *
 * `gap` matches the sticky `top-4` inset, so the panel is inset from the
 * bottom by as much as from the top once stuck — a flush footer reads as cut
 * off even when it isn't.
 */
export function stickyPanelMaxHeight(
  available: number,
  gap: number,
  min: number = MIN_PANEL_HEIGHT,
): number {
  return Math.max(min, available - gap);
}

/** Which edges of a scroll region have content beyond them. Drives the
 *  fades: a fade that is always on dims content that isn't cut, and a
 *  scroller with no fade at all is the reason nobody notices it scrolls. */
export interface ScrollEdges {
  scrollable: boolean;
  atTop: boolean;
  atBottom: boolean;
}

/** `tolerance` absorbs sub-pixel layout and elastic overscroll, either of
 *  which otherwise leaves a fade flickering at a resting scroll position. */
export function scrollEdgeState(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  tolerance = 2,
): ScrollEdges {
  const scrollable = scrollHeight - clientHeight > tolerance;
  if (!scrollable) return { scrollable: false, atTop: true, atBottom: true };
  return {
    scrollable: true,
    atTop: scrollTop <= tolerance,
    atBottom: scrollTop + clientHeight >= scrollHeight - tolerance,
  };
}

/** Nearest ancestor that scrolls vertically. `EditorPane` renders one per
 *  open tab, so this is never the document in the real app — but the
 *  screenshot harness and any future embedding get the same answer without
 *  the panel having to be told where it is. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const overflowY = getComputedStyle(n).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return n;
  }
  return null;
}

/**
 * Cap a sticky panel so its foot always lands above the fold of the
 * scrollport it sticks inside.
 *
 * Returns a callback ref rather than taking one: the panel unmounts whenever
 * the sidebar is collapsed to its rail, and a plain `useRef` would leave the
 * effect measuring a detached node from the previous mount.
 *
 * Recomputed on scroll, because the panel's top moves until it sticks — it
 * starts below the page header and rises to the sticky offset. The cap
 * therefore grows as you scroll and settles once stuck; `setMaxHeight` bails
 * on an unchanged value, so a scroll past that point costs nothing.
 *
 * The initial value is measured against the window, which is an overestimate
 * for one frame and never an underestimate — the panel is briefly a little
 * too tall rather than briefly too short.
 */
export function useStickyMaxHeight(gap: number) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [maxHeight, setMaxHeight] = useState(() =>
    stickyPanelMaxHeight(window.innerHeight, gap),
  );

  useLayoutEffect(() => {
    if (!el) return;
    const port = scrollParent(el);
    const measure = () => {
      const fold = port
        ? port.getBoundingClientRect().bottom
        : window.innerHeight;
      setMaxHeight(
        stickyPanelMaxHeight(fold - el.getBoundingClientRect().top, gap),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(port ?? document.documentElement);
    // Capture phase: the scroller that moves this panel is an ancestor, and
    // scroll events don't bubble.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [el, gap]);

  return [setEl, maxHeight] as const;
}

/**
 * Track whether a scroll region has content past its top or bottom edge.
 *
 * Observes the scroller *and* its children: the scroller's own box never
 * changes when a section collapses, but the content inside it does, and a
 * collapse is the commonest way this region stops (or starts) needing to
 * scroll.
 */
export function useScrollEdges() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>({
    scrollable: false,
    atTop: true,
    atBottom: true,
  });

  useLayoutEffect(() => {
    if (!el) return;
    const measure = () =>
      setEdges(scrollEdgeState(el.scrollTop, el.scrollHeight, el.clientHeight));
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [el]);

  return [setEl, edges] as const;
}
