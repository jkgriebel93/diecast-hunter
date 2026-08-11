import { describe, expect, it } from "vitest";
import { MIN_MENU_HEIGHT, placeMenu, placementStyle } from "./anchoredMenu";

/** A trigger the width of the filter sidebar's inner column. `y` is its top
 *  edge; the defaults match a real control in the panel. */
function anchor(y: number, height = 24, left = 24, width = 184) {
  return { top: y, bottom: y + height, left, width };
}
const TALL = { width: 1280, height: 800 };
/** The window heights this bug actually shows up at (see DCH-43/47) — the
 *  panel only overflows once the viewport stops being generous. */
const SHORT = { width: 1280, height: 600 };

describe("placeMenu", () => {
  it("hangs below the trigger when there is room", () => {
    const p = placeMenu(anchor(100), TALL);
    expect(p.side).toBe("below");
    expect(p.top).toBe(128); // trigger bottom (124) + the 4px gap
    expect(p.bottom).toBeNull();
  });

  it("flips above when the trigger sits near the bottom", () => {
    // The Group section is last in the panel, so its Exclude menu is the one
    // that actually meets this case.
    const p = placeMenu(anchor(720), TALL);
    expect(p.side).toBe("above");
    expect(p.bottom).toBe(84); // 800 - 720 + 4
    expect(p.top).toBeNull();
  });

  it("stays below when below is tight but still the better side", () => {
    // 304px below against 248px above: less than the menu would like, more
    // than flipping would buy. Moving it here would be motion for nothing.
    const p = placeMenu(anchor(260), SHORT);
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(304);
  });

  it("prefers below on a tie, so the direction stays predictable", () => {
    const p = placeMenu(anchor(288), SHORT); // 276px either way
    expect(p.side).toBe("below");
  });

  it("ends inside the viewport rather than overflowing it", () => {
    const p = placeMenu(anchor(260), SHORT);
    expect(p.top! + p.maxHeight).toBeLessThanOrEqual(SHORT.height);
  });

  it("never shrinks below a usable height in a squeezed window", () => {
    // 220px tall: neither side can offer a real menu, so it overhangs. A
    // 90px-wide, 30px-tall sliver reads as a rendering bug, not as a list.
    const p = placeMenu(anchor(90), { width: 1280, height: 220 });
    expect(p.maxHeight).toBe(MIN_MENU_HEIGHT);
  });

  it("takes the trigger's width by default", () => {
    expect(placeMenu(anchor(100), TALL).width).toBe(184);
  });

  it("widens a narrow trigger to fit its contents", () => {
    // The Exclude chip is ~70px wide; its grouped list needs 14rem.
    const p = placeMenu(anchor(100, 22, 24, 70), TALL, { minWidth: 224 });
    expect(p.width).toBe(224);
    expect(p.left).toBe(24); // still aligned to the trigger's left edge
  });

  it("pulls a menu back inside the right edge", () => {
    const p = placeMenu(anchor(100, 22, 1200, 70), TALL, { minWidth: 224 });
    expect(p.left).toBe(1280 - 224 - 8);
  });

  it("keeps the margin when the viewport is narrower than the menu wants", () => {
    const p = placeMenu(
      anchor(100, 22, 4, 70),
      { width: 200, height: 800 },
      { minWidth: 224 },
    );
    expect(p.left).toBe(8);
    expect(p.width).toBe(200 - 16);
  });
});

describe("placementStyle", () => {
  it("emits top for a downward menu and bottom for an upward one", () => {
    expect(placementStyle(placeMenu(anchor(100), TALL))).toMatchObject({
      top: "128px",
    });
    const up = placementStyle(placeMenu(anchor(720), TALL));
    expect(up).toMatchObject({ bottom: "84px" });
    expect(up).not.toHaveProperty("top");
  });
});
