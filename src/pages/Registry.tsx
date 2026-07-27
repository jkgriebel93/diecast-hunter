import { useEffect, useMemo, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  formatCents,
  isPreferredOem,
  prepareBrandOptions,
  prepareMakeOptions,
  prepareScaleOptions,
  prepareYearOptions,
  driverListingCounts,
  sortDriverOptions,
  type Condition,
  type FormOptionRow,
  type ProductionSearchResult,
  type WishlistInfo,
} from "@/lib/tauri";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";
import { MultiSelect } from "@/components/MultiSelect";
import { ViewLink } from "@/components/ViewLink";
import { useMinimized, MinimizeToggle } from "@/lib/minimized";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

const DCR_BASE = "https://www.diecastregistry.com";

type SortMode =
  | "registry"
  | "driver"
  | "year-desc"
  | "year-asc"
  | "retail-desc"
  | "retail-asc"
  | "qty-asc"
  | "qty-desc";

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
  const [selectedOemGuids, setSelectedOemGuids] = useState<string[]>([]);
  const [selectedScaleGuids, setSelectedScaleGuids] = useState<string[]>([]);
  const [selectedBrandGuids, setSelectedBrandGuids] = useState<string[]>([]);
  const [selectedMakeGuids, setSelectedMakeGuids] = useState<string[]>([]);
  const [selectedFinishGuids, setSelectedFinishGuids] = useState<string[]>([]);
  const [autographed, setAutographed] = useState(false);
  const [raced, setRaced] = useState(false);

  const [results, setResults] = useState<ProductionSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [addTarget, setAddTarget] = useState<ProductionSearchResult | null>(null);
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
  const [retailMin, setRetailMin] = useState("");
  const [retailMax, setRetailMax] = useState("");
  const [wholesaleMin, setWholesaleMin] = useState("");
  const [wholesaleMax, setWholesaleMax] = useState("");

  const filteredResults = useMemo(() => {
    if (!results) return null;
    const rMin = parseDollars(retailMin);
    const rMax = parseDollars(retailMax);
    const wMin = parseDollars(wholesaleMin);
    const wMax = parseDollars(wholesaleMax);
    if (rMin === null && rMax === null && wMin === null && wMax === null) {
      return results;
    }
    return results.filter(
      (r) =>
        inRange(r.retail_value_cents, rMin, rMax) &&
        inRange(r.wholesale_value_cents, wMin, wMax),
    );
  }, [results, retailMin, retailMax, wholesaleMin, wholesaleMax]);

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
        case "driver":
          return (
            a.driver_name.localeCompare(b.driver_name) ||
            (b.year ?? 0) - (a.year ?? 0)
          );
        case "year-desc":
          return nullsLast(b.year, a.year);
        case "year-asc":
          return nullsLast(a.year, b.year);
        case "retail-desc":
          return nullsLast(b.retail_value_cents, a.retail_value_cents);
        case "retail-asc":
          return nullsLast(a.retail_value_cents, b.retail_value_cents);
        case "qty-asc":
          return nullsLast(a.seq_produced_total, b.seq_produced_total);
        case "qty-desc":
          return nullsLast(b.seq_produced_total, a.seq_produced_total);
      }
    });
    return list;
  }, [filteredResults, sortMode]);

  useEffect(() => {
    void loadOptions();
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

  async function onSearch() {
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const r = await api.searchDcrProduction({
        driver_guids: selectedDriverGuids,
        years: selectedYears,
        oem_guids: selectedOemGuids,
        scale_guids: selectedScaleGuids,
        brand_guids: selectedBrandGuids,
        make_guids: selectedMakeGuids,
        finish_guids: selectedFinishGuids,
        autographed,
        raced,
      });
      setResults(r);
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
    selectedYears.length > 0 ||
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
          Search diecastregistry.com's production catalog. Results link out
          to the registry's detail pages.
        </p>
      </header>

      {!optionsLoaded ? (
        <div className="card text-sm text-fg-muted">Loading filter options…</div>
      ) : optionsEmpty ? (
        <div className="card text-sm text-amber-400/90 space-y-2">
          <div>
            The registry option cache is empty. Fetch it once (a few seconds)
            so the filter dropdowns can populate.
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
                  canSearch
                    ? "Search the registry"
                    : "Pick at least one filter"
                }
              >
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
          </div>
        </section>
      )}

      {info && <div className="text-xs text-emerald-400">{info}</div>}
      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}

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
                  ? `${results.length} result${results.length === 1 ? "" : "s"}.`
                  : `${sortedResults!.length} of ${results.length} results.`}
              </div>
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
                  <option value="driver">Driver A → Z</option>
                  <option value="year-desc">Year newest first</option>
                  <option value="year-asc">Year oldest first</option>
                  <option value="retail-desc">Retail value high → low</option>
                  <option value="retail-asc">Retail value low → high</option>
                  <option value="qty-asc">Production qty low → high</option>
                  <option value="qty-desc">Production qty high → low</option>
                </select>
              </div>
              <ImageSizeToggle size={imgSize} onChange={setImgSize} />
            </div>
          </div>
          {sortedResults!.length === 0 ? (
            <div className="card text-sm text-fg-muted">
              No results in this value range.
            </div>
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
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setWishPicker(null);
          }}
        >
          <div
            className="card w-full max-w-sm space-y-3"
            role="dialog"
            aria-modal="true"
          >
            <header>
              <h3 className="text-lg font-semibold">Add to which wishlist?</h3>
              <div className="text-xs text-fg-muted mt-0.5 truncate">
                {wishPicker.result.driver_name}
                {wishPicker.result.year !== null && (
                  <span className="ml-2 text-fg-subtle">
                    {wishPicker.result.year}
                  </span>
                )}
              </div>
              {wishPicker.result.scheme_text && (
                <div className="text-xs text-fg-subtle truncate">
                  {wishPicker.result.scheme_text}
                </div>
              )}
            </header>
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
            <div className="flex justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setWishPicker(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
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
    <li
      className={`card flex items-start gap-4 ${minimized ? "!py-2" : ""}`}
    >
      <MinimizeToggle
        minimized={minimized}
        onToggle={toggleMinimized}
        className="-mt-0.5"
      />
      {!minimized &&
        (r.image_url ? (
          <img
            src={
              r.image_url.startsWith("http")
                ? r.image_url
                : DCR_BASE + r.image_url
            }
            alt=""
            loading="lazy"
            className={`${imgClass} object-cover rounded border border-border shrink-0`}
          />
        ) : (
          <div
            className={`${imgClass} rounded border border-border bg-bg shrink-0`}
          />
        ))}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">
              {r.driver_name}
              {r.year && (
                <span className="text-fg-subtle ml-2">{r.year}</span>
              )}
            </div>
            <div className="text-xs text-fg-muted truncate mt-0.5">
              {r.scheme_text ?? "(no scheme)"}
            </div>
          </div>
        </div>
        {!minimized && (
          <>
            <div className="text-xs text-fg-subtle mt-0.5">
              {[r.oem, r.brand, r.scale, r.make]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {r.seq_produced_total !== null && (
              <div className="text-xs text-fg-faint mt-0.5">
                production qty {r.seq_produced_total.toLocaleString()}
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
  const isProduced = target.seq_produced_total !== null && target.seq_produced_total > 1;

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
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="card w-full max-w-md space-y-3" role="dialog" aria-modal="true">
        <header>
          <h3 className="text-lg font-semibold">Add to My Garage</h3>
          <div className="text-xs text-fg-muted mt-0.5">
            {target.driver_name}
            {target.year !== null && (
              <span className="ml-2 text-fg-subtle">{target.year}</span>
            )}
          </div>
          {target.scheme_text && (
            <div className="text-xs text-fg-subtle truncate">
              {target.scheme_text}
            </div>
          )}
        </header>

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
            <div className="flex justify-end">
              <button
                type="button"
                className="btn-primary"
                onClick={onClose}
              >
                Close
              </button>
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
                  Required for sequentially-numbered diecasts. Leave blank if
                  this isn't sequentially numbered — the registry will tell us.
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

            {error && (
              <div className="text-xs text-red-400">{error}</div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
