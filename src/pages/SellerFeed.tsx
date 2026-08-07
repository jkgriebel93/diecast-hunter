import { FormEvent, useEffect, useMemo, useState } from "react";
import { ViewLink } from "@/components/ViewLink";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  api,
  formatCents,
  formatCount,
  formatDateTime,
  type EbaySearchFilters,
  type EbaySearchItem,
  type EbaySearchPage,
  type SavedSeller,
  type SavedSellerInput,
  type SavedSyncSummary,
} from "@/lib/tauri";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";
import { useMinimized, MinimizeToggle } from "@/lib/minimized";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Modal } from "@/components/Modal";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

const PAGE_SIZE = 50;

const SORT_OPTIONS = [
  { value: "newlyListed", label: "Newly listed" },
  { value: "endingSoonest", label: "Ending soonest" },
  { value: "price", label: "Price low → high" },
  { value: "-price", label: "Price high → low" },
  { value: "", label: "Best match" },
];

const CONDITION_OPTIONS = [
  { value: "NEW", label: "New" },
  { value: "USED", label: "Used" },
  { value: "UNSPECIFIED", label: "Unspecified" },
];

const BUYING_OPTIONS = [
  { value: "FIXED_PRICE", label: "Buy It Now" },
  { value: "AUCTION", label: "Auction" },
];

const MANAGE_STORAGE_KEY = "sellerFeed.manageOpen";

