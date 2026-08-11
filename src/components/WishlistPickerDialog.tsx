import { FormEvent, useEffect, useState } from "react";
import { api, formatCount, type WishlistInfo } from "@/lib/tauri";
import { Modal } from "@/components/Modal";
import { ErrorBanner } from "@/components/ErrorBanner";

/**
 * Pick a wishlist to add the current Select-mode selection to (DCH-45),
 * with an inline "New wishlist…" that creates one at pick time.
 *
 * Creating is folded into the picker rather than sending the user to the
 * Wishlist page: the whole point of the flow is that they already have a
 * selection in hand, and losing it to go make a list is the thing that
 * would stop them using the feature.
 *
 * The dialog owns picking and creating only. What happens to the selection
 * afterwards — and what to say about listings that can't be wished for —
 * belongs to the caller, which is the one that knows the selection.
 */
export function WishlistPickerDialog({
  selectedCount,
  onPick,
  onClose,
}: {
  /** Shown in the description so the user can confirm what they're adding. */
  selectedCount: number;
  /** Chosen or freshly created list. The caller closes the dialog. */
  onPick: (wishlist: WishlistInfo) => void | Promise<void>;
  onClose: () => void;
}) {
  const [wishlists, setWishlists] = useState<WishlistInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lists = await api.listWishlists();
        if (!cancelled) setWishlists(lists);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(wishlist: WishlistInfo) {
    setBusy(true);
    setError(null);
    try {
      await onPick(wishlist);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createWishlist(name);
      await onPick(created);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add to wishlist"
      description={`${formatCount(selectedCount)} selected listing${
        selectedCount === 1 ? "" : "s"
      }`}
      onClose={onClose}
      busy={busy}
      size="max-w-md"
      footer={
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
      }
    >
      <div className="space-y-3">
        {error !== null && <ErrorBanner error={error} variant="inline" />}

        {wishlists === null ? (
          // A failed load leaves this null; the banner above is the state.
          error !== null ? null : (
            <p className="text-sm text-fg-muted">Loading…</p>
          )
        ) : (
          <ul className="space-y-1">
            {wishlists.map((w) => (
              <li key={w.wishlist_id}>
                <button
                  type="button"
                  className="w-full flex items-center justify-between gap-3 rounded border border-border px-3 py-2 text-left text-sm hover:bg-bg-elevated disabled:opacity-50"
                  onClick={() => void pick(w)}
                  disabled={busy}
                >
                  <span className="truncate">{w.name}</span>
                  <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                    {formatCount(w.entry_count)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {creating ? (
          <form onSubmit={onCreate} className="flex items-center gap-2">
            <input
              type="text"
              className="input !py-1 !text-sm"
              placeholder="New wishlist name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={busy}
              autoFocus
            />
            <button
              type="submit"
              className="btn-primary !px-3 !py-1 !text-xs shrink-0"
              disabled={busy || newName.trim() === ""}
            >
              {busy ? "Creating…" : "Create & add"}
            </button>
            <button
              type="button"
              className="text-xs text-fg-subtle hover:text-fg shrink-0"
              onClick={() => {
                setCreating(false);
                setNewName("");
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-fg-subtle hover:text-fg hover:bg-bg-elevated disabled:opacity-50"
            onClick={() => setCreating(true)}
            disabled={busy || wishlists === null}
          >
            + New wishlist…
          </button>
        )}
      </div>
    </Modal>
  );
}
