import { FormEvent, useEffect, useState } from "react";
import {
  api,
  formatCents,
  type ListingRow,
  type MatchSummary,
  type RefreshSummary,
  type WatchlistSyncSummary,
} from "@/lib/tauri";

export function Listings() {
  const [rows, setRows] = useState<ListingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [refreshingId, setRefreshingId] = useState<number | null>(null);
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
  }, []);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddMessage(null);
    setAddError(null);
    try {
      const result = await api.addEbayListing(input.trim());
      setAddMessage(
        `${result.created ? "Added" : "Updated"}: ${result.title}`,
      );
      setInput("");
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

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Saved Listings</h2>
          <p className="text-sm text-slate-500">
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
          {watchlistSummary.failed} failed across{" "}
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

      {rows === null ? (
        <div className="card text-sm text-slate-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card text-sm text-slate-400">
          No listings tracked yet. Add an eBay URL above.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <ListingCard
              key={r.listing_id}
              row={r}
              refreshing={refreshingId === r.listing_id}
              onRefresh={() => onRefreshOne(r.listing_id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ListingCard({
  row,
  refreshing,
  onRefresh,
}: {
  row: ListingRow;
  refreshing: boolean;
  onRefresh: () => void;
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
          className="w-24 h-24 object-cover rounded border border-border shrink-0"
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{row.title}</div>
        <div className="text-xs text-slate-500 mt-0.5">
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
              <span className="text-emerald-400">✓ matched</span>
              <span className="text-slate-300 truncate">
                {row.matched_driver_name}
                {row.matched_scheme_text
                  ? ` — ${row.matched_scheme_text}`
                  : ""}
              </span>
            </div>
            <div className="text-slate-500 mt-0.5">
              {[
                row.matched_year,
                row.matched_oem,
                row.matched_brand,
                row.matched_scale,
              ]
                .filter(Boolean)
                .join(" · ")}
              {row.match_confidence !== null && (
                <span className="ml-2 text-slate-600">
                  ({row.match_confidence.toFixed(0)}% confidence)
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-2 text-xs text-amber-400/80">
            Unmatched — no registry entry found for this listing.
          </div>
        )}

        <div className="text-xs text-slate-500 mt-1">
          {ended
            ? "ended"
            : row.end_time
              ? `ends ${new Date(row.end_time * 1000).toLocaleString()}`
              : ""}
        </div>
        <div className="flex items-center gap-3 mt-1">
          <a
            className="text-xs text-accent hover:underline"
            href={row.url}
            target="_blank"
            rel="noreferrer"
          >
            View on eBay →
          </a>
          <button
            className="text-xs text-slate-400 hover:text-slate-100"
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
        <div className="text-base text-slate-100">
          {formatCents(row.price_cents)}
        </div>
        {row.shipping_cents !== null && row.shipping_cents > 0 && (
          <div className="text-slate-500">
            + {formatCents(row.shipping_cents)} ship
          </div>
        )}
        {total !== null && row.shipping_cents !== null && row.shipping_cents > 0 && (
          <div className="text-slate-400">total {formatCents(total)}</div>
        )}
        {matched && (
          <div className="text-slate-500 mt-1">
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
  let cls = "text-slate-400 border-border";
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
