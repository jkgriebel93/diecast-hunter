import { ReactNode } from "react";

/** The filter block every list screen wears (DCH-35).
 *
 *  Seven screens had seven combinations of search box, clear control, result
 *  count and year range. The one that mattered was **Clear filters**: it
 *  existed on Collection, and a differently-labelled always-visible "Reset"
 *  on Seller feed. Everywhere else a user could narrow themselves down to an
 *  empty list with no obvious way back.
 *
 *  `active` is the caller's own "is anything narrowing the list" predicate —
 *  it can't be derived here, because what counts as a set filter differs per
 *  screen (an empty string, an empty array, `EMPTY_YEAR_RANGE`). Passing it
 *  explicitly keeps the decision next to the state it reads.
 */
export function FilterCard({
  children,
  active,
  onClear,
  className = "",
}: {
  children: ReactNode;
  /** True when at least one filter is narrowing the results. */
  active: boolean;
  /** Reset every filter on this screen. On a screen backed by a remote
   *  search this must also re-run the query — stale results under cleared
   *  filters are worse than no results. */
  onClear: () => void;
  className?: string;
}) {
  return (
    <div className={`card space-y-2 ${className}`}>
      {children}
      {/* Hidden rather than disabled when nothing is active: a permanently
          greyed button is noise, and its presence implies filters are set. */}
      {active && (
        <div className="flex justify-end">
          <ClearFiltersButton onClear={onClear} />
        </div>
      )}
    </div>
  );
}

/** Exported separately for screens whose filter row already has somewhere
 *  sensible to put it, so the control doesn't get a row of its own. */
export function ClearFiltersButton({
  onClear,
  className = "",
}: {
  onClear: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`text-xs text-fg-subtle hover:text-fg underline-offset-2 hover:underline ${className}`}
      onClick={onClear}
    >
      Clear filters
    </button>
  );
}

/** The empty state that means "your filters excluded everything", which is a
 *  different message from "you haven't added anything yet" — and the only
 *  one of the two where offering a way out helps. */
export function FilteredEmpty({
  onClear,
  noun = "results",
}: {
  onClear: () => void;
  /** What the screen lists, e.g. "listings", "cars". */
  noun?: string;
}) {
  return (
    <div className="card text-sm text-fg-muted flex items-center justify-between gap-4">
      <span>No {noun} match the current filters.</span>
      <ClearFiltersButton onClear={onClear} className="shrink-0" />
    </div>
  );
}
