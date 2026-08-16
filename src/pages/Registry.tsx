import { useEffect, useMemo, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { describeError } from "@/lib/errors";
import { Modal } from "@/components/Modal";
import { ClearFiltersButton, FilteredEmpty } from "@/components/FilterCard";
import {
  api,
  formatAgo,
  formatCents,
  formatCount,
  isPreferredOem,
  prepareBrandOptions,
  prepareMakeOptions,
  prepareScaleOptions,
  prepareYearOptions,
  driverListingCounts,
  sortDriverOptions,
  type Condition,
  type FormOptionRow,
  type Presearch,
  type ProductionSearchFilter,
  type ProductionSearchResult,
  type WishlistInfo,
} from "@/lib/tauri";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";
import { MultiSelect } from "@/components/MultiSelect";
import { YearRangeFilter } from "@/components/YearRangeFilter";
import {
  EMPTY_YEAR_RANGE,
  yearsInRange,
  type YearRange,
} from "@/lib/yearRange";
import { ViewLink } from "@/components/ViewLink";
import { useMinimized, MinimizeToggle } from "@/lib/minimized";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Thumbnail } from "@/components/Thumbnail";
import { DCR_BASE } from "@/lib/dcr";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

type SortMode =
  | "registry"
  | "driver-asc"
  | "year-desc"
  | "year-asc"
  | "retail-value-desc"
  | "retail-value-asc"
  | "production-qty-asc"
  | "production-qty-desc";

/** Parse a user-typed dollar amount ("25", "$12.50") into cents; null when
 *  blank or unparseable, which means "no bound". */
