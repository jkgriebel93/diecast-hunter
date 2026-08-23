import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { DEFAULT_VIEW, isViewId, type ViewId } from "./views";

/**
 * Split-view workspace state. Mirrors a text editor's editor groups: the
 * content area is one or more side-by-side panes, each holding its own set of
 * open tabs and one active tab. Exactly one pane is "active" (focused) at a
 * time — that's the pane the sidebar and keyboard target.
 */

export interface Pane {
  id: string;
  tabs: ViewId[];
  activeTab: ViewId;
}

export interface WorkspaceState {
  panes: Pane[];
  activePaneId: string;
}

const MAX_PANES = 3;
const STORAGE_KEY = "workspace.v1";

type Action =
  /** Open a view as a tab in the active pane (or focus it if already open). */
  | { type: "open"; view: ViewId }
  /** Open a view in a brand-new pane to the right, and focus it. */
  | { type: "openInNewPane"; view: ViewId }
  /** Duplicate the active pane's active tab into a new pane to the right. */
  | { type: "split" }
  /** Make a tab active and focus its pane. */
  | { type: "activate"; paneId: string; view: ViewId }
  /** Focus a pane without changing its active tab. */
  | { type: "focus"; paneId: string }
  /** Close a tab; closes/collapses the pane if it was the last one. */
  | { type: "close"; paneId: string; view: ViewId }
  /** Close an entire pane. */
  | { type: "closePane"; paneId: string }
  /** Move a tab from one pane to another. */
  | { type: "moveTab"; fromPaneId: string; toPaneId: string; view: ViewId };

function newPaneId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `pane-${crypto.randomUUID()}`;
  }
  return `pane-${Math.floor(Math.random() * 1e9)}`;
}

function makePane(view: ViewId): Pane {
  return { id: newPaneId(), tabs: [view], activeTab: view };
}

function initialState(): WorkspaceState {
  const pane = makePane(DEFAULT_VIEW);
  return { panes: [pane], activePaneId: pane.id };
}

/** Pick the tab to make active after removing `removed` from `tabs`. */
function neighborTab(tabs: ViewId[], removed: ViewId): ViewId {
  const idx = tabs.indexOf(removed);
  const remaining = tabs.filter((t) => t !== removed);
  if (remaining.length === 0) return removed;
  return remaining[Math.min(idx, remaining.length - 1)];
}

function indexOfPane(state: WorkspaceState, paneId: string): number {
  return state.panes.findIndex((p) => p.id === paneId);
}

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "open": {
      const panes = state.panes.map((p) => {
        if (p.id !== state.activePaneId) return p;
        const tabs = p.tabs.includes(action.view)
          ? p.tabs
          : [...p.tabs, action.view];
        return { ...p, tabs, activeTab: action.view };
      });
      return { ...state, panes };
    }

    case "openInNewPane": {
      if (state.panes.length >= MAX_PANES) {
        // Fall back to opening in the active pane when we're out of room.
        return reducer(state, { type: "open", view: action.view });
      }
      const pane = makePane(action.view);
      const at = indexOfPane(state, state.activePaneId);
      const panes = [...state.panes];
      panes.splice(at + 1, 0, pane);
      return { panes, activePaneId: pane.id };
    }

    case "split": {
      if (state.panes.length >= MAX_PANES) return state;
      const active = state.panes.find((p) => p.id === state.activePaneId);
      if (!active) return state;
      const pane = makePane(active.activeTab);
      const at = indexOfPane(state, state.activePaneId);
      const panes = [...state.panes];
      panes.splice(at + 1, 0, pane);
      return { panes, activePaneId: pane.id };
    }

    case "activate": {
      const panes = state.panes.map((p) =>
        p.id === action.paneId ? { ...p, activeTab: action.view } : p,
      );
      return { panes, activePaneId: action.paneId };
    }

    case "focus":
      return { ...state, activePaneId: action.paneId };

    case "close": {
      const pane = state.panes.find((p) => p.id === action.paneId);
      if (!pane) return state;
      const tabs = pane.tabs.filter((t) => t !== action.view);

      // Last tab in the only pane → keep the pane alive on the default view
      // so the workspace is never empty.
      if (tabs.length === 0 && state.panes.length === 1) {
        const reset = makePane(DEFAULT_VIEW);
        return { panes: [reset], activePaneId: reset.id };
      }

      // Last tab in one of several panes → drop the whole pane.
      if (tabs.length === 0) {
        const remaining = state.panes.filter((p) => p.id !== action.paneId);
        const activePaneId =
          state.activePaneId === action.paneId
            ? (remaining[Math.max(0, indexOfPane(state, action.paneId) - 1)]
                ?.id ?? remaining[0].id)
            : state.activePaneId;
        return { panes: remaining, activePaneId };
      }

      const activeTab =
        pane.activeTab === action.view
          ? neighborTab(pane.tabs, action.view)
          : pane.activeTab;
      const panes = state.panes.map((p) =>
        p.id === action.paneId ? { ...p, tabs, activeTab } : p,
      );
      return { ...state, panes };
    }

    case "closePane": {
      if (state.panes.length === 1) {
        const reset = makePane(DEFAULT_VIEW);
        return { panes: [reset], activePaneId: reset.id };
      }
      const at = indexOfPane(state, action.paneId);
      const remaining = state.panes.filter((p) => p.id !== action.paneId);
      const activePaneId =
        state.activePaneId === action.paneId
          ? (remaining[Math.max(0, at - 1)] ?? remaining[0]).id
          : state.activePaneId;
      return { panes: remaining, activePaneId };
    }

    case "moveTab": {
      if (action.fromPaneId === action.toPaneId) return state;
      const from = state.panes.find((p) => p.id === action.fromPaneId);
      const to = state.panes.find((p) => p.id === action.toPaneId);
      if (!from || !to || !from.tabs.includes(action.view)) return state;

      const fromTabs = from.tabs.filter((t) => t !== action.view);
      const toTabs = to.tabs.includes(action.view)
        ? to.tabs
        : [...to.tabs, action.view];

      // Source pane emptied by the move → remove it.
      if (fromTabs.length === 0) {
        const panes = state.panes
          .filter((p) => p.id !== action.fromPaneId)
          .map((p) =>
            p.id === action.toPaneId
              ? { ...p, tabs: toTabs, activeTab: action.view }
              : p,
          );
        return { panes, activePaneId: action.toPaneId };
      }

      const panes = state.panes.map((p) => {
        if (p.id === action.fromPaneId) {
          const activeTab =
            p.activeTab === action.view
              ? neighborTab(p.tabs, action.view)
              : p.activeTab;
          return { ...p, tabs: fromTabs, activeTab };
        }
        if (p.id === action.toPaneId) {
          return { ...p, tabs: toTabs, activeTab: action.view };
        }
        return p;
      });
      return { panes, activePaneId: action.toPaneId };
    }

    default:
      return state;
  }
}

