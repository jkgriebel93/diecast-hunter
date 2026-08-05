import { createElement, useState, type DragEvent, type ReactNode } from "react";
import { VIEWS, type ViewId } from "@/lib/views";
import { useWorkspace, type Pane } from "@/lib/workspace";

const DRAG_MIME = "application/x-dh-tab";

interface DragPayload {
  fromPaneId: string;
  view: ViewId;
}

/**
 * One editor group: a tab strip plus the stacked content of every open tab.
 * Inactive tabs stay mounted (hidden with `hidden`) so switching tabs preserves
 * each page's scroll position and in-progress state — the same behavior a code
 * editor gives you when flipping between open files.
 */
export function EditorPane({
  pane,
  isActive,
  paneCount,
}: {
  pane: Pane;
  isActive: boolean;
  paneCount: number;
}) {
  const ws = useWorkspace();
  const [dragOver, setDragOver] = useState(false);

  function readDrag(e: DragEvent): DragPayload | null {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DragPayload;
    } catch {
      return null;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const payload = readDrag(e);
    if (payload && payload.fromPaneId !== pane.id) {
      ws.moveTab(payload.fromPaneId, pane.id, payload.view);
    }
  }

  function onDragOver(e: DragEvent) {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      setDragOver(true);
    }
  }

  return (
    <section
      className={`flex flex-col h-full min-w-0 flex-1 ${
        isActive ? "" : "opacity-[0.985]"
      }`}
      onMouseDownCapture={() => {
        if (!isActive) ws.focus(pane.id);
      }}
    >
      <div
        className={`flex items-stretch border-b bg-bg-panel ${
          isActive ? "border-border" : "border-border/60"
        }`}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="flex-1 flex items-stretch overflow-x-auto">
          {pane.tabs.map((view) => (
            <Tab
              key={view}
              view={view}
              paneId={pane.id}
              active={pane.activeTab === view}
              paneFocused={isActive}
            />
          ))}
        </div>
        <div className="flex items-center gap-0.5 px-1 border-l border-border/60 shrink-0">
          {ws.canSplit && (
            <PaneButton
              label="Split editor right"
              onClick={() => {
                ws.focus(pane.id);
                ws.split();
              }}
            >
              <SplitIcon />
            </PaneButton>
          )}
          {paneCount > 1 && (
            <PaneButton
              label="Close this group"
              onClick={() => ws.closePane(pane.id)}
            >
              <CloseIcon />
            </PaneButton>
          )}
        </div>
      </div>

      <div
        className={`relative flex-1 min-h-0 ${
          dragOver
            ? "outline outline-2 -outline-offset-2 outline-accent/60"
            : ""
        }`}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {pane.tabs.map((view) => (
          <div
            key={view}
            className={`absolute inset-0 overflow-auto ${
              pane.activeTab === view ? "" : "hidden"
            }`}
          >
            {createElement(VIEWS[view].Component)}
          </div>
        ))}
      </div>
    </section>
  );
}

function Tab({
  view,
  paneId,
  active,
  paneFocused,
}: {
  view: ViewId;
  paneId: string;
  active: boolean;
  paneFocused: boolean;
}) {
  const ws = useWorkspace();
  const label = VIEWS[view].label;

  function onDragStart(e: DragEvent) {
    const payload: DragPayload = { fromPaneId: paneId, view };
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onMouseDown={() => ws.activate(paneId, view)}
      onAuxClick={(e) => {
        // Middle-click closes, like a browser/editor tab.
        if (e.button === 1) {
          e.preventDefault();
          ws.close(paneId, view);
        }
      }}
      title={label}
      className={`group/tab flex items-center gap-2 pl-3 pr-1.5 py-2 text-sm border-r border-border/60 cursor-pointer select-none max-w-[14rem] ${
        active
          ? paneFocused
            ? "bg-bg text-fg border-t-2 border-t-accent -mt-px"
            : "bg-bg text-fg border-t-2 border-t-fg-subtle/50 -mt-px"
          : "text-fg-muted hover:text-fg hover:bg-bg-elevated/60"
      }`}
    >
      <span className="truncate">{label}</span>
      <button
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          ws.close(paneId, view);
        }}
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        className={`rounded p-0.5 text-fg-subtle hover:text-fg hover:bg-bg-elevated ${
          active ? "" : "opacity-0 group-hover/tab:opacity-100"
        }`}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function PaneButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded p-1.5 text-fg-muted hover:text-fg hover:bg-bg-elevated transition-colors"
    >
      {children}
    </button>
  );
}

function SplitIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
