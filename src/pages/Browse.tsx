import { FormEvent, useState } from "react";
import {
  api,
  formatCents,
  type EbaySearchFilters,
  type EbaySearchItem,
  type EbaySearchPage,
} from "@/lib/tauri";

const PAGE_SIZE = 50;

const CONDITION_OPTIONS: { value: string; label: string }[] = [
  { value: "NEW", label: "New" },
  { value: "USED", label: "Used" },
  { value: "UNSPECIFIED", label: "Unspecified" },
];

const BUYING_OPTIONS: { value: string; label: string }[] = [
  { value: "FIXED_PRICE", label: "Buy It Now" },
  { value: "AUCTION", label: "Auction" },
];

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Best match" },
  { value: "price", label: "Price low → high" },
  { value: "-price", label: "Price high → low" },
  { value: "newlyListed", label: "Newly listed" },
  { value: "endingSoonest", label: "Ending soonest" },
];

/**
 * Browse eBay's diecast catalog. Backed by the Browse API search endpoint;
 * results are constrained to "Diecast & Toy Vehicles" so they stay aligned
 * with the rest of the app's diecast filter. Each card has an inline
 * "Save" action that mirrors the listing into the local DB via the existing
 * add-listing path. Adding to the actual eBay watchlist arrives in stage 2.
 */
