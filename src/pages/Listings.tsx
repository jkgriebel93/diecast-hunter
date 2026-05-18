import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  api,
  formatCents,
  type FormOptionRow,
  type ListingRow,
  type MatchSummary,
  type ProductionSearchResult,
  type ReceivedOffer,
  type RefreshSummary,
  type WatchlistSyncSummary,
} from "@/lib/tauri";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

type ViewMode = "flat" | "byDriver";
type StatusFilter = "all" | "active" | "ended";
type MatchFilter = "all" | "matched" | "unmatched";
type SourceFilter = "all" | "ebay" | "fb";
type OfferFilter = "all" | "unresponded" | "with" | "without";
type SortMode =
  | "newest"
  | "price-asc"
  | "price-desc"
  | "total-asc"
  | "deal-asc"
  | "ending-soon"
  | "title";

export function Listings() {
  const [rows, setRows] = useState<ListingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** legacy eBay item id → active seller offer, populated lazily on
   *  mount via a parallel fetch. Failures (no eBay OAuth, network, etc.)
   *  are silently ignored — the page works without offer badges. */
  const [offersByItemId, setOffersByItemId] = useState<
    Map<string, ReceivedOffer>
  >(new Map());

  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [registrySearchListing, setRegistrySearchListing] =
    useState<ListingRow | null>(null);
  const [imgSize, setImgSize] = useImageSize("listings");

  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [matchFilter, setMatchFilter] = useState<MatchFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [offerFilter, setOfferFilter] = useState<OfferFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [unwatchingId, setUnwatchingId] = useState<number | null>(null);
  const [bulkRefreshing, setBulkRefreshing] = useState(false);
  const [bulkSummary, setBulkSummary] =
    useState<RefreshSummary | null>(null);

  const [syncingWatchlist, setSyncingWatchlist] = useState(false);
  const [watchlistSummary, setWatchlistSummary] =
    useState<WatchlistSyncSummary | null>(null);

  const [rematching, setRematching] = useState(false);
  const [matchSummary, setMatchSummary] = useState<MatchSummary | null>(null);

  async function load() {
    setError(null);
    try {
      const list = await api.listListings();
      setRows(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    void loadOffers();
  }, []);

  async function loadOffers() {
    try {
      const list = await api.listEbayOffers();
      const nowSec = Math.floor(Date.now() / 1000);
      const map = new Map<string, ReceivedOffer>();
      for (const o of list) {
        if (o.expires_at !== null && o.expires_at < nowSec) continue;
        map.set(o.item_id, o);
      }
      setOffersByItemId(map);
    } catch {
      // Best-effort decoration; no surface for errors here.
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddMessage(null);
    setAddError(null);
    try {
      const result = await api.addEbayListing(input.trim());
      if (result.filtered_reason) {
        setAddError(
          `${result.filtered_reason}. To save anyway, turn off the diecast filter in Settings.`,
        );
      } else {
        setAddMessage(
          `${result.created ? "Added" : "Updated"}: ${result.title}`,
        );
        setInput("");
      }
      await load();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function onRefreshOne(id: number) {
    setRefreshingId(id);
    try {
      await api.refreshEbayListing(id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshingId(null);
    }
  }

  async function onUnwatch(row: ListingRow) {
    const ok = window.confirm(
      `Remove this listing from your eBay watchlist and delete its local row (including price history)?\n\n${row.title}`,
    );
    if (!ok) return;
    setUnwatchingId(row.listing_id);
    setError(null);
    try {
      await api.unwatchEbayListing(row.listing_id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setUnwatchingId(null);
    }
  }

  async function onRefreshAll() {
    setBulkRefreshing(true);
    setBulkSummary(null);
    try {
      const summary = await api.refreshAllEbayListings();
      setBulkSummary(summary);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBulkRefreshing(false);
    }
  }

  async function onSyncWatchlist() {
    setSyncingWatchlist(true);
    setWatchlistSummary(null);
    setError(null);
    try {
      const summary = await api.syncEbayWatchlist();
      setWatchlistSummary(summary);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncingWatchlist(false);
    }
  }

  async function onRematchAll() {
    setRematching(true);
    setMatchSummary(null);
    setError(null);
    try {
      const summary = await api.rematchAllListings();
      setMatchSummary(summary);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRematching(false);
    }
  }

  async function onConfirmMatch(listingId: number) {
    setError(null);
    try {
      await api.confirmListingMatch(listingId);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onClearMatch(listingId: number) {
    setError(null);
    try {
      await api.clearListingMatch(listingId);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRejectMatch(listingId: number) {
    setError(null);
    try {
      await api.rejectListingMatch(listingId);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  const filteredRows = useMemo(() => {
    if (!rows) return null;
    const q = searchText.trim().toLowerCase();
    let r = rows.filter((row) => {
      if (q) {
        const hay = [
          row.title,
          row.matched_driver_name,
          row.matched_scheme_text,
          row.seller_username,
          row.matched_oem,
          row.matched_brand,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter === "active" && row.status !== "active") return false;
      if (statusFilter === "ended" && row.status !== "ended") return false;
      if (matchFilter === "matched" && row.registry_entry_id === null)
        return false;
      if (matchFilter === "unmatched" && row.registry_entry_id !== null)
        return false;
      if (sourceFilter !== "all" && row.seller_code !== sourceFilter)
        return false;
      if (offerFilter !== "all") {
        const offer = offersByItemId.get(
          legacyIdFromExternalId(row.external_id),
        );
        const hasOffer = offer !== undefined;
        if (offerFilter === "with" && !hasOffer) return false;
        if (offerFilter === "without" && hasOffer) return false;
        if (offerFilter === "unresponded") {
          if (!hasOffer) return false;
          // Heuristic for "user already responded": either the
          // notification was opened (eBay flips <Read> on the inbox UI
          // when you open the message — which the web accept/decline
          // flow does), or the underlying listing has ended (signal
          // that the offer was accepted and the item sold). Conservative:
          // a missing listing is treated as "still active" so users who
          // haven't run watchlist sync still see their offers.
          const responded =
            offer.is_read || row.status === "ended";
          if (responded) return false;
        }
      }
      return true;
    });

    const sorted = [...r];
    sorted.sort((a, b) => {
      const totalA =
        a.price_cents !== null ? a.price_cents + (a.shipping_cents ?? 0) : null;
      const totalB =
        b.price_cents !== null ? b.price_cents + (b.shipping_cents ?? 0) : null;
      const nullsLast = (av: number | null, bv: number | null) => {
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return av - bv;
      };
      switch (sortMode) {
        case "newest":
          return b.last_seen_at - a.last_seen_at;
        case "price-asc":
          return nullsLast(a.price_cents, b.price_cents);
        case "price-desc":
          return nullsLast(b.price_cents, a.price_cents);
        case "total-asc":
          return nullsLast(totalA, totalB);
        case "deal-asc":
          return nullsLast(a.deal_score, b.deal_score);
        case "ending-soon":
          return nullsLast(a.end_time, b.end_time);
        case "title":
          return a.title.localeCompare(b.title);
      }
    });
    return sorted;
  }, [
    rows,
    searchText,
    statusFilter,
    matchFilter,
    sourceFilter,
    offerFilter,
    offersByItemId,
    sortMode,
  ]);

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Saved Listings</h2>
          <p className="text-sm text-fg-subtle">
            Track eBay listings you're watching. Paste a URL or pull your eBay
            watchlist directly. Facebook Marketplace integration ships later
            via a browser extension.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-primary"
            type="button"
            onClick={onSyncWatchlist}
            disabled={syncingWatchlist}
            title="Pull watchlist from your connected eBay account"
          >
            {syncingWatchlist ? "Syncing…" : "Sync watchlist"}
          </button>
          {rows && rows.length > 0 && (
            <>
              <button
                className="btn-secondary"
                type="button"
                onClick={onRematchAll}
                disabled={rematching}
                title="Re-run the title→registry matcher against every listing"
              >
                {rematching ? "Matching…" : "Re-match all"}
              </button>
              <button
                className="btn-secondary"
                type="button"
                onClick={onRefreshAll}
                disabled={bulkRefreshing}
              >
                {bulkRefreshing ? "Refreshing…" : "Refresh all"}
              </button>
            </>
          )}
        </div>
      </header>

      <section className="card space-y-3">
        <h3 className="text-sm font-medium">Add eBay listing</h3>
        <form onSubmit={onAdd} className="flex items-center gap-2">
          <input
            className="input flex-1"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://www.ebay.com/itm/123456789012  or just 123456789012"
            autoComplete="off"
          />
          <button
            className="btn-primary shrink-0"
            type="submit"
            disabled={adding || !input.trim()}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </form>
        {addMessage && (
          <div className="text-xs text-emerald-400">{addMessage}</div>
        )}
        {addError && <div className="text-xs text-red-400">{addError}</div>}
      </section>

      {bulkSummary && (
        <div className="text-xs text-emerald-400">
          Refreshed {bulkSummary.refreshed} of {bulkSummary.considered} (
          {bulkSummary.failed} failed).
        </div>
      )}
      {watchlistSummary && (
        <div className="text-xs text-emerald-400">
          Watchlist: {watchlistSummary.created} new,{" "}
          {watchlistSummary.updated} updated,{" "}
          {watchlistSummary.filtered} filtered (non-diecasts),{" "}
          {watchlistSummary.failed} failed,{" "}
          {watchlistSummary.pruned} pruned (no longer watched) across{" "}
          {watchlistSummary.pages_fetched} page
          {watchlistSummary.pages_fetched === 1 ? "" : "s"} (
          {watchlistSummary.items_seen} items total).
        </div>
      )}
      {matchSummary && (
        <div className="text-xs text-emerald-400">
          Matched: {matchSummary.auto_matched} auto-matched,{" "}
          {matchSummary.needs_review} need review,{" "}
          {matchSummary.unmatched} unmatched (of {matchSummary.considered}).
        </div>
      )}
      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="card !p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="input flex-1"
              placeholder="Search title, driver, scheme, seller…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <select
              className="input !w-auto"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              title="Sort"
            >
              <option value="newest">Newest first</option>
              <option value="price-asc">Price low → high</option>
              <option value="price-desc">Price high → low</option>
              <option value="total-asc">Total (price + ship) low → high</option>
              <option value="deal-asc">Best deal first</option>
              <option value="ending-soon">Ending soonest</option>
              <option value="title">Title A → Z</option>
            </select>
          </div>
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <FilterChips
              label="Status"
              value={statusFilter}
              options={[
                { value: "active", label: "Active" },
                { value: "ended", label: "Ended" },
                { value: "all", label: "All" },
              ]}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
            />
            <FilterChips
              label="Match"
              value={matchFilter}
              options={[
                { value: "all", label: "All" },
                { value: "matched", label: "Matched" },
                { value: "unmatched", label: "Unmatched" },
              ]}
              onChange={(v) => setMatchFilter(v as MatchFilter)}
            />
            <FilterChips
              label="Offer"
              value={offerFilter}
              options={[
                { value: "all", label: "All" },
                { value: "unresponded", label: "Unresponded" },
                { value: "with", label: "Any offer" },
                { value: "without", label: "No offer" },
              ]}
              onChange={(v) => setOfferFilter(v as OfferFilter)}
            />
            <FilterChips
              label="Source"
              value={sourceFilter}
              options={[
                { value: "all", label: "All" },
                { value: "ebay", label: "eBay" },
                { value: "fb", label: "Facebook" },
              ]}
              onChange={(v) => setSourceFilter(v as SourceFilter)}
            />
            <div className="ml-auto flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-fg-subtle">View:</span>
                <button
                  type="button"
                  className={`px-2 py-1 rounded border ${
                    viewMode === "flat"
                      ? "border-accent text-accent bg-accent/10"
                      : "border-border text-fg-muted hover:text-fg"
                  }`}
                  onClick={() => setViewMode("flat")}
                >
                  Flat
                </button>
                <button
                  type="button"
                  className={`px-2 py-1 rounded border ${
                    viewMode === "byDriver"
                      ? "border-accent text-accent bg-accent/10"
                      : "border-border text-fg-muted hover:text-fg"
                  }`}
                  onClick={() => setViewMode("byDriver")}
                >
                  By driver
                </button>
              </div>
              <ImageSizeToggle size={imgSize} onChange={setImgSize} />
            </div>
          </div>
          {filteredRows && filteredRows.length !== rows.length && (
            <div className="text-xs text-fg-subtle">
              Showing {filteredRows.length} of {rows.length} listings.
            </div>
          )}
        </div>
      )}

      {rows === null ? (
        <div className="card text-sm text-fg-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          No listings tracked yet. Add an eBay URL above.
        </div>
      ) : filteredRows && filteredRows.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          No listings match the current filters.
        </div>
      ) : viewMode === "flat" ? (
        <ul className="space-y-2">
          {(filteredRows ?? []).map((r) => (
            <ListingCard
              key={r.listing_id}
              row={r}
              offer={offersByItemId.get(legacyIdFromExternalId(r.external_id))}
              refreshing={refreshingId === r.listing_id}
              unwatching={unwatchingId === r.listing_id}
              onRefresh={() => onRefreshOne(r.listing_id)}
              onUnwatch={() => onUnwatch(r)}
              onConfirmMatch={() => onConfirmMatch(r.listing_id)}
              onClearMatch={() => onClearMatch(r.listing_id)}
              onRejectMatch={() => onRejectMatch(r.listing_id)}
              onChangeMatch={() => setRegistrySearchListing(r)}
              imgSizeClass={IMG_CLASS[imgSize]}
            />
          ))}
        </ul>
      ) : (
        <GroupedByDriver
          rows={filteredRows ?? []}
          offersByItemId={offersByItemId}
          refreshingId={refreshingId}
          unwatchingId={unwatchingId}
          onRefresh={onRefreshOne}
          onUnwatch={onUnwatch}
          onConfirmMatch={onConfirmMatch}
          onClearMatch={onClearMatch}
          onRejectMatch={onRejectMatch}
          onChangeMatch={setRegistrySearchListing}
          imgSizeClass={IMG_CLASS[imgSize]}
        />
      )}

      {registrySearchListing && (
        <RegistrySearchDialog
          listing={registrySearchListing}
          onClose={() => setRegistrySearchListing(null)}
          onLinked={async () => {
            setRegistrySearchListing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function ListingCard({
  row,
  offer,
  refreshing,
  unwatching,
  onRefresh,
  onUnwatch,
  onConfirmMatch,
  onClearMatch,
  onRejectMatch,
  onChangeMatch,
  imgSizeClass,
}: {
  row: ListingRow;
  offer: ReceivedOffer | undefined;
  refreshing: boolean;
  unwatching: boolean;
  onRefresh: () => void;
  onUnwatch: () => void;
  onConfirmMatch: () => void;
  onClearMatch: () => void;
  onRejectMatch: () => void;
  onChangeMatch: () => void;
  imgSizeClass: string;
}) {
  const total =
    row.price_cents !== null
      ? row.price_cents + (row.shipping_cents ?? 0)
      : null;
  const ended = row.status === "ended";
  const matched = row.registry_entry_id !== null;
  return (
    <li className={`card flex gap-4 ${ended ? "opacity-60" : ""}`}>
      {row.image_url && (
        <img
          src={row.image_url}
          alt=""
          className={`${imgSizeClass} object-cover rounded border border-border shrink-0`}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium truncate flex-1 min-w-0">
            {row.title}
          </div>
          {offer && <OfferBadge offer={offer} />}
        </div>
        <div className="text-xs text-fg-subtle mt-0.5">
          {[
            row.seller_code,
            row.condition,
            row.listing_type,
            row.seller_username && `seller: ${row.seller_username}`,
            row.seller_rating !== null &&
              row.seller_rating !== undefined &&
              `${row.seller_rating}%`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>

        {matched ? (
          <div className="mt-2 rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-emerald-400">
                {row.match_user_confirmed ? "✓ confirmed" : "✓ matched"}
              </span>
              <span className="text-fg-muted truncate">
                {row.matched_driver_name}
                {row.matched_scheme_text
                  ? ` — ${row.matched_scheme_text}`
                  : ""}
              </span>
            </div>
            <div className="text-fg-subtle mt-0.5">
              {[
                row.matched_year,
                row.matched_oem,
                row.matched_brand,
                row.matched_scale,
              ]
                .filter(Boolean)
                .join(" · ")}
              {row.match_confidence !== null &&
                !row.match_user_confirmed && (
                  <span className="ml-2 text-fg-faint">
                    ({row.match_confidence.toFixed(0)}% confidence)
                  </span>
                )}
            </div>
            {row.matched_detail_url && (
              <a
                className="text-accent hover:underline mt-0.5 inline-block"
                href={"https://www.diecastregistry.com" + row.matched_detail_url}
                target="_blank"
                rel="noreferrer"
              >
                View on diecastregistry.com →
              </a>
            )}
          </div>
        ) : row.match_user_confirmed ? (
          <div className="mt-2 text-xs text-fg-subtle">
            Marked as no-match.
          </div>
        ) : (
          <div className="mt-2 text-xs text-amber-400/80">
            Unmatched — no registry entry found for this listing.
          </div>
        )}

        <div className="text-xs text-fg-subtle mt-1">
          {ended
            ? "ended"
            : row.end_time
              ? `ends ${new Date(row.end_time * 1000).toLocaleString()}`
              : ""}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
          <a
            className="text-xs text-accent hover:underline"
            href={row.url}
            target="_blank"
            rel="noreferrer"
          >
            View on eBay →
          </a>
          <button
            className="text-xs text-fg-muted hover:text-fg"
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {row.seller_code === "ebay" && (
            <button
              className="text-xs text-fg-subtle hover:text-red-300"
              type="button"
              onClick={onUnwatch}
              disabled={unwatching}
              title="Remove from your eBay watchlist and delete this local row"
            >
              {unwatching ? "Removing…" : "Remove from watchlist"}
            </button>
          )}
          {matched && !row.match_user_confirmed && (
            <button
              className="text-xs text-emerald-400 hover:text-emerald-300"
              type="button"
              onClick={onConfirmMatch}
              title="Lock this match so re-match-all leaves it alone"
            >
              Confirm
            </button>
          )}
          <button
            className="text-xs text-fg-muted hover:text-fg"
            type="button"
            onClick={onChangeMatch}
            title="Search the diecastregistry.com catalog and link a result to this listing"
          >
            {matched ? "Change match…" : "Match…"}
          </button>
          {matched && (
            <button
              className="text-xs text-fg-subtle hover:text-fg-muted"
              type="button"
              onClick={onClearMatch}
              title="Remove the match and let auto-match try again"
            >
              Clear
            </button>
          )}
          {!matched && !row.match_user_confirmed && (
            <button
              className="text-xs text-fg-subtle hover:text-fg-muted"
              type="button"
              onClick={onRejectMatch}
              title="Mark as having no match in your registry"
            >
              Mark no-match
            </button>
          )}
          {row.match_user_confirmed && !matched && (
            <button
              className="text-xs text-fg-subtle hover:text-fg-muted"
              type="button"
              onClick={onClearMatch}
            >
              Allow auto-match
            </button>
          )}
        </div>
      </div>
      <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
        <div className="text-base text-fg">
          {formatCents(row.price_cents)}
        </div>
        {row.shipping_cents !== null && row.shipping_cents > 0 && (
          <div className="text-fg-subtle">
            + {formatCents(row.shipping_cents)} ship
          </div>
        )}
        {total !== null && row.shipping_cents !== null && row.shipping_cents > 0 && (
          <div className="text-fg-muted">total {formatCents(total)}</div>
        )}
        {matched && (
          <div className="text-fg-subtle mt-1">
            retail {formatCents(row.matched_retail_cents)}
          </div>
        )}
        {row.deal_score !== null && (
          <DealBadge score={row.deal_score} />
        )}
      </div>
    </li>
  );
}

function DealBadge({ score }: { score: number }) {
  // score = (price+shipping) / retail * 100
  // < 70%  → great deal (green)
  // 70-90% → fair (yellow)
  // 90-110% → at retail (slate)
  // > 110% → over retail (red)
  let cls = "text-fg-muted border-border";
  let label = "at retail";
  if (score < 70) {
    cls = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    label = "great deal";
  } else if (score < 90) {
    cls = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
    label = "fair";
  } else if (score > 110) {
    cls = "text-red-400 border-red-500/30 bg-red-500/10";
    label = "over retail";
  }
  return (
    <div
      className={`inline-flex flex-col items-end mt-1 px-1.5 py-0.5 rounded border ${cls}`}
      title={`${score.toFixed(0)}% of registry retail (${label})`}
    >
      <span className="font-medium">{score.toFixed(0)}% of retail</span>
      <span className="text-[10px] uppercase tracking-wide opacity-80">
        {label}
      </span>
    </div>
  );
}

function GroupedByDriver({
  rows,
  offersByItemId,
  refreshingId,
  unwatchingId,
  onRefresh,
  onUnwatch,
  onConfirmMatch,
  onClearMatch,
  onRejectMatch,
  onChangeMatch,
  imgSizeClass,
}: {
  rows: ListingRow[];
  offersByItemId: Map<string, ReceivedOffer>;
  refreshingId: number | null;
  unwatchingId: number | null;
  onRefresh: (id: number) => void;
  onUnwatch: (row: ListingRow) => void;
  onConfirmMatch: (id: number) => void;
  onClearMatch: (id: number) => void;
  onRejectMatch: (id: number) => void;
  onChangeMatch: (row: ListingRow) => void;
  imgSizeClass: string;
}) {
  // Bucket by driver name; matched first, then "Unmatched" / "No-match" at
  // the bottom.
  const groups = useMemo(() => {
    const map = new Map<string, ListingRow[]>();
    for (const r of rows) {
      const key = r.matched_driver_name ?? "Unmatched";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    const entries = Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "Unmatched") return 1;
      if (b === "Unmatched") return -1;
      return a.localeCompare(b);
    });
    return entries;
  }, [rows]);

  return (
    <div className="space-y-3">
      {groups.map(([driver, items]) => {
        const totalCents = items.reduce(
          (s, r) => s + (r.price_cents ?? 0) + (r.shipping_cents ?? 0),
          0,
        );
        return (
          <details key={driver} className="card !p-0 overflow-hidden" open>
            <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between hover:bg-bg-elevated">
              <div className="flex items-center gap-3">
                <span className="font-medium">{driver}</span>
                <span className="text-xs text-fg-subtle">
                  {items.length} listing{items.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="text-xs text-fg-subtle tabular-nums">
                total {formatCents(totalCents)}
              </div>
            </summary>
            <ul className="divide-y divide-border">
              {items.map((r) => (
                <li key={r.listing_id} className="px-4 py-2">
                  <ListingCard
                    row={r}
                    offer={offersByItemId.get(legacyIdFromExternalId(r.external_id))}
                    refreshing={refreshingId === r.listing_id}
                    unwatching={unwatchingId === r.listing_id}
                    onRefresh={() => onRefresh(r.listing_id)}
                    onUnwatch={() => onUnwatch(r)}
                    onConfirmMatch={() => onConfirmMatch(r.listing_id)}
                    onClearMatch={() => onClearMatch(r.listing_id)}
                    onRejectMatch={() => onRejectMatch(r.listing_id)}
                    onChangeMatch={() => onChangeMatch(r)}
                    imgSizeClass={imgSizeClass}
                  />
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

function RegistrySearchDialog({
  listing,
  onClose,
  onLinked,
}: {
  listing: ListingRow;
  onClose: () => void;
  onLinked: () => void;
}) {
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

  const [results, setResults] = useState<ProductionSearchResult[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [linkingGuid, setLinkingGuid] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadOptions() {
    setDialogError(null);
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
      prefillFromListing(d, s, y);
    } catch (e) {
      setDialogError(String(e));
    }
  }

  function prefillFromListing(
    drivers: FormOptionRow[],
    scales: FormOptionRow[],
    years: FormOptionRow[],
  ) {
    const title = listing.title.toLowerCase();
    const yearMatch = title.match(/\b(19[89]\d|20[0-3]\d)\b/);
    if (yearMatch) {
      const yearStr = yearMatch[1];
      if (years.find((y) => y.value === yearStr)) setSelectedYear(yearStr);
    }
    const scaleMatch = title.match(/\b1\s*[:/]\s*(\d{2,3})\b/);
    if (scaleMatch) {
      const scaleDisplay = `1:${scaleMatch[1]}`;
      const found = scales.find((s) => s.display === scaleDisplay);
      if (found) setSelectedScaleGuid(found.value);
    }
    const titleTokens = new Set(
      title.split(/\W+/).filter((t) => t.length > 0),
    );
    // Prefer the most specific match: "Dale Earnhardt Sr" should win over
    // "Dale Earnhardt" when both fit the title's tokens.
    let best: { display: string; value: string; len: number } | null = null;
    for (const d of drivers) {
      const dt = d.display.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
      if (dt.length > 0 && dt.every((t) => titleTokens.has(t))) {
        if (best === null || dt.length > best.len) {
          best = { display: d.display, value: d.value, len: dt.length };
        }
      }
    }
    if (best) {
      setDriverInput(best.display);
      setSelectedDriverGuid(best.value);
    }
  }

  async function onRefreshOptions() {
    setRefreshing(true);
    setDialogError(null);
    setInfo(null);
    try {
      const summary = await api.refreshRegistryFormOptions();
      setInfo(
        `Cached ${summary.options_upserted} options across ${summary.fields_seen} fields.`,
      );
      await loadOptions();
    } catch (e) {
      setDialogError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function onSearch() {
    setSearching(true);
    setDialogError(null);
    setResults(null);
    try {
      const r = await api.searchDcrProduction({
        driver_guids: selectedDriverGuid ? [selectedDriverGuid] : [],
        years: selectedYear ? [selectedYear] : [],
        oem_guids: selectedOemGuid ? [selectedOemGuid] : [],
        scale_guids: selectedScaleGuid ? [selectedScaleGuid] : [],
        autographed: false,
        raced: false,
      });
      setResults(r);
    } catch (e) {
      setDialogError(String(e));
    } finally {
      setSearching(false);
    }
  }

  async function onLink(result: ProductionSearchResult) {
    setLinkingGuid(result.registry_guid);
    setDialogError(null);
    try {
      await api.linkListingToRegistry(
        listing.listing_id,
        result.registry_guid,
        result.detail_url,
      );
      onLinked();
    } catch (e) {
      setDialogError(String(e));
    } finally {
      setLinkingGuid(null);
    }
  }

  const optionsEmpty =
    optionsLoaded && drivers.length === 0 && oems.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/60"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0">
            <h3 className="text-base font-medium">Search registry</h3>
            <p
              className="text-xs text-fg-subtle mt-0.5 truncate"
              title={listing.title}
            >
              {listing.title}
            </p>
          </div>
          <button
            type="button"
            className="text-fg-muted hover:text-fg text-xl leading-none px-2"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {!optionsLoaded ? (
          <div className="text-sm text-fg-subtle">Loading options…</div>
        ) : optionsEmpty ? (
          <div className="card text-sm text-amber-400/90 space-y-2">
            <div>
              The registry option cache is empty. Fetch it once (a few seconds)
              so the dropdowns can populate.
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
          <>
            <div className="grid grid-cols-2 gap-3">
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

            <div className="flex items-center justify-between mt-3">
              <button
                type="button"
                className="text-xs text-fg-subtle hover:text-fg-muted"
                onClick={onRefreshOptions}
                disabled={refreshing}
                title="Re-fetch the dropdown choices from diecastregistry.com"
              >
                {refreshing ? "Refreshing options…" : "Refresh options"}
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={onSearch}
                disabled={searching}
              >
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
          </>
        )}

        {info && <div className="text-xs text-emerald-400 mt-2">{info}</div>}
        {dialogError && (
          <div className="text-xs text-red-400 mt-2">{dialogError}</div>
        )}

        <div className="flex-1 overflow-y-auto -mx-1 px-1 mt-3 space-y-1 min-h-[8rem]">
          {searching ? (
            <div className="text-sm text-fg-subtle">Searching…</div>
          ) : results === null ? null : results.length === 0 ? (
            <div className="text-sm text-fg-subtle">No results.</div>
          ) : (
            results.map((r) => (
              <button
                key={r.registry_guid}
                type="button"
                className="w-full text-left rounded-md border border-border bg-bg-elevated hover:border-accent hover:bg-accent/5 px-3 py-2 disabled:opacity-50"
                onClick={() => onLink(r)}
                disabled={linkingGuid !== null}
              >
                <div className="flex items-center gap-3">
                  {r.image_url ? (
                    <img
                      src={
                        r.image_url.startsWith("http")
                          ? r.image_url
                          : "https://www.diecastregistry.com" + r.image_url
                      }
                      alt=""
                      loading="lazy"
                      className="w-32 h-32 object-cover rounded border border-border shrink-0"
                    />
                  ) : (
                    <div className="w-32 h-32 rounded border border-border bg-bg shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {r.driver_name}
                      {r.year && (
                        <span className="text-fg-subtle ml-2">{r.year}</span>
                      )}
                    </div>
                    <div className="text-xs text-fg-subtle truncate">
                      {r.scheme_text ?? "(no scheme)"}
                    </div>
                    <div className="text-xs text-fg-faint">
                      {[r.oem, r.brand, r.scale, r.make]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="text-right text-xs tabular-nums shrink-0">
                    <div>retail {formatCents(r.retail_value_cents)}</div>
                    <div className="text-fg-subtle">
                      wholesale {formatCents(r.wholesale_value_cents)}
                    </div>
                    {linkingGuid === r.registry_guid && (
                      <div className="text-emerald-400 mt-1">Linking…</div>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-border">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterChips({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-fg-subtle">{label}:</span>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`px-2 py-0.5 rounded border text-[11px] ${
            value === opt.value
              ? "border-accent text-accent bg-accent/10"
              : "border-border text-fg-muted hover:text-fg"
          }`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function OfferBadge({ offer }: { offer: ReceivedOffer }) {
  const parts: string[] = [];
  if (offer.offer_price_cents !== null) {
    parts.push(formatCents(offer.offer_price_cents));
  }
  if (offer.discount_percent !== null) {
    const pct = Number.isInteger(offer.discount_percent)
      ? `${offer.discount_percent}`
      : offer.discount_percent.toFixed(1);
    parts.push(`${pct}% off`);
  }
  const label = parts.length > 0 ? `Seller offer: ${parts.join(" · ")}` : "Seller offer";
  return (
    <a
      href={offer.item_web_url}
      target="_blank"
      rel="noreferrer"
      title="A seller sent you a discount offer on this item — open eBay to accept or decline"
      className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[11px] hover:bg-emerald-500/20"
    >
      ✨ {label} →
    </a>
  );
}

/** Listings table stores eBay item ids as v1|<legacy>|0; the messages
 *  API returns just the legacy segment, so we extract it for lookups. */
function legacyIdFromExternalId(external_id: string): string {
  const parts = external_id.split("|");
  return parts.length >= 2 && /^\d+$/.test(parts[1]) ? parts[1] : external_id;
}
