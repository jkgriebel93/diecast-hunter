import { useEffect, useState } from "react";
import {
  api,
  formatCents,
  type FormOptionRow,
  type ProductionSearchResult,
} from "@/lib/tauri";

const DCR_BASE = "https://www.diecastregistry.com";

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
  const [optionsLoaded, setOptionsLoaded] = useState(false);

  const [driverInput, setDriverInput] = useState("");
  const [selectedDriverGuid, setSelectedDriverGuid] = useState("");
  const [selectedYear, setSelectedYear] = useState("");
  const [selectedOemGuid, setSelectedOemGuid] = useState("");
  const [selectedScaleGuid, setSelectedScaleGuid] = useState("");
  const [autographed, setAutographed] = useState(false);
  const [raced, setRaced] = useState(false);

  const [results, setResults] = useState<ProductionSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void loadOptions();
  }, []);

  async function loadOptions() {
    setError(null);
    try {
      const [d, o, s, y] = await Promise.all([
        api.listRegistryFormOptions("driver"),
        api.listRegistryFormOptions("oem"),
        api.listRegistryFormOptions("scale"),
        api.listRegistryFormOptions("year"),
      ]);
      setDrivers(d);
      setOems(o);
      setScales(s);
      setYears(y);
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
        driver_guids: selectedDriverGuid ? [selectedDriverGuid] : [],
        years: selectedYear ? [selectedYear] : [],
        oem_guids: selectedOemGuid ? [selectedOemGuid] : [],
        scale_guids: selectedScaleGuid ? [selectedScaleGuid] : [],
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

  function onReset() {
    setDriverInput("");
    setSelectedDriverGuid("");
    setSelectedYear("");
    setSelectedOemGuid("");
    setSelectedScaleGuid("");
    setAutographed(false);
    setRaced(false);
    setResults(null);
    setInfo(null);
    setError(null);
  }

  const optionsEmpty =
    optionsLoaded && drivers.length === 0 && oems.length === 0;

  const canSearch =
    !!selectedDriverGuid ||
    !!selectedYear ||
    !!selectedOemGuid ||
    !!selectedScaleGuid ||
    autographed ||
    raced;

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Registry search</h2>
          <p className="text-sm text-fg-subtle">
            Search diecastregistry.com's production catalog. Results link out
            to the registry's detail pages.
          </p>
        </div>
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
        <section className="card space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className="label">Driver</label>
              <input
                list="dcr-drivers-list"
                type="text"
                value={driverInput}
                onChange={(e) => {
                  setDriverInput(e.target.value);
                  const match = drivers.find(
                    (d) => d.display === e.target.value,
                  );
                  setSelectedDriverGuid(match?.value ?? "");
                }}
                className="input"
                placeholder="Type to search…"
                autoComplete="off"
              />
              <datalist id="dcr-drivers-list">
                {drivers.map((d) => (
                  <option key={d.value} value={d.display} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="label">Year</label>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(e.target.value)}
                className="input"
              >
                <option value="">Any</option>
                {years.map((y) => (
                  <option key={y.value} value={y.value}>
                    {y.display}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">OEM</label>
              <select
                value={selectedOemGuid}
                onChange={(e) => setSelectedOemGuid(e.target.value)}
                className="input"
              >
                <option value="">Any</option>
                {oems.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.display}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Scale</label>
              <select
                value={selectedScaleGuid}
                onChange={(e) => setSelectedScaleGuid(e.target.value)}
                className="input"
              >
                <option value="">Any</option>
                {scales.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.display}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs flex-wrap">
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

          <div className="flex items-center justify-between">
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
          <div className="text-xs text-fg-subtle">
            {results.length} result{results.length === 1 ? "" : "s"}.
          </div>
          <ul className="space-y-2">
            {results.map((r) => (
              <li
                key={r.registry_guid}
                className="card flex items-start gap-4"
              >
                {r.image_url ? (
                  <img
                    src={
                      r.image_url.startsWith("http")
                        ? r.image_url
                        : DCR_BASE + r.image_url
                    }
                    alt=""
                    loading="lazy"
                    className="w-24 h-24 object-cover rounded border border-border shrink-0"
                  />
                ) : (
                  <div className="w-24 h-24 rounded border border-border bg-bg shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {r.driver_name}
                    {r.year && (
                      <span className="text-fg-subtle ml-2">{r.year}</span>
                    )}
                  </div>
                  <div className="text-xs text-fg-muted truncate mt-0.5">
                    {r.scheme_text ?? "(no scheme)"}
                  </div>
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
                  {r.detail_url && (
                    <a
                      className="text-xs text-accent hover:underline mt-1 inline-block"
                      href={DCR_BASE + r.detail_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on diecastregistry.com →
                    </a>
                  )}
                </div>
                <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
                  <div className="text-base text-fg">
                    {formatCents(r.retail_value_cents)}
                  </div>
                  <div className="text-fg-subtle">
                    wholesale {formatCents(r.wholesale_value_cents)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
