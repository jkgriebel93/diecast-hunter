import { useCallback, useSyncExternalStore } from "react";

/**
 * Global, persisted registry of card collapse state, keyed by
 * `"<kind>:<id>"` (e.g. `listing:123`, `registry:<guid>`). One shared store
 * so the same entity stays collapsed everywhere it appears — across pages
 * and across side-by-side panes.
 *
 * Stored as an explicit `key -> boolean` map rather than a set of collapsed
 * keys, because "absent" and "expanded" are not the same thing (DCH-20).
 * Saved Listings wants cards collapsed *by default* so the list is a scan
 * surface, while Collection and Registry want them open; with a bare set,
 * absence had to mean expanded and no page could choose otherwise. Absence
 * now means "no opinion — use the caller's default".
 */
const STORAGE_KEY = "minimized-items.v2";
/** v1 was an array of collapsed keys. Read once and migrate so nobody's
 *  collapsed cards spring open on upgrade. */
const LEGACY_KEY = "minimized-items.v1";

type State = Record<string, boolean>;

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: State = {};
        for (const [k, v] of Object.entries(parsed as object)) {
          if (typeof v === "boolean") out[k] = v;
        }
        return out;
      }
    }
    const legacy: unknown = JSON.parse(
      localStorage.getItem(LEGACY_KEY) ?? "null",
    );
    if (Array.isArray(legacy)) {
      const out: State = {};
      for (const k of legacy) if (typeof k === "string") out[k] = true;
      return out;
    }
  } catch {
    // localStorage can throw in private modes; start empty.
  }
  return {};
}

let state = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMinimized(key: string, value: boolean) {
  if (state[key] === value) return;
  state = { ...state, [key]: value };
  persist();
  emit();
}

/** Bulk form of {@link setMinimized} — used by "Collapse all" buttons. */
export function setManyMinimized(keys: string[], value: boolean) {
  if (keys.every((k) => state[k] === value)) return;
  const next = { ...state };
  for (const key of keys) next[key] = value;
  state = next;
  persist();
  emit();
}

/** Tests only — the store outlives any component. */
export function resetMinimized() {
  state = {};
}

/** Explicit state for a key, or null when the user hasn't expressed one. */
export function minimizedState(key: string): boolean | null {
  return key in state ? state[key] : null;
}

/** Whether one item is minimized, plus a toggle. */
export function useMinimized(
  key: string,
  defaultMinimized = false,
): [boolean, () => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => minimizedState(key) ?? defaultMinimized,
  );
  const toggle = useCallback(
    () => setMinimized(key, !(minimizedState(key) ?? defaultMinimized)),
    [key, defaultMinimized],
  );
  return [value, toggle];
}

/**
 * The full minimized-key set (a fresh immutable Set on every change) — for
 * pages that need aggregate state, e.g. an "all expanded?" toolbar button.
 */
export function useMinimizedSet(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => collapsedKeys());
}

/** Memoized so `useSyncExternalStore` sees a stable reference between
 *  changes — recomputing would loop. */
let cachedKeys: ReadonlySet<string> = new Set();
let cachedFrom: State | null = null;
function collapsedKeys(): ReadonlySet<string> {
  if (cachedFrom !== state) {
    cachedFrom = state;
    cachedKeys = new Set(
      Object.entries(state)
        .filter(([, v]) => v)
        .map(([k]) => k),
    );
  }
  return cachedKeys;
}

/**
 * Rotating-chevron button matching the app's existing collapse idiom.
 * Renders a fixed 24×24 hit target (the glyph alone is ~10px — too easy to
 * miss) with hover feedback, so every card offers the same click area.
 * Callers only add alignment classes (e.g. `self-start -mt-0.5` in
 * top-aligned cards); size stays uniform.
 */
export function MinimizeToggle({
  minimized,
  onToggle,
  label,
  className = "",
}: {
  minimized: boolean;
  onToggle: () => void;
  /** What this toggle opens, e.g. a facet name. On a card the neighbouring
   *  title is the context, but a panel of sibling toggles needs each one to
   *  name itself or they all read as the same control. */
  label?: string;
  className?: string;
}) {
  const action = minimized ? "Expand" : "Minimize";
  const name = label ? `${action} ${label}` : action;
  return (
    <button
      type="button"
      className={`shrink-0 w-6 h-6 flex items-center justify-center rounded text-xs leading-none text-fg-subtle hover:text-fg hover:bg-bg-elevated ${className}`}
      onClick={onToggle}
      title={name}
      aria-label={name}
      aria-expanded={!minimized}
    >
      <span
        className={`inline-block transition-transform ${minimized ? "" : "rotate-90"}`}
      >
        ▶
      </span>
    </button>
  );
}
