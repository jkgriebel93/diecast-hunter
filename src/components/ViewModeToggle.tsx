import type { ViewMode } from "@/lib/viewMode";

const LABELS: Record<ViewMode, string> = { cards: "Cards", list: "List" };
const MODES: ViewMode[] = ["cards", "list"];

/** Segmented cards/list switch (DCH-50), styled to sit beside
 *  `ImageSizeToggle` in a results toolbar. */
export function ViewModeToggle({
  mode,
  onChange,
  label = "View",
  showLabel = true,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
  label?: string;
  showLabel?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-2 text-xs">
      {showLabel && <span className="text-fg-subtle">{label}</span>}
      <div
        className="inline-flex rounded-md border border-border overflow-hidden"
        role="group"
        aria-label={label}
      >
        {MODES.map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              type="button"
              onClick={() => onChange(m)}
              className={
                "px-2 py-1 leading-none border-l border-border first:border-l-0 " +
                (active
                  ? "text-accent bg-accent/10"
                  : "bg-bg-elevated hover:bg-bg")
              }
              aria-pressed={active}
            >
              {LABELS[m]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