function parseDollars(s: string): number | null {
  const t = s.trim().replace(/^\$/, "");
  if (t === "") return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

/** True when the value satisfies the bounds. With no bounds set, a null
 *  value passes; once either bound is set, unvalued items are excluded. */
function inRange(
  cents: number | null,
  min: number | null,
  max: number | null,
): boolean {
  if (min === null && max === null) return true;
  if (cents === null) return false;
  if (min !== null && cents < min) return false;
  if (max !== null && cents > max) return false;
  return true;
}

const CONDITION_OPTIONS: { value: Condition; label: string }[] = [
  { value: "mint", label: "Mint" },
  { value: "excellent", label: "Excellent" },
  { value: "very_good", label: "Very Good" },
  { value: "good", label: "Good" },
  { value: "average", label: "Average" },
  { value: "below_average", label: "Below Average" },
  { value: "new", label: "New" },
];

/**
 * Standalone search against diecastregistry.com's /Production listing.
 * Same backend as the per-listing "Search registry…" dialog, but without
 * the listing-link action — results are read-only with a deep link out to
 * diecastregistry.com.
 */
export function Registry() {
  const [drivers, setDrivers] = useState<FormOptionRow[]>([]);
  const [oems, setOems] = useState<FormOptionRow[]>([]);
  const [scales, setScales] = useState<FormOptionRow[]>([]);
  const [years, setYears] = useState<FormOptionRow[]>([]);
  const [brands, setBrands] = useState<FormOptionRow[]>([]);
  const [makes, setMakes] = useState<FormOptionRow[]>([]);
  const [finishes, setFinishes] = useState<FormOptionRow[]>([]);
  const [optionsLoaded, setOptionsLoaded] = useState(false);

  const [selectedDriverGuids, setSelectedDriverGuids] = useState<string[]>([]);
  const [selectedYears, setSelectedYears] = useState<string[]>([]);
  const [yearRange, setYearRange] = useState<YearRange>(EMPTY_YEAR_RANGE);
  const [selectedOemGuids, setSelectedOemGuids] = useState<string[]>([]);
  const [selectedScaleGuids, setSelectedScaleGuids] = useState<string[]>([]);
  const [selectedBrandGuids, setSelectedBrandGuids] = useState<string[]>([]);
  const [selectedMakeGuids, setSelectedMakeGuids] = useState<string[]>([]);
  const [selectedFinishGuids, setSelectedFinishGuids] = useState<string[]>([]);

  /** The years actually sent to the search: the individually-picked ones plus
   *  everything the range covers, de-duplicated. The two controls are additive
   *  rather than exclusive, so "1998–2003 and also 2010" is expressible. The
   *  backend takes a plain list, so a range needs no API of its own. */
  const searchYears = useMemo(() => {
    const fromRange = yearsInRange(
      years.map((y) => y.value),
      yearRange,
    );
    return [...new Set([...selectedYears, ...fromRange])];
  }, [selectedYears, yearRange, years]);
  const [autographed, setAutographed] = useState(false);
  const [raced, setRaced] = useState(false);

  const [results, setResults] = useState<ProductionSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [addTarget, setAddTarget] = useState<ProductionSearchResult | null>(
    null,
  );
  const [wishlistGuids, setWishlistGuids] = useState<Set<string>>(
    () => new Set(),
  );
  const [wishing, setWishing] = useState<string | null>(null);
  /** Set when the user must pick which wishlist to add the result to. */
  const [wishPicker, setWishPicker] = useState<{
    result: ProductionSearchResult;
    lists: WishlistInfo[];
  } | null>(null);
  const [imgSize, setImgSize] = useImageSize("registry");
  const [sortMode, setSortMode] = useState<SortMode>("registry");
  const [presearches, setPresearches] = useState<Presearch[]>([]);
  /** Which pre-search action is in flight ("save", "refresh-3", "delete-3"),
   *  so only the affected row shows a spinner. */
  const [presearchBusy, setPresearchBusy] = useState<string | null>(null);
  const [retailMin, setRetailMin] = useState("");
  const [retailMax, setRetailMax] = useState("");
  const [wholesaleMin, setWholesaleMin] = useState("");
  const [wholesaleMax, setWholesaleMax] = useState("");
  /** Free-text narrowing of what the remote search returned. DCH-35: the
   *  search screen had no way to search its own results, which is the
   *  oddest gap the audit found. This filters locally — the structured
   *  criteria above are what go to diecastregistry.com. */
  const [resultSearch, setResultSearch] = useState("");

  /** True when anything is narrowing the returned results — not the search
   *  criteria themselves, which are a separate concern with their own
   *  Search button. */
  const resultFiltersActive =
    resultSearch.trim() !== "" ||
    retailMin !== "" ||
    retailMax !== "" ||
    wholesaleMin !== "" ||
    wholesaleMax !== "";

  function clearResultFilters() {
    setResultSearch("");
    setRetailMin("");
    setRetailMax("");
    setWholesaleMin("");
    setWholesaleMax("");
  }

  const filteredResults = useMemo(() => {
    if (!results) return null;
    const rMin = parseDollars(retailMin);
    const rMax = parseDollars(retailMax);
    const wMin = parseDollars(wholesaleMin);
    const wMax = parseDollars(wholesaleMax);
    const q = resultSearch.trim().toLowerCase();
    if (
      rMin === null &&
      rMax === null &&
      wMin === null &&
      wMax === null &&
      !q
    ) {
      return results;
    }
    const matchesText = (r: ProductionSearchResult) =>
      !q ||
      [
        r.driver_name,
        r.scheme_text,
        r.oem,
        r.brand,
        r.scale,
        r.make,
        r.year === null ? null : String(r.year),
      ]
        .filter(Boolean)
        .some((f) => (f as string).toLowerCase().includes(q));
    return results.filter(
      (r) =>
        matchesText(r) &&
        inRange(r.retail_value_cents, rMin, rMax) &&
        inRange(r.wholesale_value_cents, wMin, wMax),
    );
  }, [results, retailMin, retailMax, wholesaleMin, wholesaleMax, resultSearch]);

  const sortedResults = useMemo(() => {
    if (!filteredResults || sortMode === "registry") return filteredResults;
    const nullsLast = (av: number | null, bv: number | null) => {
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    };
    const list = [...filteredResults];
    list.sort((a, b) => {
      switch (sortMode) {
        case "driver-asc":
          return (
            a.driver_name.localeCompare(b.driver_name) ||
            (b.year ?? 0) - (a.year ?? 0)
          );
        case "year-desc":
          return nullsLast(b.year, a.year);
        case "year-asc":
          return nullsLast(a.year, b.year);
        case "retail-value-desc":
          return nullsLast(b.retail_value_cents, a.retail_value_cents);
        case "retail-value-asc":
          return nullsLast(a.retail_value_cents, b.retail_value_cents);
        case "production-qty-asc":
          return nullsLast(a.seq_produced_total, b.seq_produced_total);
        case "production-qty-desc":
          return nullsLast(b.seq_produced_total, a.seq_produced_total);
      }
    });
    return list;
  }, [filteredResults, sortMode]);

  useEffect(() => {
    void loadOptions();
    void loadPresearches();
    // Best-effort: mark results that are already wished for (on any list).
    // A failure here only loses the "In wishlist" indicators, so it stays
    // silent.
    api
      .listWishlistedGuids()
      .then((guids) => setWishlistGuids(new Set(guids)))
      .catch(() => {});
  }, []);

  /** One list → add straight to it; several → open the picker. Lists are
   *  fetched fresh on each click so a list created in another pane shows
   *  up without a page reload. */
  async function onAddToWishlist(r: ProductionSearchResult) {
    setWishing(r.registry_guid);
    setError(null);
    try {
      const lists = await api.listWishlists();
      if (lists.length === 0) {
        setError("No wishlist exists yet — create one on the Wishlist page.");
      } else if (lists.length === 1) {
        await api.addWishlistEntry(lists[0].wishlist_id, r);
        setWishlistGuids((prev) => new Set(prev).add(r.registry_guid));
      } else {
        setWishPicker({ result: r, lists });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setWishing(null);
    }
  }

  async function onPickWishlist(wishlistId: number) {
    if (!wishPicker) return;
    const r = wishPicker.result;
    setError(null);
    try {
      await api.addWishlistEntry(wishlistId, r);
      setWishlistGuids((prev) => new Set(prev).add(r.registry_guid));
      setWishPicker(null);
    } catch (e) {
      setError(String(e));
      setWishPicker(null);
    }
  }

  async function loadOptions() {
    setError(null);
    try {
      const [d, o, s, y, b, m, f, listingCounts] = await Promise.all([
        api.listRegistryFormOptions("driver"),
        api.listRegistryFormOptions("oem"),
        api.listRegistryFormOptions("scale"),
        api.listRegistryFormOptions("year"),
        api.listRegistryFormOptions("brand"),
        api.listRegistryFormOptions("make"),
        api.listRegistryFormOptions("finish"),
        driverListingCounts(),
      ]);
      setDrivers(
        sortDriverOptions(
          d,
          (x) => x.display,
          (x) => listingCounts.get(x.normalized) ?? 0,
        ),
      );
      setOems(o);
      setScales(prepareScaleOptions(s));
      setYears(prepareYearOptions(y));
      setBrands(prepareBrandOptions(b));
      setMakes(prepareMakeOptions(m));
      setFinishes(f);
      setOptionsLoaded(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRefreshOptions() {
    setRefreshing(true);
    setError(null);
    setInfo(null);
    try {
      const summary = await api.refreshRegistryFormOptions();
      setInfo(
        `Cached ${summary.options_upserted} options across ${summary.fields_seen} fields.`,
      );
      await loadOptions();
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  /** Current form state as the filter shape the backend and pre-searches
   *  both take. One place to build it, so "search" and "save as pre-search"
   *  can never drift apart. */
  function currentFilter(): ProductionSearchFilter {
    return {
      driver_guids: selectedDriverGuids,
      years: searchYears,
      oem_guids: selectedOemGuids,
      scale_guids: selectedScaleGuids,
      brand_guids: selectedBrandGuids,
      make_guids: selectedMakeGuids,
      finish_guids: selectedFinishGuids,
      autographed,
      raced,
    };
  }

  async function loadPresearches() {
    try {
      setPresearches(await api.listRegistryPresearches());
    } catch (e) {
      setError(String(e));
    }
  }

  async function onSavePresearch() {
    const name = window.prompt(
      'Name this pre-search (e.g. "Action 1:24 Elite"):',
    );
    if (name === null) return;
    setPresearchBusy("save");
    setError(null);
    setInfo(null);
    try {
      await api.createRegistryPresearch({ name, filter: currentFilter() });
      await loadPresearches();
      setInfo(
        `Saved "${name.trim()}". Refresh it to cache its entries for instant local filtering.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setPresearchBusy(null);
    }
  }

  /** Load a pre-search's filters into the form and run it. With the cache
   *  warm and the search mode on local/hybrid this answers from local rows —
   *  which is the whole point of having saved it. */
  async function onApplyPresearch(ps: Presearch) {
    const f = ps.filter;
    setSelectedDriverGuids(f.driver_guids ?? []);
    setSelectedYears(f.years ?? []);
    setYearRange(EMPTY_YEAR_RANGE);
    setSelectedOemGuids(f.oem_guids ?? []);
    setSelectedScaleGuids(f.scale_guids ?? []);
    setSelectedBrandGuids(f.brand_guids ?? []);
    setSelectedMakeGuids(f.make_guids ?? []);
    setSelectedFinishGuids(f.finish_guids ?? []);
    setAutographed(f.autographed ?? false);
    setRaced(f.raced ?? false);
    setInfo(null);
    setError(null);
    // Search off the stored filter rather than the state we just set —
    // setState is async, so reading it back here would run the *previous*
    // filter.
    await runSearch(f);
  }

  async function onRefreshPresearch(ps: Presearch) {
    setPresearchBusy(`refresh-${ps.id}`);
    setError(null);
    setInfo(null);
    try {
      const n = await api.refreshRegistryPresearch(ps.id);
      setInfo(`Cached ${n} entries for "${ps.name}".`);
      await loadPresearches();
    } catch (e) {
      setError(String(e));
      await loadPresearches();
    } finally {
      setPresearchBusy(null);
    }
  }

  async function onDeletePresearch(ps: Presearch) {
    if (!window.confirm(`Delete the pre-search "${ps.name}"?`)) return;
    setPresearchBusy(`delete-${ps.id}`);
    try {
      await api.deleteRegistryPresearch(ps.id);
      await loadPresearches();
    } catch (e) {
      setError(String(e));
    } finally {
      setPresearchBusy(null);
    }
  }

  async function onSearch() {
    setSearching(true);
    await runSearch(currentFilter());
  }

  /** The one place a search is actually issued. Takes an explicit filter so
   *  callers that just set form state (loading a pre-search) don't race
   *  React's async setState by reading it back. */
  async function runSearch(filter: ProductionSearchFilter) {
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      setResults(await api.searchDcrProduction(filter));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  /** Export whatever is currently displayed (post value-filter, post-sort)
   *  to a self-contained HTML file. Finish isn't part of search results, so
   *  we can only label it when the search was pinned to a single finish. */
  async function onExport() {
    if (!sortedResults || sortedResults.length === 0) return;
    const path = await saveDialog({
      title: "Export registry search results",
      defaultPath: "registry-export.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!path) return;
    setExporting(true);
    setError(null);
    setInfo(null);
    try {
      const finishLabel =
        selectedFinishGuids.length === 1
          ? (finishes.find((f) => f.value === selectedFinishGuids[0])
              ?.display ?? null)
          : null;
      const summary = await api.exportRegistrySearchHtml(
        sortedResults,
        finishLabel,
        path,
      );
      setInfo(
        `Exported ${summary.entries} result${summary.entries === 1 ? "" : "s"} to ${summary.path}` +
          (summary.images_failed > 0
            ? ` (${summary.images_failed} image${summary.images_failed === 1 ? "" : "s"} could not be downloaded).`
            : "."),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  function onReset() {
    setSelectedDriverGuids([]);
    setSelectedYears([]);
    setYearRange(EMPTY_YEAR_RANGE);
    setSelectedOemGuids([]);
    setSelectedScaleGuids([]);
    setSelectedBrandGuids([]);
    setSelectedMakeGuids([]);
    setSelectedFinishGuids([]);
    setAutographed(false);
    setRaced(false);
    setRetailMin("");
    setRetailMax("");
    setWholesaleMin("");
    setWholesaleMax("");
    setResults(null);
    setInfo(null);
    setError(null);
  }

  const optionsEmpty =
    optionsLoaded && drivers.length === 0 && oems.length === 0;

  const canSearch =
    selectedDriverGuids.length > 0 ||
    searchYears.length > 0 ||
    selectedOemGuids.length > 0 ||
    selectedScaleGuids.length > 0 ||
    selectedBrandGuids.length > 0 ||
    selectedMakeGuids.length > 0 ||
    selectedFinishGuids.length > 0 ||
    autographed ||
    raced;

  return (
    <div className="p-6 space-y-4">
      <header>
        <h2 className="text-2xl font-semibold">Registry search</h2>
        <p className="text-sm text-fg-subtle">
          Search diecastregistry.com's production catalog. Results link out to
          the registry's detail pages.
        </p>
      </header>

      {!optionsLoaded ? (
        <div className="card text-sm text-fg-muted">
          Loading filter options…
        </div>
      ) : optionsEmpty ? (
        <div className="card text-sm text-amber-400/90 space-y-2">
          <div>
            The registry option cache is empty. Fetch it once (a few seconds) so
            the filter dropdowns can populate.
          </div>
          <button
            className="btn-primary"
            type="button"
            onClick={onRefreshOptions}
            disabled={refreshing}
          >
            {refreshing ? "Fetching…" : "Fetch registry options"}
          </button>
        </div>
      ) : (
        <section className="card space-y-4">
          <div className="grid gap-x-4 gap-y-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className="label">Driver</label>
              <MultiSelect
                options={drivers}
                selected={selectedDriverGuids}
                onChange={setSelectedDriverGuids}
                placeholder="Any (type to search…)"
              />
            </div>
            <div>
              <label className="label">Year</label>
              <MultiSelect
                options={years}
                selected={selectedYears}
                onChange={setSelectedYears}
              />
              {/* A range is additive to the picks above rather than a
                  replacement — discrete years and spans answer different
                  questions ("the 2001 car" vs "his Roush era"). */}
              <div className="mt-1.5">
                <div className="text-[11px] text-fg-subtle mb-1">
                  …or a range
                </div>
                <YearRangeFilter
                  id="registry-year"
                  years={years.map((y) => y.value)}
                  value={yearRange}
                  onChange={setYearRange}
                  compact
                />
              </div>
            </div>
            <div>
              <label className="label">OEM</label>
              <MultiSelect
                options={oems}
                selected={selectedOemGuids}
                onChange={setSelectedOemGuids}
                placeholder="Any (type to search…)"
                shortlist={(o) => isPreferredOem(o.display)}
              />
            </div>
            <div>
              <label className="label">Scale</label>
              <MultiSelect
                options={scales}
                selected={selectedScaleGuids}
                onChange={setSelectedScaleGuids}
              />
            </div>
            <div>
              <label className="label">Brand</label>
              <MultiSelect
                options={brands}
                selected={selectedBrandGuids}
                onChange={setSelectedBrandGuids}
                placeholder="Any (type to search…)"
              />
            </div>
            <div>
              <label className="label">Make</label>
              <MultiSelect
                options={makes}
                selected={selectedMakeGuids}
                onChange={setSelectedMakeGuids}
                placeholder="Any (type to search…)"
              />
            </div>
            <div>
              <label className="label">Finish</label>
              <MultiSelect
                options={finishes}
                selected={selectedFinishGuids}
                onChange={setSelectedFinishGuids}
                placeholder="Any (type to search…)"
              />
            </div>
            <div>
              <label className="label">Options</label>
              <div className="flex flex-col justify-center gap-1.5 min-h-[2.4rem] text-xs">
                <label className="inline-flex items-center gap-2 text-fg-muted">
                  <input
                    type="checkbox"
                    checked={autographed}
                    onChange={(e) => setAutographed(e.target.checked)}
                  />
                  Autographed only
                </label>
                <label className="inline-flex items-center gap-2 text-fg-muted">
                  <input
                    type="checkbox"
                    checked={raced}
                    onChange={(e) => setRaced(e.target.checked)}
                  />
                  Raced version only
                </label>
              </div>
            </div>
          </div>

          {/* Saved filter combinations. Clicking one loads its filters and
              searches; with its cache warm and the search mode on
              local/hybrid, that resolves from local rows instead of a
              multi-page DCR walk. */}
          <div className="border-t border-border pt-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
                Pre-searches
              </span>
              <button
                type="button"
                className="text-xs text-fg-subtle hover:text-fg-muted"
                onClick={onSavePresearch}
                disabled={!canSearch || presearchBusy !== null}
                title={
                  canSearch
                    ? "Save the current filters as a named pre-search"
                    : "Pick at least one filter first"
                }
              >
                {presearchBusy === "save"
                  ? "Saving…"
                  : "+ Save current filters"}
              </button>
            </div>
            {presearches.length === 0 ? (
              <p className="text-xs text-fg-subtle">
                None yet. Save a filter combination you use often, refresh it
                once, and it will answer from local data from then on.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {presearches.map((ps) => (
                  <li
                    key={ps.id}
                    className="flex items-center gap-1.5 rounded border border-border bg-bg-elevated px-2 py-1 text-xs"
                  >
                    <button
                      type="button"
                      className="text-fg hover:text-blue-400"
                      onClick={() => void onApplyPresearch(ps)}
                      disabled={searching || presearchBusy !== null}
                      title="Load these filters and search"
                    >
                      {ps.name}
                    </button>
                    <span
                      className="text-fg-subtle tabular-nums"
                      title={
                        ps.last_refreshed_at === null
                          ? "Never cached — refresh to pull its entries down"
                          : `Cached ${formatAgo(ps.last_refreshed_at)}`
                      }
                    >
                      {ps.last_refreshed_at === null
                        ? "not cached"
                        : `${formatCount(ps.last_result_count)} · ${formatAgo(ps.last_refreshed_at)}`}
                    </span>
                    {ps.last_error !== null && (
                      <span
                        className="text-red-400"
                        title={`Last refresh failed: ${describeError(ps.last_error).title}`}
                      >
                        !
                      </span>
                    )}
                    <button
                      type="button"
                      className="text-fg-subtle hover:text-fg"
                      onClick={() => void onRefreshPresearch(ps)}
                      disabled={presearchBusy !== null}
                      title="Re-walk diecastregistry.com and cache the results"
                    >
                      {presearchBusy === `refresh-${ps.id}` ? "…" : "↻"}
                    </button>
                    <button
                      type="button"
                      className="link-danger"
                      onClick={() => void onDeletePresearch(ps)}
                      disabled={presearchBusy !== null}
                      title="Delete this pre-search"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <button
              type="button"
              className="text-xs text-fg-subtle hover:text-fg-muted"
              onClick={onRefreshOptions}
              disabled={refreshing}
              title="Re-fetch the filter choices from diecastregistry.com"
            >
              {refreshing ? "Refreshing options…" : "Refresh options"}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={onExport}
                disabled={
                  searching ||
                  exporting ||
                  !sortedResults ||
                  sortedResults.length === 0
                }
                title={
                  sortedResults && sortedResults.length > 0
                    ? "Save the displayed results as an HTML file"
                    : "Run a search first — exports the displayed results"
                }
              >
                {exporting ? "Exporting…" : "Export"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={onReset}
                disabled={searching}
              >
                Reset
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={onSearch}
                disabled={searching || !canSearch}
                title={
                  canSearch ? "Search the registry" : "Pick at least one filter"
                }
              >
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
          </div>
        </section>
      )}

      {info && <div className="text-xs text-emerald-400">{info}</div>}
      {error && <ErrorBanner error={error} />}

      {searching ? (
        <div className="card text-sm text-fg-muted">Searching…</div>
      ) : results === null ? null : results.length === 0 ? (
        <div className="card text-sm text-fg-muted">No results.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-fg-subtle">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div>
                {sortedResults!.length === results.length
                  ? `${formatCount(results.length)} result${results.length === 1 ? "" : "s"}.`
                  : `${formatCount(sortedResults!.length)} of ${formatCount(results.length)} results.`}
              </div>
              <input
                type="text"
                className="input !w-56 !py-0.5 !text-[11px]"
                value={resultSearch}
                onChange={(e) => setResultSearch(e.target.value)}
                placeholder="Search these results…"
                aria-label="Search results"
              />
              <ValueRangeFilter
                label="Retail"
                min={retailMin}
                max={retailMax}
                onMin={setRetailMin}
                onMax={setRetailMax}
              />
              <ValueRangeFilter
                label="Wholesale"
                min={wholesaleMin}
                max={wholesaleMax}
                onMin={setWholesaleMin}
                onMax={setWholesaleMax}
              />
              {resultFiltersActive && (
                <ClearFiltersButton onClear={clearResultFilters} />
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span>Sort:</span>
                <select
                  className="input !w-auto !py-0.5 !text-[11px]"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  title="Sort results"
                >
                  <option value="registry">Registry order</option>
                  <option value="driver-asc">Driver A → Z</option>
                  <option value="year-desc">Year newest → oldest</option>
                  <option value="year-asc">Year oldest → newest</option>
                  <option value="retail-value-desc">
                    Retail value high → low
                  </option>
                  <option value="retail-value-asc">
                    Retail value low → high
                  </option>
                  <option value="production-qty-asc">
                    Production qty low → high
                  </option>
                  <option value="production-qty-desc">
                    Production qty high → low
                  </option>
                </select>
              </div>
              <ImageSizeToggle size={imgSize} onChange={setImgSize} />
            </div>
          </div>
          {sortedResults!.length === 0 ? (
            <FilteredEmpty onClear={clearResultFilters} />
          ) : (
            <ul className="space-y-2">
              {sortedResults!.map((r) => (
                <RegistryResultCard
                  key={r.registry_guid}
                  r={r}
                  imgClass={IMG_CLASS[imgSize]}
                  onAddToGarage={() => setAddTarget(r)}
                  inWishlist={wishlistGuids.has(r.registry_guid)}
                  wishing={wishing === r.registry_guid}
                  onAddToWishlist={() => onAddToWishlist(r)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {addTarget && (
        <AddToGarageModal
          target={addTarget}
          onClose={() => setAddTarget(null)}
        />
      )}

      {wishPicker && (
        <Modal
          title="Add to which wishlist?"
          description={
            <>
              <span className="truncate block">
                {wishPicker.result.driver_name}
                {wishPicker.result.year !== null && (
                  <span className="ml-2 text-fg-subtle">
                    {wishPicker.result.year}
                  </span>
                )}
              </span>
              {wishPicker.result.scheme_text && (
                <span className="truncate block">
                  {wishPicker.result.scheme_text}
                </span>
              )}
            </>
          }
          onClose={() => setWishPicker(null)}
          size="max-w-sm"
          panelClassName="space-y-3"
          footer={
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setWishPicker(null)}
            >
              Cancel
            </button>
          }
        >
          <div className="space-y-1.5">
            {wishPicker.lists.map((l) => (
              <button
                key={l.wishlist_id}
                type="button"
                className="btn-secondary w-full !justify-between flex items-center"
                onClick={() => void onPickWishlist(l.wishlist_id)}
              >
                <span className="truncate">{l.name}</span>
                <span className="text-xs text-fg-subtle tabular-nums shrink-0 ml-2">
                  {l.entry_count} entr{l.entry_count === 1 ? "y" : "ies"}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function RegistryResultCard({
  r,
  imgClass,
  onAddToGarage,
  inWishlist,
  wishing,
  onAddToWishlist,
}: {
  r: ProductionSearchResult;
  imgClass: string;
  onAddToGarage: () => void;
  inWishlist: boolean;
  wishing: boolean;
  onAddToWishlist: () => void;
}) {
  const [minimized, toggleMinimized] = useMinimized(
    `registry:${r.registry_guid}`,
  );
  return (
    <li className={`card flex items-start gap-4 ${minimized ? "!py-2" : ""}`}>
      <MinimizeToggle
        minimized={minimized}
        onToggle={toggleMinimized}
        className="-mt-0.5"
      />
      {!minimized && <Thumbnail src={r.image_url} className={imgClass} />}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">
              {r.driver_name}
              {r.year && <span className="text-fg-subtle ml-2">{r.year}</span>}
            </div>
            <div className="text-xs text-fg-muted truncate mt-0.5">
              {r.scheme_text ?? "(no scheme)"}
            </div>
          </div>
        </div>
        {!minimized && (
          <>
            <div className="text-xs text-fg-subtle mt-0.5">
              {[r.oem, r.brand, r.scale, r.make].filter(Boolean).join(" · ")}
            </div>
            {r.seq_produced_total !== null && (
              <div className="text-xs text-fg-faint mt-0.5">
                production qty {formatCount(r.seq_produced_total)}
              </div>
            )}
            <div className="flex items-center gap-3 mt-1">
              {r.detail_url && (
                <a
                  className="text-xs text-accent hover:underline"
                  href={DCR_BASE + r.detail_url}
                  onClick={(e) => {
                    e.preventDefault();
                    void openExternal(DCR_BASE + r.detail_url!);
                  }}
                >
                  View on diecastregistry.com →
                </a>
              )}
              <button
                type="button"
                className="text-xs text-accent hover:underline"
                onClick={onAddToGarage}
                title="Register this diecast to your diecastregistry.com garage"
              >
                + Add to garage
              </button>
              {inWishlist ? (
                <ViewLink
                  to="/wishlist"
                  className="text-xs text-emerald-400 hover:underline"
                  title="Already on your wishlist — open it"
                >
                  ✓ In wishlist
                </ViewLink>
              ) : (
                <button
                  type="button"
                  className="text-xs text-accent hover:underline"
                  onClick={onAddToWishlist}
                  disabled={wishing}
                  title="Add this entry to your wishlist"
                >
                  {wishing ? "Adding…" : "♡ Add to wishlist"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
        <div className="text-base text-fg">
          {formatCents(r.retail_value_cents)}
        </div>
        {!minimized && (
          <div className="text-fg-subtle">
            wholesale {formatCents(r.wholesale_value_cents)}
          </div>
        )}
      </div>
    </li>
  );
}

function ValueRangeFilter({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span>{label} $</span>
      <input
        type="text"
        inputMode="decimal"
        className="input !w-16 !py-0.5 !text-[11px]"
        value={min}
        onChange={(e) => onMin(e.target.value)}
        placeholder="min"
        title={`Minimum ${label.toLowerCase()} value`}
      />
      <span>–</span>
      <input
        type="text"
        inputMode="decimal"
        className="input !w-16 !py-0.5 !text-[11px]"
        value={max}
        onChange={(e) => onMax(e.target.value)}
        placeholder="max"
        title={`Maximum ${label.toLowerCase()} value`}
      />
    </div>
  );
}

function AddToGarageModal({
  target,
  onClose,
}: {
  target: ProductionSearchResult;
  onClose: () => void;
}) {
  const [condition, setCondition] = useState<Condition>("mint");
  const [autographed, setAutographed] = useState(false);
  const [prototype, setPrototype] = useState(false);
  const [chassisNumber, setChassisNumber] = useState("");
  const [comments, setComments] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    registration_number: string;
    registry_int_id: number;
  } | null>(null);

  // The search results don't tell us whether a diecast is sequentially
  // numbered — the backend detects that from the registration form HTML.
  // We always show the chassis field; the backend ignores it for NSN items
  // and requires it for sequentially-numbered ones (unless prototype=true).
  const isProduced =
    target.seq_produced_total !== null && target.seq_produced_total > 1;

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const trimmedChassis = chassisNumber.trim();
      const parsedChassis =
        trimmedChassis === "" ? null : Number(trimmedChassis);
      if (
        parsedChassis !== null &&
        (!Number.isInteger(parsedChassis) || parsedChassis <= 0)
      ) {
        setError("Chassis number must be a positive integer.");
        setSubmitting(false);
        return;
      }
      const summary = await api.registerDiecastInGarage({
        registry_guid: target.registry_guid,
        condition,
        autographed,
        prototype,
        chassis_number: parsedChassis,
        comments: comments.trim() === "" ? null : comments.trim(),
      });
      setSuccess({
        registration_number: summary.registration_number,
        registry_int_id: summary.registry_int_id,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Add to My Garage"
      description={
        <>
          <span className="block">
            {target.driver_name}
            {target.year !== null && (
              <span className="ml-2 text-fg-subtle">{target.year}</span>
            )}
          </span>
          {target.scheme_text && (
            <span className="truncate block">{target.scheme_text}</span>
          )}
        </>
      }
      onClose={onClose}
      busy={submitting}
      size="max-w-md"
      panelClassName="space-y-3"
      footer={
        success ? (
          <button type="button" className="btn-primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onSubmit}
              disabled={submitting}
            >
              {submitting ? "Adding…" : "Add to garage"}
            </button>
          </>
        )
      }
    >
      {success ? (
        <div className="space-y-3">
          <div className="text-sm text-emerald-400">
            ✓ Added to your garage.
          </div>
          <div className="text-sm">
            DCR registration number:{" "}
            <span className="font-mono tabular-nums">
              {success.registration_number}
            </span>
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className="label">Condition</label>
            <select
              className="input"
              value={condition}
              onChange={(e) => setCondition(e.target.value as Condition)}
              disabled={submitting}
            >
              {CONDITION_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={autographed}
                onChange={(e) => setAutographed(e.target.checked)}
                disabled={submitting}
              />
              Autographed
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={prototype}
                onChange={(e) => setPrototype(e.target.checked)}
                disabled={submitting}
              />
              Prototype
            </label>
          </div>

          {isProduced && !prototype && (
            <div>
              <label className="label">DIN / Chassis number</label>
              <input
                type="text"
                inputMode="numeric"
                className="input"
                value={chassisNumber}
                onChange={(e) => setChassisNumber(e.target.value)}
                placeholder={`1 of ${target.seq_produced_total ?? "—"}`}
                disabled={submitting}
              />
              <div className="text-xs text-fg-subtle mt-0.5">
                Required for sequentially-numbered diecasts. Leave blank if this
                isn't sequentially numbered — the registry will tell us.
              </div>
            </div>
          )}

          <div>
            <label className="label">Comments (optional)</label>
            <textarea
              className="input"
              rows={2}
              maxLength={4000}
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              disabled={submitting}
            />
          </div>

          {error && <ErrorBanner error={error} variant="inline" />}
        </>
      )}
    </Modal>
  );
}
