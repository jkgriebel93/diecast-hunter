import { FormEvent, useEffect, useState } from "react";
import {
  api,
  formatCents,
  type EbaySearchFilters,
  type EbaySearchItem,
  type EbaySearchPage,
} from "@/lib/tauri";
import { Link } from "react-router-dom";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

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
 * Watch / Unwatch toggle that adds the item to the user's eBay watchlist
 * via the Trading API and mirrors it into the local listings table.
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
  const [imgSize, setImgSize] = useImageSize("browse");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  /** itemId → local listings.id. Populated from existing saved listings on
   *  mount and after every watch/unwatch so the UI can flip the button. */
  const [watchedByItemId, setWatchedByItemId] = useState<Map<string, number>>(
    new Map(),
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [savedSellersSet, setSavedSellersSet] = useState<Set<string>>(
    new Set(),
  );
  const [savingSeller, setSavingSeller] = useState<string | null>(null);
  const [savingSearch, setSavingSearch] = useState(false);
  const [savedSearchMsg, setSavedSearchMsg] = useState<string | null>(null);

  useEffect(() => {
    void loadWatched();
    void loadSavedSellers();
  }, []);

  async function loadSavedSellers() {
    try {
      const sellers = await api.listSavedSellers();
      setSavedSellersSet(
        new Set(sellers.map((s) => s.username.toLowerCase())),
      );
    } catch {
      // non-fatal — the "Save seller" button just won't reflect existing
      // bookmarks until the user reloads.
    }
  }

  async function onSaveSeller(username: string) {
    setSavingSeller(username);
    setError(null);
    try {
      await api.addSavedSeller({
        seller_code: "ebay",
        username,
        display_name: null,
        notes: null,
      });
      setSavedSellersSet((prev) => {
        const next = new Set(prev);
        next.add(username.toLowerCase());
        return next;
      });
      setActionMessage(`Saved seller: ${username}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingSeller(null);
    }
  }

  async function onSaveCurrentSearch() {
    const defaultName = query.trim() || "Untitled search";
    const name = window.prompt(
      "Name this saved search",
      defaultName,
    );
    if (name === null) return;
    setSavingSearch(true);
    setSavedSearchMsg(null);
    setError(null);
    try {
      const filters = buildFilters();
      await api.createSavedSearch({
        name: name.trim() || defaultName,
        query: query.trim(),
        conditions: filters.conditions,
        buying_options: filters.buying_options,
        sellers: filters.sellers,
        price_min_cents: filters.price_min_cents,
        price_max_cents: filters.price_max_cents,
        sort: filters.sort,
      });
      setSavedSearchMsg(`Saved as "${name.trim() || defaultName}".`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingSearch(false);
    }
  }

  async function loadWatched() {
    try {
      const rows = await api.listListings();
      const m = new Map<string, number>();
      for (const r of rows) {
        if (r.seller_code === "ebay") m.set(r.external_id, r.listing_id);
      }
      setWatchedByItemId(m);
    } catch (e) {
      // Non-fatal — Watch buttons just won't reflect existing watchlist
      // membership. Surface as a soft warning.
      setError(`Couldn't load existing saved listings: ${e}`);
    }
  }

  function buildFilters(): EbaySearchFilters {
    const minCents = parseDollarsToCents(priceMin);
    const maxCents = parseDollarsToCents(priceMax);
    return {
      conditions,
      buying_options: buyingOptions,
      sellers: [],
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

  async function onWatch(item: EbaySearchItem) {
    setBusyItemId(item.item_id);
    setActionMessage(null);
    setError(null);
    try {
      const result = await api.watchEbayListing(
        item.legacy_item_id ?? item.web_url,
      );
      if (result.filtered_reason) {
        // The eBay-side AddToWatchList already succeeded by this point —
        // tell the user so the UI state isn't confusing.
        setError(
          `Added to eBay watchlist, but local save was filtered: ${result.filtered_reason}. To track locally too, turn off the diecast filter in Settings and try again.`,
        );
      } else if (result.listing_id !== null) {
        setWatchedByItemId((prev) => {
          const next = new Map(prev);
          next.set(item.item_id, result.listing_id!);
          return next;
        });
        setActionMessage(
          `${result.created ? "Watched" : "Updated"}: ${result.title}`,
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyItemId(null);
    }
  }

  async function onUnwatch(item: EbaySearchItem) {
    const listingId = watchedByItemId.get(item.item_id);
    if (listingId === undefined) return;
    setBusyItemId(item.item_id);
    setActionMessage(null);
    setError(null);
    try {
      await api.unwatchEbayListing(listingId);
      setWatchedByItemId((prev) => {
        const next = new Map(prev);
        next.delete(item.item_id);
        return next;
      });
      setActionMessage(`Removed from watchlist: ${item.title}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyItemId(null);
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
        <p className="text-sm text-fg-subtle">
          Search the diecast catalog on eBay. Watch a listing to add it to
          your eBay watchlist and track it locally.
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
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={onSaveCurrentSearch}
            disabled={savingSearch}
            title="Save the current query + filters to Saved Searches"
          >
            {savingSearch ? "Saving…" : "Save search"}
          </button>
        </div>
        {savedSearchMsg && (
          <div className="text-xs text-emerald-400">
            {savedSearchMsg}{" "}
            <Link to="/ebay/searches" className="underline">
              Manage saved searches
            </Link>
          </div>
        )}

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
      {actionMessage && (
        <div className="text-xs text-emerald-400">{actionMessage}</div>
      )}

      {page && (
        <div className="flex items-center justify-between text-xs text-fg-subtle">
          <div>
            {page.total > 0
              ? `Showing ${showingFrom}–${showingTo} of ${page.total.toLocaleString()} results`
              : "No results."}
          </div>
          <div className="flex items-center gap-2">
            <ImageSizeToggle size={imgSize} onChange={setImgSize} />
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
        <div className="card text-sm text-fg-muted">
          Type a query and hit Search to see eBay diecast listings.
        </div>
      ) : page.items.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          No results for the current search.
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {page.items.map((item) => {
            const username = item.seller_username ?? "";
            const sellerSaved =
              username !== "" &&
              savedSellersSet.has(username.toLowerCase());
            return (
              <SearchCard
                key={item.item_id}
                item={item}
                busy={busyItemId === item.item_id}
                watched={watchedByItemId.has(item.item_id)}
                sellerSaved={sellerSaved}
                sellerSaving={
                  username !== "" && savingSeller === username
                }
                onWatch={() => onWatch(item)}
                onUnwatch={() => onUnwatch(item)}
                onSaveSeller={
                  username !== "" && !sellerSaved
                    ? () => onSaveSeller(username)
                    : undefined
                }
                imgSizeClass={IMG_CLASS[imgSize]}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SearchCard({
  item,
  busy,
  watched,
  sellerSaved,
  sellerSaving,
  onWatch,
  onUnwatch,
  onSaveSeller,
  imgSizeClass,
}: {
  item: EbaySearchItem;
  busy: boolean;
  watched: boolean;
  sellerSaved: boolean;
  sellerSaving: boolean;
  onWatch: () => void;
  onUnwatch: () => void;
  onSaveSeller?: () => void;
  imgSizeClass: string;
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
            className={`${imgSizeClass} object-cover rounded border border-border shrink-0`}
          />
        ) : (
          <div className={`${imgSizeClass} rounded border border-border bg-bg-elevated shrink-0`} />
        )}
        <div className="min-w-0 flex-1">
          <div
            className="text-sm font-medium line-clamp-2"
            title={item.title}
          >
            {item.title}
          </div>
          <div className="text-xs text-fg-subtle mt-1 truncate">
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
            <div className="text-xs text-fg-subtle mt-0.5">
              ends {new Date(item.end_time * 1000).toLocaleString()}
            </div>
          )}
        </div>
        <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
          <div className="text-base text-fg">
            {formatCents(item.price_cents)}
          </div>
          {item.shipping_cents !== null && item.shipping_cents > 0 && (
            <div className="text-fg-subtle">
              + {formatCents(item.shipping_cents)} ship
            </div>
          )}
          {total !== null &&
            item.shipping_cents !== null &&
            item.shipping_cents > 0 && (
              <div className="text-fg-muted">total {formatCents(total)}</div>
            )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 text-xs">
        {onSaveSeller && (
          <button
            type="button"
            className="text-fg-subtle hover:text-fg disabled:opacity-50"
            onClick={onSaveSeller}
            disabled={sellerSaving}
            title={`Save ${item.seller_username} to Saved Sellers`}
          >
            {sellerSaving ? "Saving…" : "Save seller"}
          </button>
        )}
        {sellerSaved && !onSaveSeller && (
          <span className="text-fg-faint" title="Seller already saved">
            ✓ Seller saved
          </span>
        )}
        <a
          className="text-accent hover:underline"
          href={item.web_url}
          target="_blank"
          rel="noreferrer"
        >
          View on eBay →
        </a>
        {watched ? (
          <button
            type="button"
            className="text-fg-muted hover:text-red-300 disabled:opacity-50"
            onClick={onUnwatch}
            disabled={busy}
            title="Remove from your eBay watchlist and stop tracking locally"
          >
            {busy ? "Unwatching…" : "✓ Watching · Unwatch"}
          </button>
        ) : (
          <button
            type="button"
            className="text-fg-muted hover:text-fg disabled:opacity-50"
            onClick={onWatch}
            disabled={busy}
            title="Add to your eBay watchlist and track locally"
          >
            {busy ? "Watching…" : "Watch"}
          </button>
        )}
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
                  : "border-border text-fg-muted hover:text-fg"
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