/** Validate persisted state, dropping unknown views and empty panes. */
function hydrate(raw: unknown): WorkspaceState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<WorkspaceState>;
  if (!Array.isArray(obj.panes)) return null;

  const panes: Pane[] = [];
  for (const p of obj.panes) {
    if (!p || typeof p !== "object") continue;
    const tabs = Array.isArray(p.tabs)
      ? p.tabs.filter((t): t is ViewId => typeof t === "string" && isViewId(t))
      : [];
    if (tabs.length === 0) continue;
    const activeTab =
      typeof p.activeTab === "string" && tabs.includes(p.activeTab as ViewId)
        ? (p.activeTab as ViewId)
        : tabs[0];
    const id = typeof p.id === "string" && p.id ? p.id : newPaneId();
    panes.push({ id, tabs, activeTab });
  }

  if (panes.length === 0) return null;
  const activePaneId =
    typeof obj.activePaneId === "string" &&
    panes.some((p) => p.id === obj.activePaneId)
      ? obj.activePaneId
      : panes[0].id;
  return { panes, activePaneId };
}

function loadInitial(): WorkspaceState {
  if (typeof window === "undefined") return initialState();
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return initialState();
    return hydrate(JSON.parse(stored)) ?? initialState();
  } catch {
    return initialState();
  }
}

export interface WorkspaceApi {
  state: WorkspaceState;
  /** The active tab of the focused pane — what the sidebar highlights. */
  activeView: ViewId;
  open: (view: ViewId) => void;
  openInNewPane: (view: ViewId) => void;
  split: () => void;
  activate: (paneId: string, view: ViewId) => void;
  focus: (paneId: string) => void;
  close: (paneId: string, view: ViewId) => void;
  closePane: (paneId: string) => void;
  moveTab: (fromPaneId: string, toPaneId: string, view: ViewId) => void;
  canSplit: boolean;
}

const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function WorkspaceProvider({
  children,
  initial,
  persist = true,
}: {
  children: ReactNode;
  /** Start from a single pane pinned to this view instead of the persisted
   *  workspace. A viewer window (DCH-64) passes this so it never *reads*
   *  `workspace.v1` — pair it with `persist={false}` so it never writes it
   *  either; localStorage is shared across every webview in the app. */
  initial?: ViewId;
  persist?: boolean;
}) {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    if (initial) {
      const pane = makePane(initial);
      return { panes: [pane], activePaneId: pane.id };
    }
    return loadInitial();
  });

  useEffect(() => {
    if (!persist) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Persistence is best-effort; ignore quota/serialization failures.
    }
  }, [state, persist]);

  const api = useMemo<WorkspaceApi>(() => {
    const active = state.panes.find((p) => p.id === state.activePaneId);
    return {
      state,
      activeView: active?.activeTab ?? DEFAULT_VIEW,
      open: (view) => dispatch({ type: "open", view }),
      openInNewPane: (view) => dispatch({ type: "openInNewPane", view }),
      split: () => dispatch({ type: "split" }),
      activate: (paneId, view) => dispatch({ type: "activate", paneId, view }),
      focus: (paneId) => dispatch({ type: "focus", paneId }),
      close: (paneId, view) => dispatch({ type: "close", paneId, view }),
      closePane: (paneId) => dispatch({ type: "closePane", paneId }),
      moveTab: (fromPaneId, toPaneId, view) =>
        dispatch({ type: "moveTab", fromPaneId, toPaneId, view }),
      canSplit: state.panes.length < MAX_PANES,
    };
  }, [state]);

  return (
    <WorkspaceContext.Provider value={api}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceApi {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return ctx;
}
