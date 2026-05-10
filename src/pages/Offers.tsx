import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  api,
  formatCents,
  type ItemProbeResult,
  type ReceivedOffer,
} from "@/lib/tauri";

type StatusFilter = "actionable" | "all";

/**
 * Offers sellers have sent on items the user is watching ("Send Offer to
 * Buyer" promotions). Powered by the Trading API GetMyeBayBuying call
 * fetching the user's watchlist with full detail; we surface watched
 * items that have a <BestOffer> attached. Decline is in-app via
 * RespondToBestOffer; Accept deep-links to the item page on eBay since
 * its accept flow has anti-fraud gates that aren't exposed to the API.
 */
export function Offers() {
  const [offers, setOffers] = useState<ReceivedOffer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("actionable");

  const [probeInput, setProbeInput] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ItemProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

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

  async function onProbe(e: FormEvent) {
    e.preventDefault();
    const id = probeInput.trim();
    if (!id) return;
    setProbing(true);
    setProbeError(null);
    setProbeResult(null);
    try {
      const result = await api.probeEbayItemForOffers(id);
      setProbeResult(result);
    } catch (err) {
      setProbeError(String(err));
    } finally {
      setProbing(false);
    }
  }

  async function onDecline(offer: ReceivedOffer) {
    const ok = window.confirm(
      `Decline this offer (${formatCents(offer.offer_price_cents)})?\n\n${offer.item_title}`,
    );
    if (!ok) return;
    setDecliningId(offer.offer_id);
    setActionMessage(null);
    setError(null);
    try {
      await api.declineEbayOffer(offer.item_id, offer.offer_id);
      setActionMessage(`Declined offer on: ${offer.item_title}`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDecliningId(null);
    }
  }

  const filteredOffers = useMemo(() => {
    if (!offers) return null;
    if (statusFilter === "all") return offers;
    return offers.filter((o) => isActionable(o));
  }, [offers, statusFilter]);

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Offers</h2>
          <p className="text-sm text-slate-500">
            Offers sellers have sent on items you're watching. Decline in-app;
            accepting opens eBay so you can complete checkout.
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

      <section className="card space-y-2 border-amber-500/30">
        <div className="text-xs text-amber-400/90">
          Diagnostic — paste the item id of a watched listing where you're
          expecting a Send-Offer-to-Buyer offer. We'll fetch the item via
          Trading API GetItem with the buyer's token and report which
          offer-related fields (if any) come back.
        </div>
        <form onSubmit={onProbe} className="flex items-center gap-2">
          <input
            className="input flex-1"
            type="text"
            value={probeInput}
            onChange={(e) => setProbeInput(e.target.value)}
            placeholder="eBay item id, e.g. 117018958879"
            autoComplete="off"
          />
          <button
            className="btn-secondary shrink-0"
            type="submit"
            disabled={probing || !probeInput.trim()}
          >
            {probing ? "Probing…" : "Probe"}
          </button>
        </form>
        {probeError && (
          <div className="text-xs text-red-400">{probeError}</div>
        )}
        {probeResult && (
          <div className="text-xs text-slate-300 font-mono space-y-0.5">
            <div>response: {probeResult.response_size_bytes} bytes</div>
            <div>&lt;BestOfferDetails: {probeResult.best_offer_details_count}</div>
            <div>&lt;BestOffer&gt;: {probeResult.best_offer_inline_count}</div>
            <div>
              &lt;BestOffer (with attrs): {probeResult.best_offer_with_attrs_count}
            </div>
            <div>BestOfferEnabled: {probeResult.best_offer_enabled_count}</div>
            <div>
              &lt;BestOfferCount&gt;: {probeResult.best_offer_count_tag_count}
            </div>
            <div>BestOfferID: {probeResult.best_offer_id_count}</div>
            <div>SellerOffer: {probeResult.seller_offer_count}</div>
            <div className="text-slate-500 break-all">
              dump: {probeResult.dump_path}
            </div>
          </div>
        )}
      </section>

      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}
      {actionMessage && (
        <div className="text-xs text-emerald-400">{actionMessage}</div>
      )}

      {offers && offers.length > 0 && (
        <div className="card !p-3 flex items-center gap-2 text-xs flex-wrap">
          <span className="text-slate-500">Show:</span>
          <FilterChip
            active={statusFilter === "actionable"}
            label="Actionable (Pending / Countered)"
            onClick={() => setStatusFilter("actionable")}
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
          No offers right now. Sellers send these proactively to watchers of
          their items, so add things to your watchlist and check back.
        </div>
      ) : filteredOffers && filteredOffers.length === 0 ? (
        <div className="card text-sm text-slate-400">
          No offers match the current filter.
        </div>
      ) : (
        <ul className="space-y-2">
          {(filteredOffers ?? []).map((o) => (
            <OfferCard
              key={`${o.item_id}-${o.offer_id}`}
              offer={o}
              declining={decliningId === o.offer_id}
              onDecline={() => onDecline(o)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function OfferCard({
  offer,
  declining,
  onDecline,
}: {
  offer: ReceivedOffer;
  declining: boolean;
  onDecline: () => void;
}) {
  const fromSeller =
    offer.offer_type === "SellerOffer" ||
    offer.offer_type === "CounterOffer";
  const actionable = isActionable(offer);
  const acceptUrl = offer.item_web_url ?? `https://www.ebay.com/itm/${offer.item_id}`;
  return (
    <li className="card flex gap-4">
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
        <div className="text-sm font-medium truncate" title={offer.item_title}>
          {offer.item_title}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {[
            fromSeller ? "Seller offer" : "Your offer",
            offer.offer_status,
            offer.expiration_time &&
              `expires ${new Date(offer.expiration_time * 1000).toLocaleString()}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {offer.seller_message && (
          <div className="mt-2 text-xs text-slate-300 italic border-l-2 border-border pl-2">
            “{offer.seller_message}”
            <span className="text-slate-500 not-italic ml-1">— seller</span>
          </div>
        )}
        {offer.buyer_message && (
          <div className="mt-1 text-xs text-slate-400 italic border-l-2 border-border pl-2">
            “{offer.buyer_message}”
            <span className="text-slate-500 not-italic ml-1">— you</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          <a
            className="text-xs text-accent hover:underline"
            href={acceptUrl}
            target="_blank"
            rel="noreferrer"
            title={
              actionable
                ? "Open the listing on eBay to accept (eBay handles checkout)"
                : "Open the listing on eBay"
            }
          >
            {actionable ? "Accept on eBay →" : "View on eBay →"}
          </a>
          {actionable && (
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-red-300 disabled:opacity-50"
              onClick={onDecline}
              disabled={declining}
            >
              {declining ? "Declining…" : "Decline"}
            </button>
          )}
        </div>
      </div>
      <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
        <div className="text-base text-slate-100">
          {formatCents(offer.offer_price_cents)}
        </div>
        {offer.item_current_price_cents !== null && (
          <div className="text-slate-500">
            list {formatCents(offer.item_current_price_cents)}
          </div>
        )}
        {offer.offer_price_cents !== null &&
          offer.item_current_price_cents !== null &&
          offer.item_current_price_cents > 0 && (
            <div className="text-slate-400">
              {Math.round(
                (offer.offer_price_cents / offer.item_current_price_cents) * 100,
              )}
              % of list
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

function isActionable(o: ReceivedOffer): boolean {
  return o.offer_status === "Pending" || o.offer_status === "Countered";
}
