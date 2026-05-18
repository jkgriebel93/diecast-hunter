import type { ImageSize } from "@/lib/imageSize";

const LABELS: Record<ImageSize, string> = { sm: "S", md: "M", lg: "L" };
const SIZES: ImageSize[] = ["sm", "md", "lg"];

export function ImageSizeToggle({
  size,
  onChange,
  label = "Image size",
  showLabel = true,
}: {
  size: ImageSize;
  onChange: (s: ImageSize) => void;
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
        {SIZES.map((s) => {
          const active = s === size;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onChange(s)}
              className={
                "px-2 py-1 leading-none border-l border-border first:border-l-0 " +
                (active
                  ? "text-accent bg-accent/10"
                  : "bg-bg-elevated hover:bg-bg")
              }
              aria-pressed={active}
            >
              {LABELS[s]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
