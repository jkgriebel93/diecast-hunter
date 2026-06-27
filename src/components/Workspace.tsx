import { Fragment, useEffect, useRef, useState } from "react";
import { EditorPane } from "@/components/EditorPane";
import { useWorkspace } from "@/lib/workspace";

const MIN_RATIO = 0.15;

/**
 * The content area: every open pane laid out side by side, with draggable
 * dividers between them. Pane widths are kept as flex-grow ratios in local
 * state and reset to equal when panes are added or removed.
 */
export function Workspace() {
  const { state } = useWorkspace();
  const panes = state.panes;
  const count = panes.length;

  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(() => panes.map(() => 1));

  // Re-balance to equal widths whenever the number of panes changes.
  useEffect(() => {
    setSizes((prev) =>
      prev.length === count ? prev : Array.from({ length: count }, () => 1),
    );
  }, [count]);

  function startResize(index: number, e: React.PointerEvent) {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX;
    const base = sizes.length === count ? [...sizes] : panes.map(() => 1);
    const total = base.reduce((a, b) => a + b, 0);
    const minSize = MIN_RATIO * total;

    function onMove(ev: PointerEvent) {
      const delta = ((ev.clientX - startX) / rect!.width) * total;
      const next = [...base];
      let a = base[index] + delta;
      let b = base[index + 1] - delta;
      // Clamp so neither neighbor drops below the minimum.
      if (a < minSize) {
        b -= minSize - a;
        a = minSize;
      }
      if (b < minSize) {
        a -= minSize - b;
        b = minSize;
      }
      next[index] = a;
      next[index + 1] = b;
      setSizes(next);
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div ref={containerRef} className="flex-1 flex h-full min-w-0">
      {panes.map((pane, i) => (
        <Fragment key={pane.id}>
          <div
            className="flex min-w-0 h-full"
            style={{ flexGrow: sizes[i] ?? 1, flexBasis: 0 }}
          >
            <EditorPane
              pane={pane}
              isActive={pane.id === state.activePaneId}
              paneCount={count}
            />
          </div>
          {i < count - 1 && (
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={(e) => startResize(i, e)}
              className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-accent/60 active:bg-accent transition-colors"
              title="Drag to resize"
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
