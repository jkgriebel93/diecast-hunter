import { useEffect, useState } from "react";
import { api, formatCount, type ShareRecord } from "@/lib/tauri";
import { Modal } from "@/components/Modal";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NoticeBanner } from "@/components/NoticeBanner";
import {
  DEFAULT_TTL_DAYS,
  TTL_OPTIONS,
  defaultShareLabel,
} from "@/lib/shareLinks";

/**
 * Share a selection of saved listings as a public link (DCH-48).
 *
 * Modelled on `ShareWishlistDialog`, with one deliberate difference: there is
 * no "Copy as text" alternative and no toggle for prices or sellers. On a
 * wishlist those are private annotations; here they are the message. "The
 * five auctions I'm watching" with the prices stripped is not a smaller
 * share, it is a pointless one.
 *
 * What *is* optional is the part eBay didn't publish — our deal score and our
 * comps, which come from the registry and from an archive of sales only this
 * user has.
 */
export function ShareListingsDialog({
  listingIds,
  configured,
  onClose,
  onShared,
}: {
  listingIds: number[];
  /** Whether a Worker URL and secret are set. False turns the dialog into an
   *  explanation rather than a button that fails after a minute of work. */
  configured: boolean;
  onClose: () => void;
  /** A link was created; Settings' list of active links is now stale. */
  onShared?: (share: ShareRecord) => void;
}) {
  const count = listingIds.length;
  const [label, setLabel] = useState(() =>
    defaultShareLabel(count, new Date()),
  );
  const [ttlDays, setTtlDays] = useState(DEFAULT_TTL_DAYS);
  const [includeValuations, setIncludeValuations] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Authored prose with its own tone, kept separate from `error` — a
  // clipboard that refuses is a partial success, not a failure (DCH-36).
  const [notice, setNotice] = useState<{
    tone: "success" | "warning";
    message: string;
  } | null>(null);
  const [share, setShare] = useState<ShareRecord | null>(null);

  // The default names the selection, so a selection changed behind the
  // dialog would leave a label that misreports it.
  useEffect(() => {
    setLabel(defaultShareLabel(count, new Date()));
  }, [count]);

  /**
   * Copy, and say so either way.
   *
   * A refused clipboard is *not* an error here: the page is published, the
   * link is on screen, and nothing needs undoing. Routing it through
   * `ErrorBanner` would retitle a one-line explanation as "Something went
   * wrong." next to a link that works — which is exactly the overloading
   * DCH-36 exists to stop.
   */
  async function copy(text: string, copied: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ tone: "success", message: copied });
    } catch {
      setNotice({
        tone: "warning",
        message: "Couldn't reach the clipboard — the link is shown above.",
      });
    }
  }

  async function onShare() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.shareListings(listingIds, {
        label,
        includeValuations,
        ttlDays,
      });
      setShare(created);
      onShared?.(created);
      await copy(created.url, "Link copied. Paste it anywhere.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Share these listings"
      description={`${formatCount(count)} selected`}
      onClose={onClose}
      busy={busy}
      size="max-w-lg"
      footer={
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          disabled={busy}
        >
          {share ? "Done" : "Cancel"}
        </button>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorBanner error={error} variant="inline" />}
        {notice && (
          <NoticeBanner
            variant="inline"
            tone={notice.tone}
            message={notice.message}
          />
        )}

        <p className="text-xs text-fg-muted">
          Builds a page with each listing's photo, price, seller and a link to
          the eBay item. Anyone with the link can see it — there's no sign-in.
        </p>

        {!configured ? (
          <p className="text-xs text-fg-subtle">
            Sharing needs your own Cloudflare Worker. Add its URL and shared
            secret under Settings → Accounts, then come back.
          </p>
        ) : share ? (
          <div className="rounded border border-border bg-bg-elevated px-3 py-2 text-xs space-y-2">
            <div className="font-mono break-all text-fg">{share.url}</div>
            <button
              type="button"
              className="btn-secondary !px-3 !py-1 !text-xs"
              onClick={() => void copy(share.url, "Link copied.")}
            >
              Copy link
            </button>
          </div>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">Name this share</span>
              <input
                type="text"
                className="input !py-1 !text-xs"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={busy}
                placeholder={`${count} listings`}
              />
              <span className="block text-[11px] text-fg-subtle">
                Shown as the page's heading, and how you'll find this link again
                in Settings.
              </span>
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">Link expires after</span>
              <select
                className="input !py-1 !text-xs"
                value={ttlDays}
                onChange={(e) => setTtlDays(Number(e.target.value))}
                disabled={busy}
              >
                {TTL_OPTIONS.map((o) => (
                  <option key={o.days} value={o.days}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-start gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                className="mt-0.5 accent-current"
                checked={includeValuations}
                onChange={(e) => setIncludeValuations(e.target.checked)}
                disabled={busy}
              />
              <span>
                Include what I think they're worth
                <span className="block text-fg-subtle">
                  Off by default — adds your deal score and recent sold prices,
                  which eBay doesn't show and the seller can read too.
                </span>
              </span>
            </label>

            <div className="pt-1">
              <button
                type="button"
                className="btn-primary !px-3 !py-1 !text-xs"
                onClick={onShare}
                disabled={busy || count === 0}
                title="Publish these listings and copy the link"
              >
                {busy ? "Publishing…" : "Create link"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
