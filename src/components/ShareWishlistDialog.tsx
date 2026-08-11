import { useEffect, useState } from "react";
import {
  api,
  formatDate,
  type ShareStatus,
  type WishlistEntry,
} from "@/lib/tauri";
import { Modal } from "@/components/Modal";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NoticeBanner } from "@/components/NoticeBanner";
import { wishlistToText } from "@/lib/wishlistText";

/**
 * Share a wishlist as a public link, or as plain text (DCH-46).
 *
 * Two paths, deliberately side by side. The link needs the user's own
 * Cloudflare Worker configured; **Copy as text** needs nothing at all, so
 * it stays available even when the link path can't work — which is what
 * makes the unconfigured state an explanation rather than a dead end.
 *
 * The privacy toggles default to off. A link is public to anyone holding it,
 * and notes and candidate prices are the two things on a wishlist that
 * aren't inferable from the wish itself.
 */
export function ShareWishlistDialog({
  wishlistId,
  listName,
  entries,
  onClose,
  onChanged,
}: {
  wishlistId: number;
  listName: string;
  /** Already loaded by the page — the text fallback needs no round trip. */
  entries: readonly WishlistEntry[];
  onClose: () => void;
  /** A share was created or revoked; the page refreshes its own state. */
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"share" | "revoke" | null>(null);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [includeCandidates, setIncludeCandidates] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.wishlistShareStatus(wishlistId);
        if (!cancelled) setStatus(s);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wishlistId]);

  async function copy(text: string, said: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(said);
    } catch (e) {
      setError(e);
    }
  }

  async function onShare() {
    setBusy("share");
    setError(null);
    setNotice(null);
    try {
      const s = await api.shareWishlist(wishlistId, {
        includeNotes,
        includeCandidates,
      });
      setStatus(s);
      if (s.url) await copy(s.url, "Link copied. Paste it anywhere.");
      onChanged?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function onRevoke() {
    const ok = window.confirm(
      `Turn off the link for "${listName}"?\n\nAnyone you already sent it to ` +
        `will see an expired-link page. Your wishlist itself is not touched.`,
    );
    if (!ok) return;
    setBusy("revoke");
    setError(null);
    setNotice(null);
    try {
      const s = await api.revokeWishlistShare(wishlistId);
      setStatus(s);
      setNotice("Link turned off.");
      onChanged?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const shared = status?.url ?? null;
  const configured = status?.configured ?? false;

  return (
    <Modal
      title="Share this wishlist"
      description={listName}
      onClose={onClose}
      busy={busy !== null}
      size="max-w-lg"
      footer={
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          disabled={busy !== null}
        >
          Close
        </button>
      }
    >
      <div className="space-y-4">
        {error !== null && <ErrorBanner error={error} variant="inline" />}
        {notice && (
          <NoticeBanner variant="inline" tone="success" message={notice} />
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Public link</h3>
          <p className="text-xs text-fg-muted">
            Anyone with the link can see the list — there's no sign-in. Send it
            over text, Messenger, WhatsApp or email.
          </p>

          {status === null ? (
            error !== null ? null : (
              <p className="text-sm text-fg-muted">Loading…</p>
            )
          ) : !configured && !shared ? (
            <p className="text-xs text-fg-subtle">
              Sharing needs your own Cloudflare Worker. Add its URL and shared
              secret under Settings → Accounts, then come back. Copy as text
              below works without it.
            </p>
          ) : (
            <>
              <label className="flex items-start gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-current"
                  checked={includeNotes}
                  onChange={(e) => setIncludeNotes(e.target.checked)}
                  disabled={busy !== null}
                />
                <span>
                  Include my notes
                  <span className="block text-fg-subtle">
                    Off by default — notes are private to you.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-current"
                  checked={includeCandidates}
                  onChange={(e) => setIncludeCandidates(e.target.checked)}
                  disabled={busy !== null}
                />
                <span>
                  Include the listings I'm watching
                  <span className="block text-fg-subtle">
                    Shows prices and sellers.
                  </span>
                </span>
              </label>

              {shared && (
                <div className="rounded border border-border bg-bg-elevated px-3 py-2 text-xs">
                  <div className="font-mono break-all text-fg">{shared}</div>
                  {status?.expires_at !== null &&
                    status?.expires_at !== undefined && (
                      <div className="mt-1 text-fg-subtle">
                        Expires {formatDate(status.expires_at)}
                      </div>
                    )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  className="btn-primary !px-3 !py-1 !text-xs"
                  onClick={onShare}
                  disabled={busy !== null || !configured}
                  title={
                    shared
                      ? "Publish the list again and replace the current link"
                      : "Publish the list and copy its link"
                  }
                >
                  {busy === "share"
                    ? "Publishing…"
                    : shared
                      ? "Re-share with these settings"
                      : "Create link"}
                </button>
                {shared && (
                  <>
                    <button
                      type="button"
                      className="btn-secondary !px-3 !py-1 !text-xs"
                      onClick={() => void copy(shared, "Link copied.")}
                      disabled={busy !== null}
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      className="link-danger text-xs"
                      onClick={onRevoke}
                      disabled={busy !== null}
                    >
                      {busy === "revoke" ? "Turning off…" : "Turn off link"}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </section>

        <section className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-medium">Copy as text</h3>
          <p className="text-xs text-fg-muted">
            Paste the list itself into a message. Needs no link and no setup.
          </p>
          <button
            type="button"
            className="btn-secondary !px-3 !py-1 !text-xs"
            onClick={() =>
              void copy(
                wishlistToText(listName, entries, {
                  includeNotes,
                  includeCandidates,
                  shareUrl: shared,
                }),
                "Wishlist copied as text.",
              )
            }
            disabled={busy !== null}
          >
            Copy as text
          </button>
        </section>
      </div>
    </Modal>
  );
}
