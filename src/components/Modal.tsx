import {
  FormEvent,
  ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from "react";
import { depthOf, isTopmost, popModal, pushModal } from "@/lib/modalStack";

/** The one dialog surface (DCH-32).
 *
 *  Ten dialogs were hand-built at their call sites and disagreed on four
 *  z-layers, five vertical placements, whether Escape closed them, whether a
 *  backdrop click closed them, and whether a screen reader was told a dialog
 *  had opened at all. Dismissal is muscle memory: a user who learns Escape
 *  closes the wishlist picker will press it in the saved-search editor, and
 *  "nothing happens" reads as broken rather than as inconsistent.
 *
 *  Callers supply content. Backdrop, centring, stacking, dismissal and the
 *  ARIA contract belong here and are not overridable — that's the point.
 */

/** The documented z-scale. Anything outside it is a bug; see the UI
 *  conventions in CLAUDE.md.
 *
 *  - `z-30` dropdown scrim and sticky page furniture
 *  - `z-40` dropdown menus and app-level banners
 *  - `z-50` a modal
 *  - `z-60` a modal opened from inside a modal
 *
 *  Nested modals are DOM descendants of their parent, so they would paint on
 *  top even at equal z-index. The explicit layer is what keeps that true if
 *  one is ever portalled or reordered. */
const LAYER = ["z-50", "z-60"] as const;

export function layerClass(depth: number): string {
  return LAYER[Math.min(depth, LAYER.length - 1)];
}

export interface ModalProps {
  /** Accessible name, always required. Used as the heading unless `header`
   *  replaces the default title block, in which case it still labels the
   *  dialog for assistive tech. */
  title: string;
  /** Secondary line under the title — context about what's being edited. */
  description?: ReactNode;
  /** Replaces the whole default title block. For dialogs whose chrome is
   *  richer than a heading (an image, an external link). `title` still
   *  supplies the accessible name. */
  header?: ReactNode;
  children: ReactNode;
  /** Right-aligned action row, separated by a rule. */
  footer?: ReactNode;
  onClose: () => void;
  /** Tailwind max-width for the panel. */
  size?: string;
  /** Extra classes on the panel, for dialogs that manage their own layout
   *  (`flex flex-col` with an internal scroll region). */
  panelClassName?: string;
  /** `"panel"` caps the panel height and scrolls it — right for ordinary
   *  forms. `"none"` leaves height to `panelClassName`, for dialogs that
   *  scroll an inner region instead so their header and footer stay put. */
  scroll?: "panel" | "none";
  /** A save is in flight: Escape and backdrop click go inert so a stray key
   *  can't discard a half-written form mid-request. The close button hides
   *  for the same reason. */
  busy?: boolean;
  /** Renders the panel as a `<form>` and wires submit. */
  onSubmit?: (e: FormEvent) => void;
  /** Hide the × affordance. For dialogs whose only exit is a decision. */
  hideClose?: boolean;
}

export function Modal({
  title,
  description,
  header,
  children,
  footer,
  onClose,
  size = "max-w-lg",
  panelClassName = "",
  scroll = "panel",
  busy = false,
  onSubmit,
  hideClose = false,
}: ModalProps) {
  const id = useId();
  const [depth, setDepth] = useState(0);

  // Layout effect, not a plain effect: the depth decides the z-class, and
  // this has to settle before the browser paints or a nested dialog would
  // flash at its parent's layer.
  useLayoutEffect(() => {
    pushModal(id);
    setDepth(depthOf(id));
    return () => popModal(id);
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `isTopmost` is what stops one Escape from collapsing a whole stack:
      // every open modal has this listener attached.
      if (e.key === "Escape" && !busy && isTopmost(id)) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, busy, onClose]);

  const labelId = `${id}-title`;
  const Panel = onSubmit ? "form" : "div";

  return (
    <div
      className={`fixed inset-0 ${layerClass(depth)} flex items-center justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4`}
      // mousedown, not click: a click that *starts* inside the panel and
      // ends on the backdrop (dragging to select text past the edge) would
      // otherwise dismiss the dialog and lose the input.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <Panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onSubmit={onSubmit}
        className={`card w-full ${size} ${
          scroll === "panel" ? "max-h-[90vh] overflow-y-auto" : ""
        } ${panelClassName}`}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          {header ?? (
            <div className="min-w-0">
              <h3 id={labelId} className="text-base font-medium">
                {title}
              </h3>
              {description && (
                <div className="text-xs text-fg-subtle mt-0.5">
                  {description}
                </div>
              )}
            </div>
          )}
          {/* When `header` is supplied it owns the visible heading, so the
              accessible name comes from this hidden label instead. */}
          {header && (
            <span id={labelId} className="sr-only">
              {title}
            </span>
          )}
          {!hideClose && !busy && (
            <button
              type="button"
              className="text-fg-muted hover:text-fg text-xl leading-none px-2 shrink-0"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>

        {children}

        {footer && (
          <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-border">
            {footer}
          </div>
        )}
      </Panel>
    </div>
  );
}