export function SellerFeed() {
  const [sellers, setSellers] = useState<SavedSeller[] | null>(null);
  const [page, setPage] = useState<EbaySearchPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [watchedByItemId, setWatchedByItemId] = useState<Map<string, number>>(
    new Map(),
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [imgSize, setImgSize] = useImageSize("sellerFeed");

  const [query, setQuery] = useState("");
  /** Snapshot of `query` at the time of the last submit. Used for paging so
   *  editing the input doesn't shift the current results until Apply is hit. */
  const [activeQuery, setActiveQuery] = useState("");
  const [sort, setSort] = useState<string>("newlyListed");
  const [conditions, setConditions] = useState<string[]>([]);
  const [buyingOptions, setBuyingOptions] = useState<string[]>([]);
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  /** Lowercased usernames the user has narrowed the feed to. Empty = all
   *  saved sellers. */
  const [sellerSubset, setSellerSubset] = useState<Set<string>>(new Set());

  const [manageOpen, setManageOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(MANAGE_STORAGE_KEY) === "1";
  });
  const [editing, setEditing] = useState<SavedSeller | "new" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(MANAGE_STORAGE_KEY, manageOpen ? "1" : "0");
  }, [manageOpen]);

  useEffect(() => {
    void initialLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildFilters(): EbaySearchFilters {
    return {
      conditions,
      buying_options: buyingOptions,
      sellers: Array.from(sellerSubset),
      price_min_cents: parseDollarsToCents(priceMin),
      price_max_cents: parseDollarsToCents(priceMax),
      sort: sort || null,
    };
  }

  async function initialLoad() {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([
        api.listSavedSellers(),
        api.savedSellersFeed("", buildFilters(), PAGE_SIZE, 0),
      ]);
      setSellers(s);
      setPage(p);
      setOffset(0);
      // Expand the management panel by default when there are no sellers yet.
      if (s.length === 0) setManageOpen(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    void loadWatched();
  }

  async function loadFeed(nextOffset: number, q = activeQuery) {
    setLoading(true);
    setError(null);
    try {
      const p = await api.savedSellersFeed(
        q,
        buildFilters(),
        PAGE_SIZE,
        nextOffset,
      );
      setPage(p);
      setOffset(nextOffset);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function reloadSellers() {
    try {
      setSellers(await api.listSavedSellers());
    } catch (e) {
      setError(String(e));
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
    } catch {
      // non-fatal
    }
  }

  async function onApplyFilters(e?: FormEvent) {
    if (e) e.preventDefault();
    const q = query.trim();
    setActiveQuery(q);
    await loadFeed(0, q);
  }

  function onResetFilters() {
    setQuery("");
    setActiveQuery("");
    setConditions([]);
    setBuyingOptions([]);
    setPriceMin("");
    setPriceMax("");
    setSellerSubset(new Set());
    setSort("newlyListed");
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
        setError(
          `Added to eBay watchlist, but local save was filtered: ${result.filtered_reason}.`,
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

  async function onSyncSellers() {
    setSyncing(true);
    setSyncMessage(null);
    setError(null);
    try {
      const summary: SavedSyncSummary = await api.syncEbaySaved();
      setSyncMessage(
        `Sellers: +${summary.sellers_created} new, ~${summary.sellers_updated} updated, -${summary.sellers_pruned} pruned (of ${summary.sellers_seen}).`,
      );
      await reloadSellers();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function onDeleteSeller(s: SavedSeller) {
    if (!window.confirm(`Remove saved seller "${s.username}"?`)) return;
    setError(null);
    try {
      await api.removeSavedSeller(s.id);
      // Drop from filter subset if it was there.
      setSellerSubset((prev) => {
        const next = new Set(prev);
        next.delete(s.username.toLowerCase());
        return next;
      });
      await reloadSellers();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onSubmitSeller(
    input: SavedSellerInput,
    existing: SavedSeller | null,
  ) {
    setError(null);
    try {
      if (existing) {
        await api.updateSavedSeller(existing.id, input);
      } else {
        await api.addSavedSeller(input);
      }
      setEditing(null);
      await reloadSellers();
    } catch (e) {
      setError(String(e));
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

  function toggleSubsetUsername(username: string) {
    const key = username.toLowerCase();
    setSellerSubset((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (activeQuery) parts.push(`"${activeQuery}"`);
    if (conditions.length) parts.push(`cond: ${conditions.join(", ")}`);
    if (buyingOptions.length) parts.push(`format: ${buyingOptions.join(", ")}`);
    if (priceMin || priceMax)
      parts.push(`price: ${priceMin || "—"} – ${priceMax || "—"}`);
    if (sellerSubset.size > 0)
      parts.push(`sellers: ${sellerSubset.size} of ${sellers?.length ?? "—"}`);
    if (sort) parts.push(`sort: ${sort}`);
    return parts.length ? parts.join(" · ") : "no filters";
  }, [
    activeQuery,
    conditions,
    buyingOptions,
    priceMin,
    priceMax,
    sellerSubset,
    sort,
    sellers,
  ]);

  const showingFrom = page && page.items.length > 0 ? offset + 1 : 0;
  const showingTo = page ? offset + page.items.length : 0;

  return (
    <div className="p-6 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Seller feed</h2>
          <p className="text-sm text-fg-subtle">
            Recent diecast listings across your saved sellers.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => loadFeed(offset)}
          disabled={loading}
          title="Refresh the current page"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <form onSubmit={onApplyFilters} className="card space-y-3">
        <div className="flex items-center gap-2">
          <input
            className="input flex-1"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Keyword search across your saved sellers — e.g. ‘Jeff Gordon 1:24’"
            autoComplete="off"
          />
          <button
            className="btn-primary shrink-0"
            type="submit"
            disabled={loading}
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
          <FilterChips
            label="Condition"
            values={conditions}
            options={CONDITION_OPTIONS}
            onToggle={(v) => toggleArrayValue(conditions, setConditions, v)}
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
          <div>
            <label className="label">Sellers</label>
            {sellers === null || sellers.length === 0 ? (
              <div className="text-xs text-fg-subtle">
                No saved sellers yet.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
                {sellers.map((s) => {
                  const key = s.username.toLowerCase();
                  const active = sellerSubset.has(key);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`px-2 py-1 rounded border text-xs ${
                        active
                          ? "border-accent text-accent bg-accent/10"
                          : "border-border text-fg-muted hover:text-fg"
                      }`}
                      onClick={() => toggleSubsetUsername(s.username)}
                      title={
                        active
                          ? `Showing ${s.username}`
                          : `Add ${s.username} to subset`
                      }
                    >
                      {s.username}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-fg-faint mt-1">
              Empty = all saved sellers.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs text-fg-subtle">
          <span>{filterSummary}</span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={onResetFilters}
            >
              Reset
            </button>
            <button
              type="submit"
              className="btn-primary text-xs"
              disabled={loading}
            >
              Apply filters
            </button>
          </div>
        </div>
      </form>

      <ManageSellersPanel
        open={manageOpen}
        onToggle={() => setManageOpen((o) => !o)}
        sellers={sellers}
        syncing={syncing}
        syncMessage={syncMessage}
        onSync={onSyncSellers}
        onAdd={() => setEditing("new")}
        onEdit={setEditing}
        onDelete={onDeleteSeller}
      />

      {error && <ErrorBanner error={error} />}
      {actionMessage && (
        <div className="text-xs text-emerald-400">{actionMessage}</div>
      )}

      {sellers !== null && sellers.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          No saved sellers yet — add a few in the management panel above, or
          save them from a listing on the{" "}
          <ViewLink to="/browse" className="text-accent hover:underline">
            Browse eBay
          </ViewLink>{" "}
          page.
        </div>
      ) : page === null ? (
        // A failed load leaves `page` null forever; the error banner above
        // is the state, not "still loading".
        error ? null : (
          <div className="card text-sm text-fg-muted">Loading…</div>
        )
      ) : page.items.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          No recent listings match the current filters.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-fg-subtle">
            <div>
              Showing {showingFrom}–{showingTo} of {formatCount(page.total)}{" "}
              results
            </div>
            <div className="flex items-center gap-2">
              <ImageSizeToggle size={imgSize} onChange={setImgSize} />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => loadFeed(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                ← Previous
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => loadFeed(offset + PAGE_SIZE)}
                disabled={!page.has_more || loading}
              >
                Next →
              </button>
            </div>
          </div>

          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
            {page.items.map((item) => (
              <FeedCard
                key={item.item_id}
                item={item}
                busy={busyItemId === item.item_id}
                watched={watchedByItemId.has(item.item_id)}
                onWatch={() => onWatch(item)}
                onUnwatch={() => onUnwatch(item)}
                imgSizeClass={IMG_CLASS[imgSize]}
              />
            ))}
          </ul>
        </>
      )}

      {editing && (
        <SellerEditor
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSubmit={onSubmitSeller}
        />
      )}
    </div>
  );
}

function ManageSellersPanel({
  open,
  onToggle,
  sellers,
  syncing,
  syncMessage,
  onSync,
  onAdd,
  onEdit,
  onDelete,
}: {
  open: boolean;
  onToggle: () => void;
  sellers: SavedSeller[] | null;
  syncing: boolean;
  syncMessage: string | null;
  onSync: () => void;
  onAdd: () => void;
  onEdit: (s: SavedSeller) => void;
  onDelete: (s: SavedSeller) => void;
}) {
  const count = sellers?.length ?? 0;
  return (
    <section className="card !p-0 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-bg-elevated transition-colors"
      >
        <div>
          <h3 className="text-sm font-medium">Manage saved sellers</h3>
          <p className="text-xs text-fg-subtle mt-0.5">
            {sellers === null
              ? "Loading…"
              : count === 0
                ? "Nothing here yet — click to add or sync from eBay."
                : `${count} saved seller${count === 1 ? "" : "s"}`}
          </p>
        </div>
        <Chevron direction={open ? "down" : "right"} />
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-fg-subtle">
              Bookmark eBay sellers you trust — their recent listings show up in
              the feed.
            </div>
            <div className="flex gap-2">
              <button
                className="btn-secondary text-xs"
                type="button"
                onClick={onSync}
                disabled={syncing}
                title="Pull your eBay favorite sellers and prune ones removed there"
              >
                {syncing ? "Syncing…" : "Sync from eBay"}
              </button>
              <button
                className="btn-primary text-xs"
                type="button"
                onClick={onAdd}
              >
                Add seller
              </button>
            </div>
          </div>
          {syncMessage && (
            <div className="text-xs text-emerald-400">{syncMessage}</div>
          )}
          {sellers === null ? null : sellers.length === 0 ? (
            <div className="text-xs text-fg-muted">No saved sellers yet.</div>
          ) : (
            <ul className="space-y-2 max-h-72 overflow-y-auto">
              {sellers.map((s) => (
                <li
                  key={s.id}
                  className="flex items-start gap-3 border border-border rounded px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium flex items-center gap-2">
                      <span className="truncate">
                        {s.display_name ? (
                          <>
                            {s.display_name}{" "}
                            <span className="text-fg-subtle">
                              ({s.username})
                            </span>
                          </>
                        ) : (
                          s.username
                        )}
                      </span>
                      {s.ebay_origin && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded border border-border text-fg-subtle"
                          title="Synced from eBay favorites. Removed there → pruned here on next sync."
                        >
                          from eBay
                        </span>
                      )}
                    </div>
                    {s.notes && (
                      <div className="text-xs text-fg-muted mt-0.5 whitespace-pre-wrap">
                        {s.notes}
                      </div>
                    )}
                    <div className="text-xs text-fg-faint mt-1">
                      Saved {formatDateTime(s.created_at)}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0 text-xs">
                    <a
                      className="text-accent hover:underline"
                      href={`https://www.ebay.com/usr/${encodeURIComponent(s.username)}`}
                      onClick={(e) => {
                        e.preventDefault();
                        void openExternal(
                          `https://www.ebay.com/usr/${encodeURIComponent(s.username)}`,
                        );
                      }}
                    >
                      View on eBay →
                    </a>
                    <div className="flex gap-2">
                      <button
                        className="text-fg-muted hover:text-fg"
                        type="button"
                        onClick={() => onEdit(s)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-fg-subtle hover:text-red-300"
                        type="button"
                        onClick={() => onDelete(s)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
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

function FeedCard({
  item,
  busy,
  watched,
  onWatch,
  onUnwatch,
  imgSizeClass,
}: {
  item: EbaySearchItem;
  busy: boolean;
  watched: boolean;
  onWatch: () => void;
  onUnwatch: () => void;
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
    <li className={`card flex flex-col gap-2 ${minimized ? "!py-2" : ""}`}>
      <div className="flex gap-3">
        <MinimizeToggle
          minimized={minimized}
          onToggle={toggleMinimized}
          className="self-start -mt-0.5"
        />
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
        <div className="min-w-0 flex-1">
          <div
            className={`text-sm font-medium ${minimized ? "truncate" : "line-clamp-2"}`}
            title={item.title}
          >
            {item.title}
          </div>
          {!minimized && (
            <>
              <div className="text-xs text-fg-subtle mt-1 truncate">
                {[
                  item.condition,
                  item.listing_type,
                  item.seller_username && `seller: ${item.seller_username}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {item.end_time && item.listing_type === "auction" && (
                <div className="text-xs text-fg-subtle mt-0.5">
                  ends {formatDateTime(item.end_time)}
                </div>
              )}
            </>
          )}
        </div>
        <div className="text-right text-xs tabular-nums shrink-0">
          <div className="text-base text-fg">
            {formatCents(item.price_cents)}
          </div>
          {!minimized &&
            item.shipping_cents !== null &&
            item.shipping_cents > 0 && (
              <div className="text-fg-subtle">
                + {formatCents(item.shipping_cents)} ship
              </div>
            )}
          {!minimized &&
            total !== null &&
            item.shipping_cents !== null &&
            item.shipping_cents > 0 && (
              <div className="text-fg-muted">total {formatCents(total)}</div>
            )}
        </div>
      </div>
      {!minimized && (
        <div className="flex items-center justify-end gap-3 text-xs">
          <a
            className="text-accent hover:underline"
            href={item.web_url}
            onClick={(e) => {
              e.preventDefault();
              void openExternal(item.web_url);
            }}
          >
            View on eBay →
          </a>
          {watched ? (
            <button
              type="button"
              className="text-fg-muted hover:text-red-300 disabled:opacity-50"
              onClick={onUnwatch}
              disabled={busy}
            >
              {busy ? "Unwatching…" : "✓ Watching · Unwatch"}
            </button>
          ) : (
            <button
              type="button"
              className="text-fg-muted hover:text-fg disabled:opacity-50"
              onClick={onWatch}
              disabled={busy}
            >
              {busy ? "Watching…" : "Watch"}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function SellerEditor({
  existing,
  onClose,
  onSubmit,
}: {
  existing: SavedSeller | null;
  onClose: () => void;
  onSubmit: (input: SavedSellerInput, existing: SavedSeller | null) => void;
}) {
  const [username, setUsername] = useState(existing?.username ?? "");
  const [displayName, setDisplayName] = useState(existing?.display_name ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit(
      {
        seller_code: existing?.seller_code ?? "ebay",
        username: username.trim(),
        display_name: displayName.trim() || null,
        notes: notes.trim() || null,
      },
      existing,
    );
  }

  return (
    <Modal
      title={existing ? "Edit seller" : "Add seller"}
      onClose={onClose}
      onSubmit={handleSubmit}
      size="max-w-md"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            {existing ? "Save changes" : "Add seller"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">eBay username</label>
          <input
            className="input"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            autoComplete="off"
            placeholder="diecast_seller_42"
          />
        </div>
        <div>
          <label className="label">Display name (optional)</label>
          <input
            className="input"
            type="text"
            value={displayName ?? ""}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Friendlier label shown in the UI"
          />
        </div>
        <div>
          <label className="label">Notes (optional)</label>
          <textarea
            className="input min-h-[80px]"
            value={notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. ships fast, specializes in 1:24"
          />
        </div>
      </div>
    </Modal>
  );
}

function Chevron({ direction }: { direction: "right" | "down" }) {
  const rotate = direction === "down" ? 270 : 180;
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-fg-subtle shrink-0"
      style={{
        transform: `rotate(${rotate}deg)`,
        transition: "transform 150ms ease",
      }}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function parseDollarsToCents(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const f = Number(trimmed);
  if (!Number.isFinite(f) || f < 0) return null;
  return Math.round(f * 100);
}
