import {
  EMPTY_YEAR_RANGE,
  describeRange,
  isEmptyRange,
  parseYear,
  type YearRange,
} from "@/lib/yearRange";

/** From/To year pair, used by every surface that filters on year (DCH-15).
 *
 *  Two dropdowns rather than free-text inputs: the set of years is known and
 *  bounded, so a picker can't produce a typo'd or out-of-range bound. Either
 *  side may be left as "Any", which is what makes "1998 or later" and "up to
 *  2003" expressible without a third control.
 *
 *  The two selects are deliberately independent — picking To before From, or
 *  inverting them, is allowed and normalized downstream rather than blocked
 *  here. Preventing it would mean disabling options mid-interaction, which is
 *  a worse experience than quietly reading 2003–1998 as 1998–2003. */
export function YearRangeFilter({
  years,
  value,
  onChange,
  id,
  compact = false,
  selectClassName,
}: {
  /** Selectable years, newest-first (as `prepareYearOptions` returns them). */
  years: string[];
  value: YearRange;
  onChange: (next: YearRange) => void;
  /** Prefix for the two selects' ids, so labels can point at them. */
  id: string;
  /** Denser styling for sidebar facets vs. a search form. */
  compact?: boolean;
  /** Overrides the select styling entirely, for hosts whose filter rows
   *  don't use the shared `input` class (e.g. Collection's inline row). */
  selectClassName?: string;
}) {
  const active = !isEmptyRange(value);
  const cls =
    selectClassName ?? (compact ? "input !py-1 text-xs w-full" : "input");
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <select
          id={`${id}-from`}
          className={cls}
          value={value.from ?? ""}
          onChange={(e) =>
            onChange({ ...value, from: parseYear(e.target.value) })
          }
          aria-label="Earliest year"
        >
          <option value="">Any</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span className="text-fg-subtle text-xs shrink-0">to</span>
        <select
          id={`${id}-to`}
          className={cls}
          value={value.to ?? ""}
          onChange={(e) =>
            onChange({ ...value, to: parseYear(e.target.value) })
          }
          aria-label="Latest year"
        >
          <option value="">Any</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      {active && (
        <div className="flex items-center justify-between gap-2">
          {/* Echoes how the bounds will actually be read — the one place an
              inverted pair becomes visible to the user. */}
          <span className="text-[11px] text-fg-subtle">
            {describeRange(value)}
          </span>
          <button
            type="button"
            className="text-[11px] text-fg-subtle hover:text-fg"
            onClick={() => onChange(EMPTY_YEAR_RANGE)}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
