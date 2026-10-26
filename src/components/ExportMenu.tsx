import { useRef, useState } from "react";
import { AnchoredMenu } from "@/components/AnchoredMenu";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/exportFormat";

/**
 * The Export… button and its format menu (HTML / CSV / JSON), shared by
 * Registry, Wishlist and Collection so the three screens offer the same
 * formats in the same words.
 *
 * Picking a format closes the menu and hands the choice to the caller,
 * which owns the save dialog and the backend call — *what* is exported
 * differs per screen; *how* the format is chosen doesn't. A dropdown rather
 * than three buttons (Collection had two, and a third would crowd its
 * header) and rather than the save dialog's own filter list, which on
 * Windows doesn't reliably report which filter the user picked.
 */
export function ExportMenu({
  onSelect,
  disabled = false,
  busy = false,
  title,
  label = "Export…",
}: {
  onSelect: (format: ExportFormat) => void;
  /** Nothing to export — the trigger is disabled. */
  disabled?: boolean;
  /** An export is in flight — the trigger is disabled and says so. */
  busy?: boolean;
  /** Tooltip on the trigger. */
  title?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn-secondary"
        disabled={disabled || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        // Only ever opens: while the menu is up, the click-catching scrim
        // sits over the trigger and turns the next click into a close.
        onClick={() => setOpen(true)}
        title={title}
      >
        {busy ? "Exporting…" : label}
      </button>
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={300}
        label="Export format"
      >
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f.value}
            type="button"
            className="flex w-full flex-col items-start text-left px-3 py-1.5 hover:bg-bg"
            onClick={() => {
              setOpen(false);
              onSelect(f.value);
            }}
          >
            <span className="text-sm">{f.label}</span>
            <span className="text-xs text-fg-subtle">{f.description}</span>
          </button>
        ))}
      </AnchoredMenu>
    </>
  );
}
