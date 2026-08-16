import { Fragment, FormEvent, useEffect, useState } from "react";
import { ViewLink } from "@/components/ViewLink";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  api,
  formatCents,
  formatCount,
  formatDateTime,
  formatUntil,
  type EbaySearchFilters,
  type EbaySearchItem,
  type EbaySearchPage,
  type FeedItemDetail,
  type HiddenFeedListing,
  type SavedSeller,
  type SavedSellerInput,
  type SavedSyncSummary,
} from "@/lib/tauri";
import { useImageSize, IMG_CLASS, GALLERY_GRID_CLASS } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";
import { useViewMode } from "@/lib/viewMode";
import { ViewModeToggle } from "@/components/ViewModeToggle";
import { useMinimized, MinimizeToggle } from "@/lib/minimized";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NoticeBanner } from "@/components/NoticeBanner";
import { Modal } from "@/components/Modal";
import { ClearFiltersButton, FilteredEmpty } from "@/components/FilterCard";
import { Thumbnail } from "@/components/Thumbnail";

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
  /** Authored partial-success text — the action worked, something was
   *  skipped. Its own state so it is never confused with a backend
   *  failure, which is what `error` carries. */
  const [notice, setNotice] = useState<string | null>(null);
  const [imgSize, setImgSize] = useImageSize("sellerFeed");
  const [viewMode, setViewMode] = useViewMode("sellerFeed");

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

  // Plain dialog state (DCH-16): the old inline panel persisted its expanded
  // state to localStorage, but a modal that re-opens itself on page load
  // would be a trap, so the persistence went with the panel.
  const [manageOpen, setManageOpen] = useState(false);
  const [editing, setEditing] = useState<SavedSeller | "new" | null>(null);

  /** "Not interested" dismissals (DCH-51), applied as a client-side
   *  exclusion after every fetch — the feed is a live Browse search, so
   *  the ids have to be subtracted from each page or dismissed listings
   *  reappear on the next refresh. */
  const [hidden, setHidden] = useState<HiddenFeedListing[]>([]);
  const [hiddenOpen, setHiddenOpen] = useState(false);

  /** Per-item detail (DCH-52), cached for the session so a card expanded
   *  twice never costs a second Browse call. Errors are per-card so one
   *  failed fetch (RateLimited, offline) leaves the rest of the feed
   *  usable, and are cleared on the next attempt so re-expanding retries. */
  const [details, setDetails] = useState<Map<string, FeedItemDetail>>(
    new Map(),
  );
  const [detailErrors, setDetailErrors] = useState<Map<string, string>>(
    new Map(),
  );
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set());

  async function loadDetail(item: EbaySearchItem) {
    if (details.has(item.item_id)) return;
    setDetailErrors((prev) => {
      const next = new Map(prev);
      next.delete(item.item_id);
      return next;
    });
    setDetailLoading((prev) => new Set(prev).add(item.item_id));
    try {
      const d = await api.feedItemDetail(item.item_id);
      setDetails((prev) => new Map(prev).set(item.item_id, d));
    } catch (e) {
      setDetailErrors((prev) => new Map(prev).set(item.item_id, String(e)));
    } finally {
      setDetailLoading((prev) => {
        const next = new Set(prev);
        next.delete(item.item_id);
        return next;
      });
    }
  }

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
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    void loadWatched();
    void loadHidden();
  }

  async function loadHidden() {
    try {
      setHidden(await api.listHiddenFeedListings());
    } catch {
      // Non-fatal: dismissed listings temporarily reappear, nothing worse.
    }
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

  /** True when anything is narrowing the feed. `sort` is deliberately not
   *  counted — an ordering isn't a filter, and treating it as one would
   *  leave the clear control permanently visible. */
  const filtersActive =
    activeQuery !== "" ||
    query !== "" ||
    conditions.length > 0 ||
    buyingOptions.length > 0 ||
    priceMin !== "" ||
    priceMax !== "" ||
    sellerSubset.size > 0;

  async function onResetFilters() {
    setQuery("");
    setActiveQuery("");
    setConditions([]);
    setBuyingOptions([]);
    setPriceMin("");
    setPriceMax("");
    setSellerSubset(new Set());
    setSort("newlyListed");
    // The feed is a live eBay query, so clearing the inputs isn't enough:
    // without this the user sees cleared filters above stale, still-filtered
    // results. Defaults are passed explicitly because the state setters
    // above haven't been applied yet at this point.
    setLoading(true);
    setError(null);
    try {
      const p = await api.savedSellersFeed(
        "",
        {
          conditions: [],
          buying_options: [],
          sellers: [],
          price_min_cents: null,
          price_max_cents: null,
          sort: "newlyListed",
        },
        PAGE_SIZE,
        0,
      );
      setPage(p);
      setOffset(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onWatch(item: EbaySearchItem) {
    setBusyItemId(item.item_id);
    setActionMessage(null);
    setNotice(null);
    setError(null);
    try {
      const result = await api.watchEbayListing(
        item.legacy_item_id ?? item.web_url,
      );
      if (result.filtered_reason) {
        // Partial success, not failure: the eBay-side AddToWatchList already
        // went through. Routing it to `error` put it in a red box titled
        // "Something went wrong." with the truth collapsed underneath.
        setNotice(
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
    setNotice(null);
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

  /** Optimistic (DCH-51): the card vanishes on click, and the row is put
   *  back if the write fails. No confirmation — dismissing is one click to
   *  undo from the hidden-listings dialog, which is exactly the reversible
   *  case the DCH-33 conventions exempt from `window.confirm`. */
  async function onDismiss(item: EbaySearchItem) {
    setError(null);
    const prev = hidden;
    setHidden((h) => [
      {
        item_id: item.item_id,
        title: item.title,
        seller_username: item.seller_username,
        hidden_at: Math.floor(Date.now() / 1000),
      },
      ...h.filter((x) => x.item_id !== item.item_id),
    ]);
    try {
      const saved = await api.hideFeedListing(
        item.item_id,
        item.title,
        item.seller_username,
      );
      setHidden((h) => h.map((x) => (x.item_id === saved.item_id ? saved : x)));
    } catch (e) {
      setHidden(prev);
      setError(String(e));
    }
  }

  async function onUnhide(itemId: string) {
    setError(null);
    try {
      await api.unhideFeedListing(itemId);
      setHidden((h) => h.filter((x) => x.item_id !== itemId));
    } catch (e) {
      setError(String(e));
    }
  }

  /** Called by the manage dialog after a successful remove — the deleted
   *  seller may be narrowing the feed, so it comes out of the subset too. */
  async function onSellerRemoved(s: SavedSeller) {
    setSellerSubset((prev) => {
      const next = new Set(prev);
      next.delete(s.username.toLowerCase());
      return next;
    });
    await reloadSellers();
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

  const showingFrom = page && page.items.length > 0 ? offset + 1 : 0;
  const showingTo = page ? offset + page.items.length : 0;

  const hiddenIds = new Set(hidden.map((h) => h.item_id));
  const visibleItems = page
    ? page.items.filter((i) => !hiddenIds.has(i.item_id))
    : [];

  return (
    <div className="p-6 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Seller feed</h2>
          <p className="text-sm text-fg-subtle">
            Recent diecast listings across your saved sellers.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setManageOpen(true)}
          >
            Manage Saved Sellers…
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => loadFeed(offset)}
            disabled={loading}
            title="Refresh the current page"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {/* Same shape as Browse's filter card (DCH-35): search row with the
          submit and the conditional Clear control, then one grid of labeled
          filters. Search submits query + filters together, so the old
          duplicate "Apply filters" button and the summary footer are gone. */}
      <form onSubmit={onApplyFilters} className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input flex-1 min-w-[12rem]"
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
          {filtersActive && (
            <ClearFiltersButton
              onClear={() => void onResetFilters()}
              className="shrink-0"
            />
          )}
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
        </div>
        {/* Sellers get a full-width row: the chip list grows with every
            saved seller, and boxing it into one grid cell was most of what
            made the old panel feel cramped. */}
        <div>
          <label className="label">Sellers</label>
          {sellers === null || sellers.length === 0 ? (
            <div className="text-xs text-fg-subtle">No saved sellers yet.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
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
            Empty = all saved sellers. Filters apply on Search.
          </p>
        </div>
      </form>

      {error && <ErrorBanner error={error} />}
      <NoticeBanner message={notice} tone="warning" />
      {actionMessage && (
        <NoticeBanner message={actionMessage} variant="inline" />
      )}

      {sellers !== null && sellers.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          No saved sellers yet — add a few via{" "}
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => setManageOpen(true)}
          >
            Manage Saved Sellers
          </button>
          , or save them from a listing on the{" "}
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
        // Two different messages (DCH-35): filters excluding everything
        // offers the way out; an unfiltered feed with nothing in it doesn't.
        filtersActive ? (
          <FilteredEmpty
            onClear={() => void onResetFilters()}
            noun="listings"
          />
        ) : (
          <div className="card text-sm text-fg-muted">
            No recent listings from your saved sellers.
          </div>
        )
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-fg-subtle">
            <div>
              Showing {showingFrom}–{showingTo} of {formatCount(page.total)}{" "}
              results
              {hidden.length > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline hover:text-fg"
                    onClick={() => setHiddenOpen(true)}
                    title="Review listings you marked not interested"
                  >
                    {formatCount(hidden.length)} hidden
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <ViewModeToggle mode={viewMode} onChange={setViewMode} />
              <ImageSizeToggle size={imgSize} onChange={setImgSize} />
              <Pager
                offset={offset}
                hasMore={page.has_more}
                loading={loading}
                onPage={loadFeed}
              />
            </div>
          </div>

          {/* List view is Saved Listings' arrangement (DCH-50): the same
              rows at full width instead of packed into grid columns. The
              cards themselves don't change, so switching never re-fetches,
              and the image-size toggle keeps working in both — Saved
              Listings' rows honor it too. */}
          {visibleItems.length === 0 ? (
            // Every listing on this page was dismissed — a distinct state
            // from an empty page, and the one place the review affordance
            // is the whole message.
            <div className="card text-sm text-fg-muted flex items-center justify-between gap-4">
              <span>
                All {formatCount(page.items.length)} listings on this page are
                hidden.
              </span>
              <button
                type="button"
                className="text-xs text-fg-subtle hover:text-fg underline-offset-2 hover:underline shrink-0"
                onClick={() => setHiddenOpen(true)}
              >
                Review hidden listings
              </button>
            </div>
          ) : (
            <ul
              className={
                viewMode === "list" ? "space-y-2" : GALLERY_GRID_CLASS[imgSize]
              }
            >
              {visibleItems.map((item) => (
                <FeedCard
                  key={item.item_id}
                  item={item}
                  busy={busyItemId === item.item_id}
                  watched={watchedByItemId.has(item.item_id)}
                  onWatch={() => onWatch(item)}
                  onUnwatch={() => onUnwatch(item)}
                  onDismiss={() => onDismiss(item)}
                  detail={details.get(item.item_id)}
                  detailLoading={detailLoading.has(item.item_id)}
                  detailError={detailErrors.get(item.item_id)}
                  onLoadDetail={() => void loadDetail(item)}
                  imgSizeClass={IMG_CLASS[imgSize]}
                />
              ))}
            </ul>
          )}

          {/* Repeated below the grid (DCH-16): a page of large cards used to
              end with nowhere to go but back up to the toolbar. */}
          <div className="flex items-center justify-between text-xs text-fg-subtle">
            <div>
              Showing {showingFrom}–{showingTo} of {formatCount(page.total)}{" "}
              results
            </div>
            <Pager
              offset={offset}
              hasMore={page.has_more}
              loading={loading}
              onPage={loadFeed}
            />
          </div>
        </>
      )}

      {hiddenOpen && (
        <HiddenListingsDialog
          hidden={hidden}
          onClose={() => setHiddenOpen(false)}
          onUnhide={onUnhide}
        />
      )}

      {manageOpen && (
        <ManageSellersDialog
          sellers={sellers}
          onClose={() => setManageOpen(false)}
          onChanged={reloadSellers}
          onRemoved={onSellerRemoved}
          onAdd={() => setEditing("new")}
          onEdit={setEditing}
        />
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

function Pager({
  offset,
  hasMore,
  loading,
  onPage,
}: {
  offset: number;
  hasMore: boolean;
  loading: boolean;
  onPage: (nextOffset: number) => Promise<void>;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn-secondary"
        onClick={() => void onPage(Math.max(0, offset - PAGE_SIZE))}
        disabled={offset === 0 || loading}
      >
        ← Previous
      </button>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => void onPage(offset + PAGE_SIZE)}
        disabled={!hasMore || loading}
      >
        Next →
      </button>
    </div>
  );
}

/** Review and un-hide "not interested" dismissals (DCH-51). Un-hide is a
 *  plain restore action, not a destructive one, so it wears the same muted
 *  text style as Edit rather than a danger class. */
function HiddenListingsDialog({
  hidden,
  onClose,
  onUnhide,
}: {
  hidden: HiddenFeedListing[];
  onClose: () => void;
  onUnhide: (itemId: string) => Promise<void>;
}) {
  return (
    <Modal
      title="Hidden listings"
      description="Listings you marked not interested. Un-hiding puts one back in the feed on its next appearance."
      onClose={onClose}
      size="max-w-2xl"
      scroll="none"
      panelClassName="max-h-[85vh] flex flex-col"
      footer={
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      {hidden.length === 0 ? (
        <div className="text-xs text-fg-muted">Nothing hidden.</div>
      ) : (
        <ul className="space-y-2 overflow-y-auto min-h-0">
          {hidden.map((h) => (
            <li
              key={h.item_id}
              className="flex items-start gap-3 border border-border rounded px-3 py-2"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {h.title ?? h.item_id}
                </div>
                <div className="text-xs text-fg-subtle mt-0.5">
                  {[
                    h.seller_username && `seller: ${h.seller_username}`,
                    `hidden ${formatDateTime(h.hidden_at)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <button
                type="button"
                className="text-xs text-fg-muted hover:text-fg shrink-0"
                onClick={() => void onUnhide(h.item_id)}
              >
                Un-hide
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Seller management as a dialog (DCH-16), mirroring Manage Groups on Saved
 *  Listings: the shared `Modal`, action buttons in the footer, its own
 *  inline error so a failed sync or remove surfaces where the user is
 *  looking. Add/Edit open `SellerEditor` on top — same stacked-dialog
 *  arrangement as GroupEditorDialog over ManageGroupsDialog. */
function ManageSellersDialog({
  sellers,
  onClose,
  onChanged,
  onRemoved,
  onAdd,
  onEdit,
}: {
  sellers: SavedSeller[] | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onRemoved: (s: SavedSeller) => Promise<void>;
  onAdd: () => void;
  onEdit: (s: SavedSeller) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSync() {
    setSyncing(true);
    setSyncMessage(null);
    setError(null);
    try {
      const summary: SavedSyncSummary = await api.syncEbaySaved();
      setSyncMessage(
        `Sellers: +${summary.sellers_created} new, ~${summary.sellers_updated} updated, -${summary.sellers_pruned} pruned (of ${summary.sellers_seen}).`,
      );
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function onDelete(s: SavedSeller) {
    if (!window.confirm(`Remove saved seller "${s.username}"?`)) return;
    setError(null);
    try {
      await api.removeSavedSeller(s.id);
      await onRemoved(s);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Modal
      title="Manage Saved Sellers"
      description="Bookmark eBay sellers you trust — their recent listings show up in the feed."
      onClose={onClose}
      size="max-w-2xl"
      scroll="none"
      panelClassName="max-h-[85vh] flex flex-col"
      busy={syncing}
      footer={
        <>
          <div className="flex-1 flex items-center gap-2">
            <button
              className="btn-secondary"
              type="button"
              onClick={() => void onSync()}
              disabled={syncing}
              title="Pull your eBay favorite sellers and prune ones removed there"
            >
              {syncing ? "Syncing…" : "Sync from eBay"}
            </button>
            <button
              className="btn-primary"
              type="button"
              onClick={onAdd}
              disabled={syncing}
            >
              Add seller
            </button>
          </div>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} variant="inline" className="mb-2" />}
      {syncMessage && (
        <div className="text-xs text-emerald-400 mb-2">{syncMessage}</div>
      )}
      {sellers === null ? (
        <div className="text-xs text-fg-subtle">Loading…</div>
      ) : sellers.length === 0 ? (
        <div className="text-xs text-fg-muted">
          No saved sellers yet — add one, or sync your eBay favorites.
        </div>
      ) : (
        <ul className="space-y-2 overflow-y-auto min-h-0">
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
                        <span className="text-fg-subtle">({s.username})</span>
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
                    className="link-danger"
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
    </Modal>
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
  onDismiss,
  detail,
  detailLoading,
  detailError,
  onLoadDetail,
  imgSizeClass,
}: {
  item: EbaySearchItem;
  busy: boolean;
  watched: boolean;
  onWatch: () => void;
  onUnwatch: () => void;
  onDismiss: () => void;
  detail: FeedItemDetail | undefined;
  detailLoading: boolean;
  detailError: string | undefined;
  onLoadDetail: () => void;
  imgSizeClass: string;
}) {
  const total =
    item.price_cents !== null
      ? item.price_cents + (item.shipping_cents ?? 0)
      : null;
  const [minimized, toggleMinimized] = useMinimized(
    `ebay-item:${item.item_id}`,
  );
  const [expanded, setExpanded] = useState(false);
  const [imgIndex, setImgIndex] = useState(0);

  // The search response carries one image; the full set arrives with the
  // detail (DCH-52). Until then — and for single-image listings — there is
  // nothing to cycle, so no carousel controls render.
  const images =
    expanded && detail && detail.image_urls.length > 0
      ? detail.image_urls
      : item.image_url
        ? [item.image_url]
        : [];
  const shownImage =
    images.length > 0 ? images[imgIndex % images.length] : null;

  function onToggleDetails() {
    const opening = !expanded;
    setExpanded(opening);
    // Cached details make this a no-op; a previous error retries.
    if (opening) onLoadDetail();
  }

  return (
    <li className={`card flex flex-col gap-2 ${minimized ? "!py-2" : ""}`}>
      <div className="flex gap-3">
        <MinimizeToggle
          minimized={minimized}
          onToggle={toggleMinimized}
          className="self-start -mt-0.5"
        />
        {!minimized && (
          <div className="shrink-0 space-y-1">
            <Thumbnail src={shownImage} className={imgSizeClass} />
            {expanded && images.length > 1 && (
              <div className="flex items-center justify-center gap-2 text-xs text-fg-subtle tabular-nums">
                <button
                  type="button"
                  className="px-1.5 hover:text-fg"
                  aria-label="Previous image"
                  onClick={() =>
                    setImgIndex((i) => (i - 1 + images.length) % images.length)
                  }
                >
                  ‹
                </button>
                {(imgIndex % images.length) + 1} / {images.length}
                <button
                  type="button"
                  className="px-1.5 hover:text-fg"
                  aria-label="Next image"
                  onClick={() => setImgIndex((i) => (i + 1) % images.length)}
                >
                  ›
                </button>
              </div>
            )}
          </div>
        )}
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
                  ends {formatUntil(item.end_time)}
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
        {/* Upper right of the card, far right of a list row (DCH-51).
            `link-danger` so it reads as destructive at rest; no confirm —
            un-hiding is one click in the hidden-listings dialog. */}
        <button
          type="button"
          className="link-danger self-start -mt-0.5 shrink-0 leading-none"
          aria-label={`Not interested: ${item.title}`}
          title="Not interested — hide from the feed"
          onClick={onDismiss}
        >
          ✕
        </button>
      </div>
      {!minimized && (
        <div className="flex items-center justify-end gap-3 text-xs">
          <button
            type="button"
            className="text-fg-muted hover:text-fg"
            onClick={onToggleDetails}
            aria-expanded={expanded}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
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
              className="link-danger"
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
      {!minimized && expanded && (
        <div className="border-t border-border pt-2 space-y-2 text-xs">
          {detailError ? (
            <ErrorBanner error={detailError} variant="inline" />
          ) : detailLoading || !detail ? (
            <div className="text-fg-subtle">Loading details…</div>
          ) : (
            <>
              <div>
                <div className="label">Item specifics</div>
                {detail.aspects.length === 0 ? (
                  <span className="text-fg-subtle">—</span>
                ) : (
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    {detail.aspects.map((a) => (
                      <Fragment key={`${a.name}:${a.value}`}>
                        <div className="text-fg-subtle">{a.name}</div>
                        <div className="min-w-0 break-words">{a.value}</div>
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="label">Description</div>
                {detail.description ? (
                  <div className="whitespace-pre-wrap text-fg-muted max-h-40 overflow-y-auto">
                    {detail.description}
                  </div>
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </div>
            </>
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

function parseDollarsToCents(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const f = Number(trimmed);
  if (!Number.isFinite(f) || f < 0) return null;
  return Math.round(f * 100);
}
