import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface ProgressEvent {
  op: string;
  label: string;
  current: number | null;
  total: number | null;
  done: boolean;
  error: boolean;
}

/**
 * Fixed-position strip pinned to the top of the window. Subscribes to the
 * "progress" event the backend emits during long-running ops (sync, enrich,
 * watchlist, refresh-all, prewarm). Hides itself a moment after a `done`
 * event arrives so success/failure is briefly visible.
 */
export function ActivityBar() {
  const [event, setEvent] = useState<ProgressEvent | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    listen<ProgressEvent>("progress", (msg) => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      setEvent(msg.payload);
      if (msg.payload.done) {
        // Show "done" for a beat so the user sees the final summary, then
        // dismiss. Errors stay up longer.
        hideTimer = setTimeout(
          () => setEvent(null),
          msg.payload.error ? 4500 : 1800,
        );
      }
    }).then((u) => {
      unlisten = u;
    });

    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      if (unlisten) unlisten();
    };
  }, []);

  if (!event) return null;

  const pct =
    event.current !== null && event.total !== null && event.total > 0
      ? Math.min(100, (event.current / event.total) * 100)
      : null;

  const tone = event.error
    ? "border-red-500/50 bg-red-500/10"
    : event.done
      ? "border-emerald-500/40 bg-emerald-500/10"
      : "border-accent/40 bg-accent/10";

  return (
    <div
      className={`fixed top-0 inset-x-0 z-50 border-b ${tone} backdrop-blur`}
      role="status"
      aria-live="polite"
    >
      <div className="px-4 py-2 flex items-center gap-3">
        {!event.done && <Spinner />}
        {event.done && !event.error && (
          <span className="text-emerald-400 text-sm">✓</span>
        )}
        {event.error && <span className="text-red-400 text-sm">✗</span>}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-200 truncate">{event.label}</div>
          {pct !== null && (
            <div className="mt-1 h-1 w-full bg-bg-elevated rounded overflow-hidden">
              <div
                className={`h-full ${event.error ? "bg-red-500" : event.done ? "bg-emerald-500" : "bg-accent"}`}
                style={{ width: `${pct}%`, transition: "width 200ms ease" }}
              />
            </div>
          )}
        </div>
        {event.current !== null && event.total !== null && (
          <div className="text-xs text-slate-400 tabular-nums shrink-0">
            {event.current}/{event.total}
          </div>
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
