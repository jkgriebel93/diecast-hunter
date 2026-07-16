import { useEffect, useMemo, useRef, useState } from "react";
import type { FormOptionRow } from "@/lib/tauri";

/**
 * Chip-style multi-select combobox over registry form options. Type to
 * filter, click or Enter to toggle; selected values render as removable
 * chips inside the control. The dropdown stays open across picks so
 * several values can be selected in one pass.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Any",
  shortlist,
}: {
  options: FormOptionRow[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** When set and the search box is empty, only options passing this
   * predicate are listed until the user expands with "Show all". */
  shortlist?: (opt: FormOptionRow) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const byValue = useMemo(
    () => new Map(options.map((o) => [o.value, o])),
    [options],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q !== "") {
      return options.filter((o) => o.display.toLowerCase().includes(q));
    }
    if (shortlist && !showAll) {
      return options.filter(shortlist);
    }
    return options;
  }, [options, query, shortlist, showAll]);

  const shortlisted =
    shortlist !== undefined && !showAll && query.trim() === "";

  useEffect(() => {
    setHighlight(0);
  }, [query, showAll]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function toggle(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && filtered[highlight]) toggle(filtered[highlight].value);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    } else if (e.key === "Backspace" && query === "" && selected.length > 0) {
      onChange(selected.slice(0, -1));
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div
        className="input flex flex-wrap items-center gap-1 py-1 min-h-[2.4rem] cursor-text"
        onClick={() => {
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {selected.map((v) => {
          const display = byValue.get(v)?.display ?? v;
          return (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded bg-accent/15 text-accent px-1.5 py-0.5 text-xs max-w-full"
            >
              <span className="truncate">{display}</span>
              <button
                type="button"
                className="hover:text-accent-hover shrink-0"
                aria-label={`Remove ${display}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(v);
                }}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          className="flex-1 min-w-16 bg-transparent border-none p-0 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-0"
          value={query}
          placeholder={selected.length === 0 ? placeholder : ""}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && (
        <div className="absolute z-30 mt-1 w-full max-h-60 overflow-auto rounded-md border border-border bg-bg-panel shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-subtle">No matches.</div>
          ) : (
            filtered.map((o, i) => {
              const isSelected = selected.includes(o.value);
              return (
                <button
                  type="button"
                  key={o.value}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-2 ${
                    i === highlight ? "bg-bg-elevated" : ""
                  } ${isSelected ? "text-accent" : "text-fg"}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => toggle(o.value)}
                >
                  <span className="truncate">{o.display}</span>
                  {isSelected && <span className="shrink-0">✓</span>}
                </button>
              );
            })
          )}
          {shortlisted && (
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 text-xs text-fg-subtle hover:text-fg-muted border-t border-border"
              onClick={() => setShowAll(true)}
            >
              Show all {options.length}…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
