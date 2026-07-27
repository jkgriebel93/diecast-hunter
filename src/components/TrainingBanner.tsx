import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface TrainingEvent {
  phase: "started" | "finished" | "failed";
  message: string;
  activated: boolean | null;
}

/**
 * Dismissible strip shown when the auto-match model is trained
 * automatically (startup retrain). Manual retrains from the Settings page
 * report their outcome inline there and don't emit this event. Unlike the
 * ActivityBar this is in normal flow and stays up until dismissed, so a
 * training run that finishes while the user is away is still visible.
 */
export function TrainingBanner() {
  const [event, setEvent] = useState<TrainingEvent | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<TrainingEvent>("matcher-training", (msg) => {
      setEvent(msg.payload);
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!event) return null;

  const running = event.phase === "started";
  const tone =
    event.phase === "failed"
      ? "border-red-500/40 bg-red-500/10"
      : event.activated
        ? "border-emerald-500/40 bg-emerald-500/10"
        : "border-accent/40 bg-accent/10";

  return (
    <div className={`border-b ${tone}`} role="status" aria-live="polite">
      <div className="px-4 py-2 flex items-center gap-3">
        {running ? (
          <div className="w-4 h-4 rounded-full border-2 border-accent/30 border-t-accent shrink-0 animate-spin" />
        ) : event.phase === "failed" ? (
          <span className="text-red-400 text-sm shrink-0">✗</span>
        ) : (
          <span className="text-emerald-400 text-sm shrink-0">✓</span>
        )}
        <div className="flex-1 min-w-0 text-xs text-fg">
          Auto-match learning: {event.message}
        </div>
        <button
          type="button"
          onClick={() => setEvent(null)}
          className="text-xs px-2 py-0.5 rounded border border-border text-fg-muted hover:text-fg shrink-0"
          title="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
