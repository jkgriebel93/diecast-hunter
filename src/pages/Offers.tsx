import { useEffect, useMemo, useState } from "react";
import { api, formatCents, type ReceivedOffer } from "@/lib/tauri";

type StatusFilter = "active" | "unread" | "all";

/**
 * Send-Offer-to-Buyer messages from the user's eBay inbox. eBay doesn't
 * expose a BestOfferID for these, so accepting and declining both
 * deep-link to the listing on eBay where the web UI handles the action
 * (with its anti-fraud checks). Each card surfaces enough info — image,
 * title, original/offer price, discount %, expiration, unread badge —
 * for the user to decide before clicking through.
 */
export function Offers() {
  const [offers, setOffers] = useState<ReceivedOffer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listEbayOffers();
      setOffers(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const now = Math.floor(Date.now() / 1000);
  const filteredOffers = useMemo(() => {
    if (!offers) return null;
    return offers.filter((o) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "unread" && o.is_read) return false;
      const expired = o.expires_at !== null && o.expires_at < now;
      if (statusFilter === "active" && expired) return false;
      return true;
    });
  }, [offers, statusFilter, now]);

  const unreadCount = offers?.filter((o) => !o.is_read).length ?? 0;

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Offers</h2>
          <p className="text-sm text-slate-500">
            Discount offers sellers have sent on items in your watchlist.
            eBay doesn't expose accept/decline through the API, so each
            offer links out to the listing where you can act on it.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}

      {offers && offers.length > 0 && (
        <div className="card !p-3 flex items-center gap-2 text-xs flex-wrap">
          <span className="text-slate-500">Show:</span>
          <FilterChip
            active={statusFilter === "active"}
            label="Active (not expired)"
            onClick={() => setStatusFilter("active")}
          />
          <FilterChip
            active={statusFilter === "unread"}
            label={`Unread${unreadCount > 0 ? ` (${unreadCount})` : ""}`}
            onClick={() => setStatusFilter("unread")}
          />
          <FilterChip
            active={statusFilter === "all"}
            label="All"
            onClick={() => setStatusFilter("all")}
          />
          {filteredOffers && filteredOffers.length !== offers.length && (
            <span className="ml-auto text-slate-500">
              Showing {filteredOffers.length} of {offers.length}
            </span>
          )}
        </div>
      )}

      {offers === null ? (
        <div className="card text-sm text-slate-400">Loading…</div>
      ) : offers.length === 0 ? (
        <div className="card text-sm text-slate-400">
          No offers right now. Sellers send these proactively to watchers,
          so add things to your watchlist and check back.
        </div>
      ) : filteredOffers && filteredOffers.length === 0 ? (
        <div className="card text-sm text-slate-400">
          No offers match the current filter.
        </div>
      ) : (
        <ul className="space-y-2">
          {(filteredOffers ?? []).map((o) => (
            <OfferCard key={o.message_id} offer={o} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OfferCard({ offer, now }: { offer: ReceivedOffer; now: number }) {
  const expired = offer.expires_at !== null && offer.expires_at < now;
  return (
    <li className={`card flex gap-4 ${expired ? "opacity-60" : ""}`}>
      {offer.item_image_url ? (
        <img
          src={offer.item_image_url}
          alt=""
          className="w-24 h-24 object-cover rounded border border-border shrink-0"
        />
      ) : (
        <div className="w-24 h-24 rounded border border-border bg-bg-elevated shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div
            className="text-sm font-medium truncate"
            title={offer.item_title}
          >
            {offer.item_title}
          </div>
          {!offer.is_read && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30 shrink-0">
              new
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {[
            `received ${new Date(offer.received_at * 1000).toLocaleString()}`,
            offer.expires_at_text &&
              (expired ? "expired" : `expires ${expirationLabel(offer)}`),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>

        <div className="mt-2">
          <a
            className="text-xs text-accent hover:underline"
            href={offer.item_web_url}
            target="_blank"
            rel="noreferrer"
            title="Open the listing on eBay to accept or decline"
          >
            View on eBay →
          </a>
        </div>
      </div>
      <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
        <div className="text-base text-slate-100">
          {formatCents(offer.offer_price_cents)}
        </div>
        {offer.original_price_cents !== null && (
          <div className="text-slate-500 line-through">
            {formatCents(offer.original_price_cents)}
          </div>
        )}
        {offer.discount_percent !== null && (
          <div className="inline-block mt-1 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            {formatPercent(offer.discount_percent)} off
          </div>
        )}
      </div>
    </li>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`px-2 py-0.5 rounded border text-[11px] ${
        active
          ? "border-accent text-accent bg-accent/10"
          : "border-border text-slate-400 hover:text-slate-100"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function expirationLabel(offer: ReceivedOffer): string {
  if (offer.expires_at !== null) {
    return new Date(offer.expires_at * 1000).toLocaleString();
  }
  // Fall back to the raw "May-14 15:58:53 PDT" text from eBay when we
  // can't parse the timezone.
  return offer.expires_at_text ?? "";
}

function formatPercent(pct: number): string {
  // Strip trailing zeros: 10.0 → "10", 6.3 → "6.3".
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}
