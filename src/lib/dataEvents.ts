import { useEffect } from "react";
import { useEvent } from "@/lib/useEvent";

/**
 * Cross-page invalidation bus (DCH-71). The workspace keeps inactive panes
 * mounted (that's what preserves their state), which means a mutation run
 * on one page — a driver pre-warm in Settings, a form-options refresh in
 * the match dialog — leaves every other mounted page's option lists stale
 * until an app restart. This bus is the deliberate version of the ad-hoc
 * "reload after mutate" calls scattered through the pages: the mutating
 * page emits a topic, and every page holding a list fed by that data
 * re-fetches it.
 *
 * Frontend-only on purpose: every mutation in the inventory is initiated
 * by an `invoke()` from this window, so the completion is always observable
 * right where the emit belongs. (The overnight auto-sync mutates without a
 * frontend actor — that cycle is waived on the ticket: the app is idle,
 * and every page re-fetches on mount.)
 *
 * Listeners re-FETCH; they never receive data. That keeps the error
 * contract local to each subscriber: a failed refresh keeps whatever list
 * was already loaded, because the existing load functions only replace
 * state on success.
 */
export type DataTopic =
  /** The local `drivers` table gained or changed rows — pre-warm, a
   *  pre-search refresh, or a driver assignment that upserted a new name. */
  | "drivers"
  /** The registry form-options cache was re-fetched from DCR — every
   *  criteria dropdown built from `list_registry_form_options`. */
  | "registry-options";

const listeners = new Map<DataTopic, Set<() => void>>();

/** Subscribe; returns the unsubscribe. Prefer {@link useDataChanged} in
 *  components. */
export function onDataChanged(topic: DataTopic, listener: () => void) {
  let set = listeners.get(topic);
  if (!set) {
    set = new Set();
    listeners.set(topic, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Announce that data behind `topic` changed. Fire after the mutation
 *  succeeds, not before — subscribers re-fetch immediately. */
export function emitDataChanged(topic: DataTopic) {
  // Copied so a listener that unsubscribes (or subscribes) mid-emit can't
  // skip or double-deliver to its neighbours.
  for (const listener of [...(listeners.get(topic) ?? [])]) {
    try {
      listener();
    } catch {
      // One broken subscriber must not stop the rest from refreshing.
    }
  }
}

/** Tests only. */
export function resetDataListeners() {
  listeners.clear();
}

/** Run `handler` whenever `topic` is emitted, for as long as the component
 *  is mounted. The handler is wrapped in {@link useEvent}, so it may close
 *  over state without a dependency list. */
export function useDataChanged(topic: DataTopic, handler: () => void) {
  const stable = useEvent(handler);
  useEffect(() => onDataChanged(topic, stable), [topic, stable]);
}
