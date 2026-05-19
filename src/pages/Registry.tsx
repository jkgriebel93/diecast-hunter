import { useEffect, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  api,
  formatCents,
  isPreferredOem,
  type Condition,
  type FormOptionRow,
  type ProductionSearchResult,
} from "@/lib/tauri";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

const DCR_BASE = "https://www.diecastregistry.com";

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

  const [driverInput, setDriverInput] = useState("");
  const [selectedDriverGuid, setSelectedDriverGuid] = useState("");
  const [selectedYear, setSelectedYear] = useState("");
  const [oemInput, setOemInput] = useState("");
  const [selectedOemGuid, setSelectedOemGuid] = useState("");
  const [showAllOems, setShowAllOems] = useState(false);
  const [selectedScaleGuid, setSelectedScaleGuid] = useState("");
  const [brandInput, setBrandInput] = useState("");
  const [selectedBrandGuid, setSelectedBrandGuid] = useState("");
  const [makeInput, setMakeInput] = useState("");
  const [selectedMakeGuid, setSelectedMakeGuid] = useState("");
  const [finishInput, setFinishInput] = useState("");
  const [selectedFinishGuid, setSelectedFinishGuid] = useState("");
  const [autographed, setAutographed] = useState(false);
  const [raced, setRaced] = useState(false);

  const [results, setResults] = useState<ProductionSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [addTarget, setAddTarget] = useState<ProductionSearchResult | null>(null);
  const [imgSize, setImgSize] = useImageSize("registry");

  useEffect(() => {
    void loadOptions();
  }, []);

  async function loadOptions() {
    setError(null);
    try {
      const [d, o, s, y, b, m, f] = await Promise.all([
        api.listRegistryFormOptions("driver"),
        api.listRegistryFormOptions("oem"),
        api.listRegistryFormOptions("scale"),
        api.listRegistryFormOptions("year"),
        api.listRegistryFormOptions("brand"),
        api.listRegistryFormOptions("make"),
        api.listRegistryFormOptions("finish"),
      ]);
      setDrivers(d);
      setOems(o);
      setScales(s);
      setYears(y);
      setBrands(b);
      setMakes(m);
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
        driver_guids: selectedDriverGuid ? [selectedDriverGuid] : [],
        years: selectedYear ? [selectedYear] : [],
        oem_guids: selectedOemGuid ? [selectedOemGuid] : [],
        scale_guids: selectedScaleGuid ? [selectedScaleGuid] : [],
        brand_guids: selectedBrandGuid ? [selectedBrandGuid] : [],
        make_guids: selectedMakeGuid ? [selectedMakeGuid] : [],
        finish_guids: selectedFinishGuid ? [selectedFinishGuid] : [],
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
    setOemInput("");
    setSelectedOemGuid("");
    setShowAllOems(false);
    setSelectedScaleGuid("");
    setBrandInput("");
    setSelectedBrandGuid("");
    setMakeInput("");
    setSelectedMakeGuid("");
    setFinishInput("");
    setSelectedFinishGuid("");
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
    !!selectedBrandGuid ||
    !!selectedMakeGuid ||
    !!selectedFinishGuid ||
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
              <input
                list="dcr-oems-list"
                type="text"
                value={oemInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setOemInput(v);
                  const match = oems.find((o) => o.display === v);
                  setSelectedOemGuid(match?.value ?? "");
                }}
                className="input"
                placeholder="Any (type to search…)"
                autoComplete="off"
              />
              <datalist id="dcr-oems-list">
                {(oemInput.trim() === "" && !showAllOems
                  ? oems.filter((o) => isPreferredOem(o.display))
                  : oems
                ).map((o) => (
                  <option key={o.value} value={o.display} />
                ))}
              </datalist>
              {oemInput.trim() === "" && !showAllOems && (
                <button
                  type="button"
                  className="text-xs text-fg-subtle hover:text-fg-muted mt-1"
                  onClick={() => setShowAllOems(true)}
                >
                  More…
                </button>
              )}
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
            <div>
              <label className="label">Brand</label>
              <input
                list="dcr-brands-list"
                type="text"
                value={brandInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setBrandInput(v);
                  const match = brands.find((b) => b.display === v);
                  setSelectedBrandGuid(match?.value ?? "");
                }}
                className="input"
                placeholder="Any (type to search…)"
                autoComplete="off"
              />
              <datalist id="dcr-brands-list">
                {brands.map((b) => (
                  <option key={b.value} value={b.display} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="label">Make</label>
              <input
                list="dcr-makes-list"
                type="text"
                value={makeInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setMakeInput(v);
                  const match = makes.find((m) => m.display === v);
                  setSelectedMakeGuid(match?.value ?? "");
                }}
                className="input"
                placeholder="Any (type to search…)"
                autoComplete="off"
              />
              <datalist id="dcr-makes-list">
                {makes.map((m) => (
                  <option key={m.value} value={m.display} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="label">Finish</label>
              <input
                list="dcr-finishes-list"
                type="text"
                value={finishInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setFinishInput(v);
                  const match = finishes.find((f) => f.display === v);
                  setSelectedFinishGuid(match?.value ?? "");
                }}
                className="input"
                placeholder="Any (type to search…)"
                autoComplete="off"
              />
              <datalist id="dcr-finishes-list">
                {finishes.map((f) => (
                  <option key={f.value} value={f.display} />
                ))}
              </datalist>
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
          <div className="flex items-center justify-between text-xs text-fg-subtle">
            <div>
              {results.length} result{results.length === 1 ? "" : "s"}.
            </div>
            <ImageSizeToggle size={imgSize} onChange={setImgSize} />
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
                    className={`${IMG_CLASS[imgSize]} object-cover rounded border border-border shrink-0`}
                  />
                ) : (
                  <div className={`${IMG_CLASS[imgSize]} rounded border border-border bg-bg shrink-0`} />
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
                      onClick={() => setAddTarget(r)}
                      title="Register this diecast to your diecastregistry.com garage"
                    >
                      + Add to garage
                    </button>
                  </div>
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

      {addTarget && (
        <AddToGarageModal
          target={addTarget}
          onClose={() => setAddTarget(null)}
        />
      )}
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
