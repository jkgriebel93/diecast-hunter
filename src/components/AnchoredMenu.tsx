import { useEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  placementStyle,
  useAnchoredMenu,
  type MenuPlacementOptions,
} from "@/lib/anchoredMenu";

/**
 * The dropdown panel under a filter trigger (DCH-47).
 *
 * Three menus in Saved Listings' sidebar had grown their own copies of this:
 * a click-catching scrim, a bordered panel, an inner scroller capped at a
 * fixed height, and — in one of them — a hand-rolled flip-above-the-trigger
 * rule. They differed in ways nobody chose, and all three broke the same way
 * once the filter panel gained an `overflow` (see `lib/anchoredMenu.ts`).
 *
 * This is not `Modal`, and shouldn't become it: a dropdown is not a dialog.
 * It takes no focus trap, announces no `role="dialog"`, and closes on the
 * next click anywhere rather than demanding a decision. What it does share
 * is the z-scale — `z-30` for the scrim, `z-40` for the panel, the two
 * layers CLAUDE.md names for exactly this.
 */
export function AnchoredMenu({
  anchorRef,
  open,
  onClose,
  children,
  minWidth,
  maxHeight,
  label,
}: {
  /** The trigger. Position is read from it on open and re-read while open. */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Floor on the menu's width when the trigger is narrower than its
   *  contents — the Exclude chip is a third the width of its group list. */
  minWidth?: number;
  maxHeight?: number;
  /** Accessible name, e.g. "Drivers". */
  label: string;
}) {
  const options: MenuPlacementOptions = { minWidth, maxHeight };
  const placement = useAnchoredMenu(anchorRef, open, options);

  // Escape closes, matching every other dismissible surface in the app. The
  // listener is only bound while open, so it can't shadow a dialog's.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || placement === null) return null;
  // Portalled to the body, not left beside its trigger. Being fixed is
  // enough to escape the filter panel's clipping, but not enough to escape
  // its *scrolling*: a menu rendered in the panel's subtree is still a DOM
  // descendant of the scroller, so autofocusing the search box makes the
  // browser scroll the panel to "reveal" an element that never moved. The
  // panel would jump every time a menu opened.
  return createPortal(
    <>
      {/* Invisible, full-viewport, and *not* a modal backdrop: no tint, no
          blur, no focus trap. Its only job is to turn the next click
          anywhere into a dismissal. */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        role="group"
        aria-label={label}
        className="fixed z-40 flex flex-col rounded border border-border bg-bg-elevated shadow-lg py-1"
        style={placementStyle(placement)}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/** The scrolling body of a menu. `min-h-0` is what lets it actually shrink
 *  inside the flex column — without it a long list pushes the panel past the
 *  measured `maxHeight` and the footer row goes off-screen. */
export function AnchoredMenuList({ children }: { children: ReactNode }) {
  return <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>;
}