export function Browse() {
  const [query, setQuery] = useState("");
  const [conditions, setConditions] = useState<string[]>([]);
  const [buyingOptions, setBuyingOptions] = useState<string[]>([]);
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [sort, setSort] = useState("");

  const [page, setPage] = useState<EbaySearchPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [savedItemIds, setSavedItemIds] = useState<Set<string>>(new Set());
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  function buildFilters(): EbaySearchFilters {
    const minCents = parseDollarsToCents(priceMin);
    const maxCents = parseDollarsToCents(priceMax);
    return {
      conditions,
      buying_options: buyingOptions,
      price_min_cents: minCents,
      price_max_cents: maxCents,
      sort: sort || null,
    };
  }

  async function runSearch(nextOffset: number) {
    setSearching(true);
    setError(null);
    try {
      const result = await api.searchEbayListings(
        query.trim(),
        buildFilters(),
        PAGE_SIZE,
        nextOffset,
      );
      setPage(result);
      setOffset(nextOffset);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await runSearch(0);
  }

  async function onSave(item: EbaySearchItem) {
    setSavingItemId(item.item_id);
    setSaveMessage(null);
    setError(null);
    try {
      const result = await api.addEbayListing(
        item.legacy_item_id ?? item.web_url,
      );
      if (result.filtered_reason) {
        setError(
          `${result.filtered_reason}. To save anyway, turn off the diecast filter in Settings.`,
        );
      } else {
        setSavedItemIds((prev) => new Set(prev).add(item.item_id));
        setSaveMessage(
          `${result.created ? "Saved" : "Updated"}: ${result.title}`,
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingItemId(null);
    }
  }

  function toggleArrayValue(
    list: string[],
    setList: (v: string[]) => void,
    value: string,
  ) {
    if (list.includes(value)) {
      setList(list.filter((v) => v !== value));
    } else {
      setList([...list, value]);
    }
  }

  const showingFrom = page && page.items.length > 0 ? offset + 1 : 0;
  const showingTo = page ? offset + page.items.length : 0;

  return (
    <div className="p-6 space-y-4">
      <header>
        <h2 className="text-2xl font-semibold">Browse eBay</h2>
        <p className="text-sm text-slate-500">
          Search the diecast catalog on eBay. Save listings locally to track
          their price; full watchlist sync ships in the next stage.
        </p>
      </header>

      <form onSubmit={onSubmit} className="card space-y-3">
        <div className="flex items-center gap-2">
          <input
            className="input flex-1"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search NASCAR diecast — e.g. ‘Jeff Gordon DuPont 1:24’"
            autoComplete="off"
          />
          <button
            className="btn-primary shrink-0"
            type="submit"
            disabled={searching}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <FilterChips
            label="Condition"
            values={conditions}
            options={CONDITION_OPTIONS}
            onToggle={(v) =>
              toggleArrayValue(conditions, setConditions, v)
            }
          />
          <FilterChips
            label="Format"
            values={buyingOptions}
            options={BUYING_OPTIONS}
            onToggle={(v) =>
              toggleArrayValue(buyingOptions, setBuyingOptions, v)
            }
          />
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
          <div>
            <label className="label">Min price (USD)</label>
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={priceMin}
              onChange={(e) => setPriceMin(e.target.value)}
              placeholder="e.g. 10"
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
              placeholder="e.g. 100"
            />
          </div>
        </div>
      </form>

      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}
      {saveMessage && (
        <div className="text-xs text-emerald-400">{saveMessage}</div>
      )}

      {page && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <div>
            {page.total > 0
              ? `Showing ${showingFrom}–${showingTo} of ${page.total.toLocaleString()} results`
              : "No results."}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => runSearch(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || searching}
            >
              ← Previous
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => runSearch(offset + PAGE_SIZE)}
              disabled={!page.has_more || searching}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {page === null ? (
        <div className="card text-sm text-slate-400">
          Type a query and hit Search to see eBay diecast listings.
        </div>
      ) : page.items.length === 0 ? (
        <div className="card text-sm text-slate-400">
          No results for the current search.
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {page.items.map((item) => (
            <SearchCard
              key={item.item_id}
              item={item}
              saving={savingItemId === item.item_id}
              saved={savedItemIds.has(item.item_id)}
              onSave={() => onSave(item)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchCard({
  item,
  saving,
  saved,
  onSave,
}: {
  item: EbaySearchItem;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}) {
  const total =
    item.price_cents !== null
      ? item.price_cents + (item.shipping_cents ?? 0)
      : null;
  return (
    <li className="card flex flex-col gap-2">
      <div className="flex gap-3">
        {item.image_url ? (
          <img
            src={item.image_url}
            alt=""
            loading="lazy"
            className="w-24 h-24 object-cover rounded border border-border shrink-0"
          />
        ) : (
          <div className="w-24 h-24 rounded border border-border bg-bg-elevated shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div
            className="text-sm font-medium line-clamp-2"
            title={item.title}
          >
            {item.title}
          </div>
          <div className="text-xs text-slate-500 mt-1 truncate">
            {[
              item.condition,
              item.listing_type,
              item.seller_username && `seller: ${item.seller_username}`,
              item.seller_rating !== null &&
                item.seller_rating !== undefined &&
                `${item.seller_rating}%`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {item.end_time && item.listing_type === "auction" && (
            <div className="text-xs text-slate-500 mt-0.5">
              ends {new Date(item.end_time * 1000).toLocaleString()}
            </div>
          )}
        </div>
        <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
          <div className="text-base text-slate-100">
            {formatCents(item.price_cents)}
          </div>
          {item.shipping_cents !== null && item.shipping_cents > 0 && (
            <div className="text-slate-500">
              + {formatCents(item.shipping_cents)} ship
            </div>
          )}
          {total !== null &&
            item.shipping_cents !== null &&
            item.shipping_cents > 0 && (
              <div className="text-slate-400">total {formatCents(total)}</div>
            )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 text-xs">
        <a
          className="text-accent hover:underline"
          href={item.web_url}
          target="_blank"
          rel="noreferrer"
        >
          View on eBay →
        </a>
        <button
          type="button"
          className="text-slate-300 hover:text-slate-100 disabled:opacity-50"
          onClick={onSave}
          disabled={saving || saved}
          title="Save to local listings for tracking"
        >
          {saved ? "✓ Saved" : saving ? "Saving…" : "Save"}
        </button>
      </div>
    </li>
  );
}

function FilterChips({
  label,
  values,
  options,
  onToggle,
}: {
  label: string;
  values: string[];
  options: { value: string; label: string }[];
  onToggle: (v: string) => void;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = values.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              className={`px-2 py-1 rounded border text-xs ${
                active
                  ? "border-accent text-accent bg-accent/10"
                  : "border-border text-slate-400 hover:text-slate-100"
              }`}
              onClick={() => onToggle(opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
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
