/**
 * Placement for a dropdown menu anchored to a trigger (DCH-47).
 *
 * The three menus in Saved Listings' filter sidebar — Driver, Seller and
 * Exclude — used to be `position: absolute` inside the panel. That worked
 * only because the panel had no `overflow`, which was the same fact that
 * made the panel unscrollable and its tail unreachable. Giving the panel its
 * own scroll region fixes the tail and clips the menus, so the menus have to
 * stop being positioned by the panel at all.
 *
 * `position: fixed` is the fix: a fixed box's containing block is the
 * viewport, so no `overflow` ancestor can clip it. The cost is that the
 * browser no longer keeps it attached to the trigger — coordinates have to
 * be computed, which is what this module does, and recomputed while the menu
 * is open, which is what {@link useAnchoredMenu} does.
 *
 * The maths is separated from the DOM so the interesting cases — no room
 * below, no room either way, a trigger near the right edge — are unit tests
 * rather than something you have to shrink a window to see.
 */

import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/** The parts of a `DOMRect` placement actually reads. */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface MenuPlacementOptions {
  /** Menus are at least as wide as their trigger; this raises the floor for
   *  triggers narrower than their content (the Exclude button is a chip). */
  minWidth?: number;
  /** The tallest the menu would like to be with room to spare. */
  maxHeight?: number;
  /** Space between trigger and menu. */
  gap?: number;
  /** Space kept clear of the viewport edges. */
  margin?: number;
}

/** Below this a menu is a sliver: no room for the search box and a row, so
 *  it would read as a rendering glitch rather than as a list. When neither
 *  direction can offer this much the menu takes it anyway and overhangs the
 *  viewport — being slightly off-screen beats being 20px tall. */
export const MIN_MENU_HEIGHT = 96;

export interface MenuPlacement {
  left: number;
  width: number;
  /** Distance from the viewport top, when the menu hangs below the trigger.
   *  Exactly one of `top` / `bottom` is a number. */
  top: number | null;
  /** Distance from the viewport bottom, when the menu hangs above. */
  bottom: number | null;
  maxHeight: number;
  /** Which side it landed on — the caller uses it for the open animation
   *  and it makes the tests read as intent rather than as coordinates. */
  side: "below" | "above";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where to put a menu for the given trigger.
 *
 * Below is the default because it is the familiar direction and keeps the
 * reading order; the menu flips above only when that genuinely buys room.
 * Note the comparison is against the space each side offers, not against the
 * menu's *content* height — the content is inside a scroller, so a short
 * menu in a tall gap is fine while a tall menu in a short gap is not.
 */
export function placeMenu(
  anchor: AnchorRect,
  viewport: Viewport,
  options: MenuPlacementOptions = {},
): MenuPlacement {
  const { minWidth = 0, maxHeight = 320, gap = 4, margin = 8 } = options;

  const width = clamp(
    Math.max(anchor.width, minWidth),
    0,
    viewport.width - margin * 2,
  );
  const left = clamp(anchor.left, margin, viewport.width - width - margin);

  const roomBelow = viewport.height - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  // Flip only when above is both sufficient and better. A trigger sitting in
  // a short window has too little room either way; down is the one users
  // expect, so ties and near-ties stay down.
  const below = roomBelow >= maxHeight || roomBelow >= roomAbove;

  const room = below ? roomBelow : roomAbove;
  return {
    left,
    width,
    top: below ? anchor.bottom + gap : null,
    bottom: below ? null : viewport.height - anchor.top + gap,
    maxHeight: clamp(room, MIN_MENU_HEIGHT, maxHeight),
    side: below ? "below" : "above",
  };
}

/** Placement as inline styles. Kept next to {@link placeMenu} so the two
 *  can't drift about which of `top` / `bottom` is authoritative. */
export function placementStyle(p: MenuPlacement): CSSProperties {
  return {
    left: `${p.left}px`,
    width: `${p.width}px`,
    maxHeight: `${p.maxHeight}px`,
    ...(p.top !== null ? { top: `${p.top}px` } : { bottom: `${p.bottom}px` }),
  };
}

/**
 * Track a trigger's position while its menu is open.
 *
 * Recomputed on scroll (capture phase, so it catches *any* scroller between
 * the trigger and the root — the filter panel's own is one of them) and on
 * resize. Without that a fixed menu detaches from its trigger the moment
 * anything moves, which is the one regression this approach can introduce.
 */
export function useAnchoredMenu(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: MenuPlacementOptions = {},
): MenuPlacement | null {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const { minWidth, maxHeight, gap, margin } = options;

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPlacement(
        placeMenu(
          { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
          { width: window.innerWidth, height: window.innerHeight },
          { minWidth, maxHeight, gap, margin },
        ),
      );
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef, open, minWidth, maxHeight, gap, margin]);

  return placement;
}
