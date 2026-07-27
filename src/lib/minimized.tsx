import { useCallback, useSyncExternalStore } from "react";

/**
 * Global, persisted registry of minimized item cards, keyed by
 * `"<kind>:<id>"` (e.g. `listing:123`, `registry:<guid>`). One shared store
 * so the same entity stays minimized everywhere it appears — across pages
 * and across side-by-side panes.
 */
const STORAGE_KEY = "minimized-items.v1";

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((k): k is string => typeof k === "string"));
      }
    }
  } catch {
    // localStorage can throw in private modes; start empty.
  }
  return new Set();
}

let minimized = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(minimized)));
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
  if (minimized.has(key) === value) return;
  const next = new Set(minimized);
  if (value) next.add(key);
  else next.delete(key);
  minimized = next;
  persist();
  emit();
}

/** Bulk form of {@link setMinimized} — used by "Minimize all" buttons. */
export function setManyMinimized(keys: string[], value: boolean) {
  const next = new Set(minimized);
  for (const key of keys) {
    if (value) next.add(key);
    else next.delete(key);
  }
  if (next.size === minimized.size && keys.every((k) => next.has(k) === minimized.has(k))) {
    return;
  }
  minimized = next;
  persist();
  emit();
}

/** Whether one item is minimized, plus a toggle. */
export function useMinimized(key: string): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => minimized.has(key));
  const toggle = useCallback(() => setMinimized(key, !minimized.has(key)), [key]);
  return [value, toggle];
}

/**
 * The full minimized-key set (a fresh immutable Set on every change) — for
 * pages that need aggregate state, e.g. an "all expanded?" toolbar button.
 */
export function useMinimizedSet(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => minimized);
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
  className = "",
}: {
  minimized: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`shrink-0 w-6 h-6 flex items-center justify-center rounded text-xs leading-none text-fg-subtle hover:text-fg hover:bg-bg-elevated ${className}`}
      onClick={onToggle}
      title={minimized ? "Expand" : "Minimize"}
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
