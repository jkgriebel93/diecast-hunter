import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri";

interface ProgressEvent {
  op: string;
  label: string;
  current: number | null;
  total: number | null;
  done: boolean;
  error: boolean;
  cancelled: boolean;
}

/**
 * Fixed-position strip pinned to the top of the window. Subscribes to the
 * "progress" event the backend emits during long-running ops (sync, enrich,
 * watchlist, refresh-all, prewarm). While the op is in flight it shows a
 * spinner, the current label, an optional progress bar, and a Cancel
 * button. After completion it briefly shows the outcome (✓ done / ⏹
 * cancelled / ✗ error) then hides.
 */
export function ActivityBar() {
  const [event, setEvent] = useState<ProgressEvent | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    listen<ProgressEvent>("progress", (msg) => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setEvent(msg.payload);
      if (!msg.payload.done) {
        setCancelling(false);
      }
      if (msg.payload.done) {
        // Show outcome briefly, then dismiss. Errors stay up longer than
        // successes so the user can read them.
        const ms = msg.payload.error
          ? 4500
          : msg.payload.cancelled
            ? 2400
            : 1800;
        hideTimerRef.current = setTimeout(() => setEvent(null), ms);
      }
    }).then((u) => {
      unlisten = u;
    });

    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (unlisten) unlisten();
    };
  }, []);

  async function onCancel() {
    setCancelling(true);
    try {
      await api.cancelActiveOperation();
    } catch {
      // Cancel command failed (no active op?) — fine; user-facing state
      // gets reset by the next progress event.
      setCancelling(false);
    }
  }

  if (!event) return null;

  const pct =
    event.current !== null && event.total !== null && event.total > 0
      ? Math.min(100, (event.current / event.total) * 100)
      : null;

  const tone = event.error
    ? "border-red-500/50 bg-red-500/10"
    : event.cancelled
      ? "border-fg-muted/40 bg-fg-subtle/10"
      : event.done
        ? "border-emerald-500/40 bg-emerald-500/10"
        : "border-accent/40 bg-accent/10";

  return (
    <div
      // z-40, the app-banner layer: this sits above the page and above
      // dropdown scrims, but below a modal (z-50). It was z-50 and therefore
      // tied with dialogs, leaving DOM order to decide whether a sync
      // notification painted over an open dialog's backdrop.
      className={`fixed top-0 inset-x-0 z-40 border-b ${tone} backdrop-blur`}
      role="status"
      aria-live="polite"
    >
      <div className="px-4 py-2 flex items-center gap-3">
        {!event.done && <Spinner />}
        {event.done && !event.error && !event.cancelled && (
          <span className="text-emerald-400 text-sm">✓</span>
        )}
        {event.cancelled && <span className="text-fg-muted text-sm">⏹</span>}
        {event.error && <span className="text-red-400 text-sm">✗</span>}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-fg truncate">{event.label}</div>
          {pct !== null && (
            <div className="mt-1 h-1 w-full bg-bg-elevated rounded overflow-hidden">
              <div
                className={`h-full ${
                  event.error
                    ? "bg-red-500"
                    : event.cancelled
                      ? "bg-fg-subtle"
                      : event.done
                        ? "bg-emerald-500"
                        : "bg-accent"
                }`}
                style={{ width: `${pct}%`, transition: "width 200ms ease" }}
              />
            </div>
          )}
        </div>
        {event.current !== null && event.total !== null && (
          <div className="text-xs text-fg-muted tabular-nums shrink-0">
            {event.current}/{event.total}
          </div>
        )}
        {!event.done && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-fg hover:border-accent disabled:opacity-50 shrink-0"
            title="Stop the current operation. Already-saved progress is kept."
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-4 h-4 rounded-full border-2 border-accent/30 border-t-accent shrink-0 animate-spin" />
  );
}
