import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  formatCents,
  type EbaySyncAllSummary,
  type ListingRow,
  type SavedSearch,
  type SavedSeller,
} from "@/lib/tauri";

export function Ebay() {
  const [rows, setRows] = useState<ListingRow[] | null>(null);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[] | null>(
    null,
  );
  const [savedSellers, setSavedSellers] = useState<SavedSeller[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncSummary, setSyncSummary] =
    useState<EbaySyncAllSummary | null>(null);

  async function loadAll() {
    setError(null);
    try {
      const [listings, searches, sellers] = await Promise.all([
        api.listListings(),
        api.listSavedSearches().catch(() => [] as SavedSearch[]),
        api.listSavedSellers().catch(() => [] as SavedSeller[]),
      ]);
      setRows(listings);
      setSavedSearches(searches);
      setSavedSellers(sellers);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function onSyncAll() {
    setSyncingAll(true);
    setSyncSummary(null);
    setError(null);
    try {
      const summary = await api.syncEbayAll();
      setSyncSummary(summary);
      await loadAll();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncingAll(false);
    }
  }

  const summary = useMemo(() => {
    if (!rows) return null;
    const ebay = rows.filter((r) => r.seller_code === "ebay");
    const active = ebay.filter((r) => r.status === "active");
    const ended = ebay.filter((r) => r.status === "ended");
    const matched = ebay.filter((r) => r.registry_entry_id !== null);
    const unmatched = ebay.filter(
      (r) => r.registry_entry_id === null && !r.match_user_confirmed,
    );
    const trackedValue = active.reduce(
      (s, r) => s + (r.price_cents ?? 0) + (r.shipping_cents ?? 0),
      0,
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const oneDay = 24 * 3600;
    const endingSoon = active
      .filter(
        (r) =>
          r.end_time !== null &&
          r.end_time >= nowSec &&
          r.end_time <= nowSec + oneDay,
      )
      .sort((a, b) => (a.end_time ?? 0) - (b.end_time ?? 0))
      .slice(0, 5);
    const bestDeals = active
      .filter((r) => r.deal_score !== null)
      .sort((a, b) => (a.deal_score ?? 0) - (b.deal_score ?? 0))
      .slice(0, 5);
    return {
      total: ebay.length,
      active: active.length,
      ended: ended.length,
      matched: matched.length,
      unmatched: unmatched.length,
      trackedValue,
      endingSoon,
      bestDeals,
    };
  }, [rows]);

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">eBay</h2>
          <p className="text-sm text-fg-subtle">
            Overview of your saved eBay listings. More tools land here over
            time.
          </p>
        </div>
        <button
          className="btn-primary"
          type="button"
          onClick={onSyncAll}
          disabled={syncingAll}
          title="Sync watchlist, saved searches, and saved sellers from eBay (prunes ones removed there)"
        >
          {syncingAll ? "Syncing eBay…" : "Sync everything"}
        </button>
      </header>

      {syncSummary && (
        <div className="card text-xs text-emerald-400 space-y-1">
          <div>
            Listings: +{syncSummary.watchlist.created} new, ~
            {syncSummary.watchlist.updated} updated,{" "}
            {syncSummary.watchlist.filtered} filtered,{" "}
            {syncSummary.watchlist.failed} failed,{" "}
            -{syncSummary.watchlist.pruned} pruned (
            {syncSummary.watchlist.items_seen} seen across{" "}
            {syncSummary.watchlist.pages_fetched} page
            {syncSummary.watchlist.pages_fetched === 1 ? "" : "s"}).
          </div>
          <div>
            Saved searches: +{syncSummary.saved.searches_created} new, ~
            {syncSummary.saved.searches_updated} updated, -
            {syncSummary.saved.searches_pruned} pruned (
            {syncSummary.saved.searches_seen} on eBay).
          </div>
          <div>
            Saved sellers: +{syncSummary.saved.sellers_created} new, ~
            {syncSummary.saved.sellers_updated} updated, -
            {syncSummary.saved.sellers_pruned} pruned (
            {syncSummary.saved.sellers_seen} on eBay).
          </div>
        </div>
      )}

      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="card text-sm text-fg-muted">Loading…</div>
      ) : summary === null ? null : (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium uppercase tracking-wide text-fg-muted">
                Saved Listings
              </h3>
              <Link
                to="/listings"
                className="text-xs text-accent hover:underline"
              >
                Open Saved Listings →
              </Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Stat label="Total" value={summary.total} />
              <Stat label="Active" value={summary.active} />
              <Stat label="Ended" value={summary.ended} />
              <Stat label="Matched" value={summary.matched} />
              <Stat label="Unmatched" value={summary.unmatched} />
              <Stat
                label="Tracked total"
                value={formatCents(summary.trackedValue)}
              />
            </div>
          </section>

          {summary.endingSoon.length > 0 && (
            <section className="card !p-0 overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-medium">Ending in the next 24h</h3>
                <span className="text-xs text-fg-subtle">
                  {summary.endingSoon.length}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {summary.endingSoon.map((r) => (
                  <ListingPreview key={r.listing_id} row={r} />
                ))}
              </ul>
            </section>
          )}

          {summary.bestDeals.length > 0 && (
            <section className="card !p-0 overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-medium">
                  Best deals on your watchlist
                </h3>
                <span className="text-xs text-fg-subtle">
                  by % of registry retail
                </span>
              </div>
              <ul className="divide-y divide-border">
                {summary.bestDeals.map((r) => (
                  <ListingPreview key={r.listing_id} row={r} />
                ))}
              </ul>
            </section>
          )}

          <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Link
              to="/ebay/feed"
              className="card hover:border-accent transition-colors"
            >
              <h3 className="text-sm font-medium">Seller feed →</h3>
              <p className="text-xs text-fg-subtle mt-0.5">
                {savedSellers && savedSellers.length > 0
                  ? `Recent listings from ${savedSellers.length} saved seller${
                      savedSellers.length === 1 ? "" : "s"
                    }`
                  : "Add saved sellers to populate this feed"}
              </p>
            </Link>
            <Link
              to="/ebay/searches"
              className="card hover:border-accent transition-colors"
            >
              <h3 className="text-sm font-medium">Saved Searches →</h3>
              <p className="text-xs text-fg-subtle mt-0.5">
                {savedSearches !== null
                  ? `${savedSearches.length} saved search${
                      savedSearches.length === 1 ? "" : "es"
                    }`
                  : "—"}
              </p>
            </Link>
          </section>

          <section className="card flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">Browse eBay</h3>
              <p className="text-xs text-fg-subtle mt-0.5">
                Search eBay directly and pull listings into your watchlist.
              </p>
            </div>
            <Link to="/browse" className="btn-secondary text-xs">
              Open Browse →
            </Link>
          </section>

          <section className="card border-dashed text-sm text-fg-subtle italic">
            More eBay tools coming soon — seller history, completed-listing
            comps, deal alerts, and bulk actions.
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card !p-3">
      <div className="label">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ListingPreview({ row }: { row: ListingRow }) {
  const total =
    row.price_cents !== null
      ? row.price_cents + (row.shipping_cents ?? 0)
      : null;
  return (
    <li className="px-4 py-2 flex items-center gap-3">
      {row.image_url ? (
        <img
          src={row.image_url}
          alt=""
          className="w-12 h-12 object-cover rounded border border-border shrink-0"
        />
      ) : (
        <div className="w-12 h-12 rounded border border-border bg-bg-elevated shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <a
          href={row.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-fg hover:text-accent truncate block"
        >
          {row.title}
        </a>
        <div className="text-xs text-fg-subtle truncate">
          {row.matched_driver_name ?? "(unmatched)"}
          {row.end_time && row.status === "active" && (
            <span>
              {" · ends "}
              {new Date(row.end_time * 1000).toLocaleString()}
            </span>
          )}
        </div>
      </div>
      <div className="text-right text-xs tabular-nums shrink-0">
        <div className="text-sm text-fg">{formatCents(total)}</div>
        {row.deal_score !== null && (
          <div className="text-fg-subtle">
            {row.deal_score.toFixed(0)}% of retail
          </div>
        )}
      </div>
    </li>
  );
}
