import { FormEvent, useEffect, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  api,
  formatCents,
  type EbaySearchItem,
  type EbaySearchPage,
  type SavedSearch,
  type SavedSearchInput,
  type SavedSyncSummary,
} from "@/lib/tauri";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";
import { useMinimized, MinimizeToggle } from "@/lib/minimized";
import { ErrorBanner } from "@/components/ErrorBanner";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-12 h-12",
  md: "w-24 h-24",
  lg: "w-36 h-36",
};

const PAGE_SIZE = 50;

const CONDITION_OPTIONS = [
  { value: "NEW", label: "New" },
  { value: "USED", label: "Used" },
  { value: "UNSPECIFIED", label: "Unspecified" },
];

const BUYING_OPTIONS = [
  { value: "FIXED_PRICE", label: "Buy It Now" },
  { value: "AUCTION", label: "Auction" },
];

const SORT_OPTIONS = [
  { value: "", label: "Best match" },
  { value: "price", label: "Price low → high" },
  { value: "-price", label: "Price high → low" },
  { value: "newlyListed", label: "Newly listed" },
  { value: "endingSoonest", label: "Ending soonest" },
];

export function SavedSearches() {
  const [rows, setRows] = useState<SavedSearch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SavedSearch | "new" | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [resultsFor, setResultsFor] = useState<SavedSearch | null>(null);
  const [results, setResults] = useState<EbaySearchPage | null>(null);
  const [resultsOffset, setResultsOffset] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [imgSize, setImgSize] = useImageSize("savedSearches");

  async function onSync() {
    setSyncing(true);
    setSyncMessage(null);
    setError(null);
    try {
      const summary: SavedSyncSummary = await api.syncEbaySaved();
      setSyncMessage(
        `Searches: +${summary.searches_created} new, ~${summary.searches_updated} updated, -${summary.searches_pruned} pruned (of ${summary.searches_seen}). ` +
          `Sellers: +${summary.sellers_created} new, ~${summary.sellers_updated} updated, -${summary.sellers_pruned} pruned (of ${summary.sellers_seen}).`,
      );
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function load() {
    setError(null);
    try {
      setRows(await api.listSavedSearches());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function onDelete(s: SavedSearch) {
    if (!window.confirm(`Delete saved search "${s.name}"?`)) return;
    setError(null);
    try {
      await api.deleteSavedSearch(s.id);
      if (resultsFor?.id === s.id) {
        setResultsFor(null);
        setResults(null);
      }
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRun(s: SavedSearch, offset = 0) {
    setRunningId(s.id);
    setError(null);
    setResultsFor(s);
    try {
      const page = await api.runSavedSearch(s.id, PAGE_SIZE, offset);
      setResults(page);
      setResultsOffset(offset);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunningId(null);
    }
  }

  async function onSubmit(
    input: SavedSearchInput,
    existing: SavedSearch | null,
  ) {
    setError(null);
    try {
      if (existing) {
        await api.updateSavedSearch(existing.id, input);
      } else {
        await api.createSavedSearch(input);
      }
      setEditing(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="p-6 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-2xl font-semibold">Saved Searches</h2>
          <p className="text-sm text-fg-subtle">
            Save eBay Browse queries and rerun them with one click. Filters
            match the Browse page exactly.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            type="button"
            onClick={onSync}
            disabled={syncing}
            title="Pull your eBay-side saved searches and prune ones removed there"
          >
            {syncing ? "Syncing…" : "Sync from eBay"}
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={() => setEditing("new")}
          >
            New saved search
          </button>
        </div>
      </header>
      {syncMessage && (
        <div className="text-xs text-emerald-400">{syncMessage}</div>
      )}

      {error && <ErrorBanner error={error} />}

      {rows === null ? (
        // A failed load leaves this null forever; the error banner above
        // is the state, not "still loading".
        error ? null : (
          <div className="card text-sm text-fg-muted">Loading…</div>
        )
      ) : rows.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          No saved searches yet. Click "New saved search", or save one from the{" "}
          <a href="/browse" className="text-accent hover:underline">
            Browse eBay
          </a>{" "}
          page after running a search you like.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <li key={s.id} className="card">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <span className="truncate">{s.name}</span>
                    {s.ebay_origin && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded border border-border text-fg-subtle"
                        title="Synced from eBay. Removed there → pruned here on next sync."
                      >
                        from eBay
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-fg-subtle mt-0.5 truncate">
                    {summarizeFilters(s)}
                  </div>
                  <div className="text-xs text-fg-faint mt-1">
                    {s.last_run_at
                      ? `Last run ${new Date(s.last_run_at * 1000).toLocaleString()}`
                      : "Never run"}
                    {s.last_synced_at && (
                      <span>
                        {" · synced "}
                        {new Date(s.last_synced_at * 1000).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button
                    className="btn-primary text-xs"
                    type="button"
                    onClick={() => onRun(s)}
                    disabled={runningId === s.id}
                  >
                    {runningId === s.id ? "Running…" : "Run"}
                  </button>
                  <div className="flex gap-2 text-xs">
                    <button
                      className="text-fg-muted hover:text-fg"
                      type="button"
                      onClick={() => setEditing(s)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-fg-subtle hover:text-red-300"
                      type="button"
                      onClick={() => onDelete(s)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>

              {resultsFor?.id === s.id && results && (
                <ResultsPanel
                  page={results}
                  offset={resultsOffset}
                  onPage={(off) => onRun(s, off)}
                  onClose={() => {
                    setResultsFor(null);
                    setResults(null);
                  }}
                  imgSize={imgSize}
                  onChangeImgSize={setImgSize}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <SearchEditor
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSubmit={onSubmit}
        />
      )}
    </div>
  );
}

function summarizeFilters(s: SavedSearch): string {
  const parts: string[] = [];
  if (s.query) parts.push(`"${s.query}"`);
  if (s.conditions.length) parts.push(`cond: ${s.conditions.join(", ")}`);
  if (s.buying_options.length)
    parts.push(`format: ${s.buying_options.join(", ")}`);
  if (s.sellers.length) parts.push(`sellers: ${s.sellers.join(", ")}`);
  if (s.price_min_cents !== null || s.price_max_cents !== null) {
    parts.push(
      `price: ${formatCents(s.price_min_cents)} – ${formatCents(s.price_max_cents)}`,
    );
  }
  if (s.sort) parts.push(`sort: ${s.sort}`);
  return parts.length ? parts.join(" · ") : "(no filters)";
}

function ResultsPanel({
  page,
  offset,
  onPage,
  onClose,
  imgSize,
  onChangeImgSize,
}: {
  page: EbaySearchPage;
  offset: number;
  onPage: (offset: number) => void;
  onClose: () => void;
  imgSize: ImageSize;
  onChangeImgSize: (s: ImageSize) => void;
}) {
  const imgSizeClass = IMG_CLASS[imgSize];
  const showingFrom = page.items.length > 0 ? offset + 1 : 0;
  const showingTo = offset + page.items.length;
  return (
    <div className="mt-3 pt-3 border-t border-border space-y-2">
      <div className="flex items-center justify-between text-xs text-fg-subtle">
        <div>
          {page.total > 0
            ? `Showing ${showingFrom}–${showingTo} of ${page.total.toLocaleString()}`
            : "No results."}
        </div>
        <div className="flex items-center gap-2">
          <ImageSizeToggle size={imgSize} onChange={onChangeImgSize} />
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
          >
            ← Previous
          </button>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => onPage(offset + PAGE_SIZE)}
            disabled={!page.has_more}
          >
            Next →
          </button>
          <button
            type="button"
            className="text-fg-muted hover:text-fg"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
      <ul className="divide-y divide-border">
        {page.items.map((item) => (
          <ResultRow
            key={item.item_id}
            item={item}
            imgSizeClass={imgSizeClass}
          />
        ))}
      </ul>
    </div>
  );
}

function ResultRow({
  item,
  imgSizeClass,
}: {
  item: EbaySearchItem;
  imgSizeClass: string;
}) {
  const total =
    item.price_cents !== null
      ? item.price_cents + (item.shipping_cents ?? 0)
      : null;
  const [minimized, toggleMinimized] = useMinimized(
    `ebay-item:${item.item_id}`,
  );
  return (
    <li className="py-2 flex items-center gap-3">
      <MinimizeToggle minimized={minimized} onToggle={toggleMinimized} />
      {!minimized &&
        (item.image_url ? (
          <img
            src={item.image_url}
            alt=""
            loading="lazy"
            className={`${imgSizeClass} object-cover rounded border border-border shrink-0`}
          />
        ) : (
          <div
            className={`${imgSizeClass} rounded border border-border bg-bg-elevated shrink-0`}
          />
        ))}
      <div className="flex-1 min-w-0">
        <a
          href={item.web_url}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(item.web_url);
          }}
          className="text-sm text-fg hover:text-accent truncate block"
        >
          {item.title}
        </a>
        {!minimized && (
          <div className="text-xs text-fg-subtle truncate">
            {[item.condition, item.listing_type, item.seller_username]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </div>
      <div className="text-right text-xs tabular-nums shrink-0">
        <div className="text-sm">{formatCents(item.price_cents)}</div>
        {!minimized &&
          total !== null &&
          item.shipping_cents !== null &&
          item.shipping_cents > 0 && (
            <div className="text-fg-subtle">total {formatCents(total)}</div>
          )}
      </div>
    </li>
  );
}

function SearchEditor({
  existing,
  onClose,
  onSubmit,
}: {
  existing: SavedSearch | null;
  onClose: () => void;
  onSubmit: (input: SavedSearchInput, existing: SavedSearch | null) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [query, setQuery] = useState(existing?.query ?? "");
  const [conditions, setConditions] = useState<string[]>(
    existing?.conditions ?? [],
  );
  const [buyingOptions, setBuyingOptions] = useState<string[]>(
    existing?.buying_options ?? [],
  );
  const [sellersText, setSellersText] = useState(
    (existing?.sellers ?? []).join(", "),
  );
  const [priceMin, setPriceMin] = useState(
    existing?.price_min_cents !== null &&
      existing?.price_min_cents !== undefined
      ? (existing.price_min_cents / 100).toString()
      : "",
  );
  const [priceMax, setPriceMax] = useState(
    existing?.price_max_cents !== null &&
      existing?.price_max_cents !== undefined
      ? (existing.price_max_cents / 100).toString()
      : "",
  );
  const [sort, setSort] = useState(existing?.sort ?? "");

  function toggle(
    list: string[],
    setList: (v: string[]) => void,
    value: string,
  ) {
    if (list.includes(value)) setList(list.filter((v) => v !== value));
    else setList([...list, value]);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const sellers = sellersText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    onSubmit(
      {
        name: name.trim(),
        query: query.trim(),
        conditions,
        buying_options: buyingOptions,
        sellers,
        price_min_cents: parseDollarsToCents(priceMin),
        price_max_cents: parseDollarsToCents(priceMax),
        sort: sort.trim() || null,
      },
      existing,
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/60"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="card w-full max-w-2xl max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-base font-medium">
            {existing ? "Edit saved search" : "New saved search"}
          </h3>
          <button
            type="button"
            className="text-fg-muted hover:text-fg text-xl leading-none px-2"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Name</label>
            <input
              className="input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="e.g. ‘Gordon DuPont 1:24 under $50’"
            />
          </div>
          <div>
            <label className="label">Query</label>
            <input
              className="input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search keywords (optional)"
            />
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3">
            <div>
              <label className="label">Conditions</label>
              <div className="flex flex-wrap gap-1.5">
                {CONDITION_OPTIONS.map((opt) => {
                  const active = conditions.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`px-2 py-1 rounded border text-xs ${
                        active
                          ? "border-accent text-accent bg-accent/10"
                          : "border-border text-fg-muted hover:text-fg"
                      }`}
                      onClick={() =>
                        toggle(conditions, setConditions, opt.value)
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="label">Format</label>
              <div className="flex flex-wrap gap-1.5">
                {BUYING_OPTIONS.map((opt) => {
                  const active = buyingOptions.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`px-2 py-1 rounded border text-xs ${
                        active
                          ? "border-accent text-accent bg-accent/10"
                          : "border-border text-fg-muted hover:text-fg"
                      }`}
                      onClick={() =>
                        toggle(buyingOptions, setBuyingOptions, opt.value)
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3">
            <div>
              <label className="label">Min price (USD)</label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={priceMin}
                onChange={(e) => setPriceMin(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Max price (USD)</label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Sort</label>
              <select
                className="input"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Sellers (comma-separated, optional)</label>
            <input
              className="input"
              type="text"
              value={sellersText}
              onChange={(e) => setSellersText(e.target.value)}
              placeholder="e.g. diecast_seller_42, another_seller"
            />
            <p className="text-xs text-fg-subtle mt-1">
              Restrict results to specific eBay sellers. Leave empty for any
              seller.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-border">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            {existing ? "Save changes" : "Save search"}
          </button>
        </div>
      </form>
    </div>
  );
}

function parseDollarsToCents(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const f = Number(trimmed);
  if (!Number.isFinite(f) || f < 0) return null;
  return Math.round(f * 100);
}
