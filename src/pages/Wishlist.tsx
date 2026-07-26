import { useEffect, useMemo, useRef, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  formatCents,
  type ListingRow,
  type WishlistEntry,
  type WishlistInfo,
  type WishlistListing,
} from "@/lib/tauri";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";
import { ViewLink } from "@/components/ViewLink";
import { useMinimized, MinimizeToggle } from "@/lib/minimized";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

const DCR_BASE = "https://www.diecastregistry.com";

/** Nearest ancestor that actually scrolls vertically — in the split-view
 *  workspace that's the pane body (`overflow-auto`), not the window. */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/** Which list was last viewed, so the page reopens where the user left. */
const ACTIVE_LIST_KEY = "wishlist.activeList";

/**
 * Registry entries the user wants to acquire, organized into named
 * wishlists (tabs). Entries are added from the Registry search page; each
 * wish can collect candidate saved listings (eBay / FB Marketplace) via
 * the "Link listing…" picker.
 */
export function Wishlist() {
  const [lists, setLists] = useState<WishlistInfo[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [entries, setEntries] = useState<WishlistEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [imgSize, setImgSize] = useImageSize("wishlist");
  const [linkTarget, setLinkTarget] = useState<WishlistEntry | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const dragYRef = useRef<number | null>(null);
  // List-management editor state: "create" shows the new-list input,
  // "rename" edits the active list's name, "delete" is the two-step
  // delete confirmation. Only one is open at a time.
  const [listEditor, setListEditor] = useState<
    "create" | "rename" | "delete" | null
  >(null);
  const [nameDraft, setNameDraft] = useState("");

  const activeList = lists?.find((l) => l.wishlist_id === activeId) ?? null;

  // Auto-scroll the pane while a drag hovers near its top or bottom edge.
  // dragover only fires over our own elements, so track the cursor with a
  // document-level listener and scroll from a rAF loop — that keeps the
  // scroll smooth even while the pointer is parked in the edge zone.
  useEffect(() => {
    if (draggingId === null) return;
    const onDocDragOver = (e: DragEvent) => {
      dragYRef.current = e.clientY;
    };
    document.addEventListener("dragover", onDocDragOver);
    const scroller = findScrollParent(listRef.current);
    const EDGE = 90; // px zone at each edge that triggers scrolling
    const MAX_STEP = 22; // px per frame at full speed
    let raf = 0;
    const step = () => {
      const y = dragYRef.current;
      if (y !== null && scroller) {
        const rect = scroller.getBoundingClientRect();
        const fromTop = y - rect.top;
        const fromBottom = rect.bottom - y;
        if (fromTop < EDGE) {
          scroller.scrollTop -=
            Math.ceil(((EDGE - Math.max(fromTop, 0)) / EDGE) * MAX_STEP);
        } else if (fromBottom < EDGE) {
          scroller.scrollTop +=
            Math.ceil(((EDGE - Math.max(fromBottom, 0)) / EDGE) * MAX_STEP);
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      document.removeEventListener("dragover", onDocDragOver);
      cancelAnimationFrame(raf);
      dragYRef.current = null;
    };
  }, [draggingId]);

  useEffect(() => {
    void init();
  }, []);

  async function init() {
    setError(null);
    try {
      const ls = await api.listWishlists();
      setLists(ls);
      const stored = Number(
        window.localStorage.getItem(ACTIVE_LIST_KEY) ?? NaN,
      );
      const valid = ls.some((l) => l.wishlist_id === stored)
        ? stored
        : (ls[0]?.wishlist_id ?? null);
      setActiveId(valid);
      if (valid !== null) setEntries(await api.listWishlist(valid));
    } catch (e) {
      setError(String(e));
    }
  }

  /** Refresh the active list's entries plus the tab counts. */
  async function reload(listId: number | null = activeId) {
    setError(null);
    try {
      const [ls, es] = await Promise.all([
        api.listWishlists(),
        listId !== null ? api.listWishlist(listId) : Promise.resolve(null),
      ]);
      setLists(ls);
      setEntries(es);
    } catch (e) {
      setError(String(e));
    }
  }

  async function selectList(id: number) {
    if (id === activeId) return;
    setActiveId(id);
    setListEditor(null);
    setEntries(null);
    window.localStorage.setItem(ACTIVE_LIST_KEY, String(id));
    await reload(id);
  }

  async function onCreateList() {
    const name = nameDraft.trim();
    if (!name) return;
    setError(null);
    try {
      const created = await api.createWishlist(name);
      setListEditor(null);
      setNameDraft("");
      setActiveId(created.wishlist_id);
      window.localStorage.setItem(
        ACTIVE_LIST_KEY,
        String(created.wishlist_id),
      );
      await reload(created.wishlist_id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRenameList() {
    if (activeId === null) return;
    const name = nameDraft.trim();
    if (!name) return;
    setError(null);
    try {
      await api.renameWishlist(activeId, name);
      setListEditor(null);
      setNameDraft("");
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDeleteList() {
    if (activeId === null) return;
    setError(null);
    try {
      await api.deleteWishlist(activeId);
      setListEditor(null);
      // Fall back to the first remaining list.
      const ls = await api.listWishlists();
      setLists(ls);
      const next = ls[0]?.wishlist_id ?? null;
      setActiveId(next);
      if (next !== null) {
        window.localStorage.setItem(ACTIVE_LIST_KEY, String(next));
        setEntries(await api.listWishlist(next));
      } else {
        setEntries(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRemove(entry: WishlistEntry) {
    setError(null);
    try {
      await api.removeWishlistEntry(entry.entry_id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onMove(entry: WishlistEntry, targetListId: number) {
    setError(null);
    try {
      await api.moveWishlistEntry(entry.entry_id, targetListId);
      await reload();
    } catch (e) {
      setError(String(e));
      await reload();
    }
  }

  async function onUnlink(entry: WishlistEntry, listingId: number) {
    setError(null);
    try {
      await api.unlinkListingFromWishlist(entry.entry_id, listingId);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  /** Live-reorder the local list while the dragged card hovers another
   *  card. Nothing is persisted until the drag ends. */
  function onDragOverEntry(overId: number) {
    if (draggingId === null || draggingId === overId) return;
    setEntries((prev) => {
      if (!prev) return prev;
      const from = prev.findIndex((e) => e.entry_id === draggingId);
      const to = prev.findIndex((e) => e.entry_id === overId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  /** Persist the order shown on screen as the new stack rank. */
  async function onDragEnd() {
    if (draggingId === null) return;
    setDraggingId(null);
    if (!entries) return;
    try {
      await api.reorderWishlist(entries.map((e) => e.entry_id));
    } catch (e) {
      setError(String(e));
      await reload();
    }
  }

  /** Jump an entry straight to rank #1 or the end of the list. */
  async function onSendTo(entry: WishlistEntry, where: "top" | "bottom") {
    if (!entries) return;
    const rest = entries.filter((e) => e.entry_id !== entry.entry_id);
    const next = where === "top" ? [entry, ...rest] : [...rest, entry];
    setEntries(next);
    try {
      await api.reorderWishlist(next.map((e) => e.entry_id));
    } catch (e) {
      setError(String(e));
      await reload();
    }
  }

  /** Export the wishlist to a self-contained, print-friendly HTML file,
   *  then open it in the default browser so it can go straight to print. */
  async function onExport() {
    if (activeId === null || !entries || entries.length === 0) return;
    const slug = (activeList?.name ?? "wishlist")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const path = await saveDialog({
      title: "Export wishlist",
      defaultPath: `${slug || "wishlist"}.html`,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!path) return;
    setExporting(true);
    setError(null);
    setInfo(null);
    try {
      const summary = await api.exportWishlistHtml(activeId, path);
      setInfo(
        `Exported ${summary.entries} entr${summary.entries === 1 ? "y" : "ies"} to ${summary.path}` +
          (summary.images_failed > 0
            ? ` (${summary.images_failed} image${summary.images_failed === 1 ? "" : "s"} could not be downloaded).`
            : ".") +
          " Opening in your browser — print from there.",
      );
      void openExternal(summary.path);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Wishlist</h2>
          <p className="text-sm text-fg-subtle">
            Registry entries you're hunting for. Add entries from{" "}
            <ViewLink to="/registry" className="text-accent hover:underline">
              Registry search
            </ViewLink>
            , then link saved listings as purchase candidates.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            className="btn-secondary"
            type="button"
            onClick={onExport}
            disabled={exporting || !entries || entries.length === 0}
            title={
              entries && entries.length > 0
                ? "Save the wishlist as a print-friendly HTML file (images embedded) and open it for printing"
                : "Nothing to export yet"
            }
          >
            {exporting ? "Exporting…" : "Export / Print…"}
          </button>
          <ImageSizeToggle size={imgSize} onChange={setImgSize} />
        </div>
      </header>

      {lists !== null && (
        <div className="flex flex-wrap items-center gap-1.5">
          {lists.map((l) => (
            <button
              key={l.wishlist_id}
              type="button"
              onClick={() => void selectList(l.wishlist_id)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                l.wishlist_id === activeId
                  ? "border-accent bg-bg-elevated text-fg"
                  : "border-border text-fg-muted hover:text-fg hover:bg-bg-elevated"
              }`}
              title={`Show "${l.name}"`}
            >
              {l.name}{" "}
              <span className="text-fg-faint tabular-nums">
                ({l.entry_count})
              </span>
            </button>
          ))}
          {listEditor === "create" ? (
            <ListNameForm
              value={nameDraft}
              onChange={setNameDraft}
              placeholder="New list name"
              submitLabel="Create"
              onSubmit={onCreateList}
              onCancel={() => {
                setListEditor(null);
                setNameDraft("");
              }}
            />
          ) : (
            <button
              type="button"
              className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-fg-subtle hover:text-fg hover:bg-bg-elevated"
              onClick={() => {
                setListEditor("create");
                setNameDraft("");
              }}
              title="Create a new wishlist"
            >
              + New list
            </button>
          )}

          {activeList && listEditor !== "create" && (
            <span className="ml-2 flex items-center gap-2 text-xs">
              {listEditor === "rename" ? (
                <ListNameForm
                  value={nameDraft}
                  onChange={setNameDraft}
                  placeholder="List name"
                  submitLabel="Rename"
                  onSubmit={onRenameList}
                  onCancel={() => {
                    setListEditor(null);
                    setNameDraft("");
                  }}
                />
              ) : listEditor === "delete" ? (
                <>
                  <span className="text-red-300">
                    Delete "{activeList.name}" and its {activeList.entry_count}{" "}
                    entr{activeList.entry_count === 1 ? "y" : "ies"}?
                  </span>
                  <button
                    type="button"
                    className="text-red-400 hover:underline"
                    onClick={() => void onDeleteList()}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="text-fg-subtle hover:text-fg"
                    onClick={() => setListEditor(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="text-fg-subtle hover:text-fg"
                    onClick={() => {
                      setListEditor("rename");
                      setNameDraft(activeList.name);
                    }}
                    title="Rename this wishlist"
                  >
                    Rename
                  </button>
                  {lists.length > 1 && (
                    <button
                      type="button"
                      className="text-fg-subtle hover:text-red-400"
                      onClick={() => setListEditor("delete")}
                      title="Delete this wishlist and its entries"
                    >
                      Delete list
                    </button>
                  )}
                </>
              )}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}
      {info && <div className="card text-sm text-emerald-400">{info}</div>}

      {lists === null || entries === null ? (
        <div className="card text-sm text-fg-muted">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          Nothing on "{activeList?.name ?? "this list"}" yet. Use the "Add to
          wishlist" action on a registry search result to start the list.
        </div>
      ) : (
        <>
          <div className="text-xs text-fg-subtle">
            {entries.length} entr{entries.length === 1 ? "y" : "ies"}.
            {entries.length > 1 && (
              <span className="ml-2 text-fg-faint">
                Drag the ⠿ handle to stack-rank by priority.
              </span>
            )}
          </div>
          <ul className="space-y-2" ref={listRef}>
            {entries.map((entry, i) => (
              <WishlistCard
                key={entry.entry_id}
                entry={entry}
                rank={i + 1}
                total={entries.length}
                otherLists={(lists ?? []).filter(
                  (l) => l.wishlist_id !== activeId,
                )}
                onMove={(targetListId) => void onMove(entry, targetListId)}
                dragging={draggingId === entry.entry_id}
                onDragStart={() => setDraggingId(entry.entry_id)}
                onDragOverCard={() => onDragOverEntry(entry.entry_id)}
                onDragEnd={onDragEnd}
                onSendTop={() => onSendTo(entry, "top")}
                onSendBottom={() => onSendTo(entry, "bottom")}
                imgSize={imgSize}
                onRemove={() => onRemove(entry)}
                onLink={() => setLinkTarget(entry)}
                onUnlink={(listingId) => onUnlink(entry, listingId)}
                onNotesSaved={reload}
                onError={setError}
              />
            ))}
          </ul>
        </>
      )}

      {linkTarget && (
        <LinkListingModal
          entry={linkTarget}
          onClose={() => setLinkTarget(null)}
          onLinked={async () => {
            setLinkTarget(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function WishlistCard({
  entry,
  rank,
  total,
  otherLists,
  onMove,
  dragging,
  onDragStart,
  onDragOverCard,
  onDragEnd,
  onSendTop,
  onSendBottom,
  imgSize,
  onRemove,
  onLink,
  onUnlink,
  onNotesSaved,
  onError,
}: {
  entry: WishlistEntry;
  /** 1-based display position = stack-rank priority. */
  rank: number;
  /** Total entries — for disabling the top/bottom jumps at the ends. */
  total: number;
  /** The other wishlists this entry could move to. */
  otherLists: WishlistInfo[];
  onMove: (targetListId: number) => void;
  dragging: boolean;
  onDragStart: () => void;
  onDragOverCard: () => void;
  onDragEnd: () => void;
  onSendTop: () => void;
  onSendBottom: () => void;
  imgSize: ImageSize;
  onRemove: () => void;
  onLink: () => void;
  onUnlink: (listingId: number) => void;
  onNotesSaved: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState(entry.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);
  const [minimized, toggleMinimized] = useMinimized(
    `wishlist:${entry.entry_id}`,
  );

  async function onSaveNotes() {
    setSavingNotes(true);
    try {
      const trimmed = notesDraft.trim();
      await api.setWishlistNotes(
        entry.entry_id,
        trimmed === "" ? null : trimmed,
      );
      setEditingNotes(false);
      await onNotesSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSavingNotes(false);
    }
  }

  return (
    <li
      className={`card space-y-3 ${minimized ? "!py-2" : ""} ${
        dragging ? "opacity-50 border-accent" : ""
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOverCard();
      }}
      onDrop={(e) => e.preventDefault()}
    >
      <div className="flex items-start gap-4">
        <div className="flex flex-col items-center gap-0.5 shrink-0 select-none">
          <span
            className="text-[11px] font-semibold tabular-nums text-fg-subtle"
            title="Stack-rank priority"
          >
            #{rank}
          </span>
          <button
            type="button"
            onClick={onSendTop}
            disabled={rank === 1}
            className="text-fg-faint hover:text-fg-muted disabled:opacity-30 disabled:hover:text-fg-faint px-1"
            title="Send to top"
            aria-label="Send to top"
          >
            <ToLineIcon direction="up" />
          </button>
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(entry.entry_id));
              // Show the whole card as the drag ghost, not just the grip.
              const li = (e.currentTarget as HTMLElement).closest("li");
              if (li) e.dataTransfer.setDragImage(li, 24, 24);
              // Deferred so the opacity/border restyle of the source card
              // doesn't cancel the native drag in WebKit.
              setTimeout(onDragStart, 0);
            }}
            onDragEnd={onDragEnd}
            className="cursor-grab active:cursor-grabbing text-fg-faint hover:text-fg-muted px-1"
            title="Drag to change priority"
            aria-label="Drag to change priority"
          >
            <GripIcon />
          </div>
          <button
            type="button"
            onClick={onSendBottom}
            disabled={rank === total}
            className="text-fg-faint hover:text-fg-muted disabled:opacity-30 disabled:hover:text-fg-faint px-1"
            title="Send to bottom"
            aria-label="Send to bottom"
          >
            <ToLineIcon direction="down" />
          </button>
        </div>
        {!minimized &&
          (entry.image_url ? (
            <img
              src={
                entry.image_url.startsWith("http")
                  ? entry.image_url
                  : DCR_BASE + entry.image_url
              }
              alt=""
              loading="lazy"
              className={`${IMG_CLASS[imgSize]} object-cover rounded border border-border shrink-0`}
            />
          ) : (
            <div
              className={`${IMG_CLASS[imgSize]} rounded border border-border bg-bg shrink-0`}
            />
          ))}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            <MinimizeToggle
              minimized={minimized}
              onToggle={toggleMinimized}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">
                {entry.driver_name ?? "(unknown driver)"}
                {entry.year && (
                  <span className="text-fg-subtle ml-2">{entry.year}</span>
                )}
              </div>
              <div className="text-xs text-fg-muted truncate mt-0.5">
                {entry.scheme_text ?? "(no scheme)"}
                {minimized && entry.listings.length > 0 && (
                  <span className="text-fg-faint">
                    {" "}
                    · {entry.listings.length} linked listing
                    {entry.listings.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>
          </div>
          {!minimized && (
          <>
          <div className="text-xs text-fg-subtle mt-0.5">
            {[entry.oem, entry.brand, entry.scale, entry.make]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {entry.production_qty !== null && (
            <div className="text-xs text-fg-faint mt-0.5">
              production qty {entry.production_qty.toLocaleString()}
            </div>
          )}
          <div className="flex items-center gap-3 mt-1">
            {entry.detail_url && (
              <a
                className="text-xs text-accent hover:underline"
                href={DCR_BASE + entry.detail_url}
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(DCR_BASE + entry.detail_url!);
                }}
              >
                View on diecastregistry.com →
              </a>
            )}
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              onClick={onLink}
              title="Pick a saved listing as a purchase candidate for this wish"
            >
              + Link listing
            </button>
            {otherLists.length > 0 && (
              <select
                className="input !w-auto !py-0 !text-xs !text-accent cursor-pointer"
                value=""
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v) onMove(v);
                }}
                title="Move this entry to another wishlist"
              >
                <option value="">Move to…</option>
                {otherLists.map((l) => (
                  <option key={l.wishlist_id} value={l.wishlist_id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="text-xs text-fg-subtle hover:text-red-400"
              onClick={onRemove}
              title="Remove this entry from the wishlist"
            >
              Remove
            </button>
          </div>
          </>
          )}
        </div>
        <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
          <div className="text-base text-fg">
            {formatCents(entry.retail_value_cents)}
          </div>
          {!minimized && (
            <div className="text-fg-subtle">
              wholesale {formatCents(entry.wholesale_value_cents)}
            </div>
          )}
        </div>
      </div>

      {!minimized && (
      <div className="border-t border-border pt-2">
        {editingNotes ? (
          <div className="space-y-2">
            <textarea
              className="input"
              rows={2}
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder="Notes (max price, variants to avoid, …)"
              disabled={savingNotes}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-primary !py-1 !text-xs"
                onClick={onSaveNotes}
                disabled={savingNotes}
              >
                {savingNotes ? "Saving…" : "Save notes"}
              </button>
              <button
                type="button"
                className="btn-secondary !py-1 !text-xs"
                onClick={() => {
                  setNotesDraft(entry.notes ?? "");
                  setEditingNotes(false);
                }}
                disabled={savingNotes}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="text-left w-full text-xs text-fg-muted hover:text-fg"
            onClick={() => setEditingNotes(true)}
            title="Edit notes"
          >
            {entry.notes ? (
              <span className="whitespace-pre-wrap">{entry.notes}</span>
            ) : (
              <span className="text-fg-faint italic">Add notes…</span>
            )}
          </button>
        )}
      </div>
      )}

      {!minimized && entry.listings.length > 0 && (
        <div className="border-t border-border pt-2 space-y-1.5">
          <div className="text-xs text-fg-subtle">
            {entry.listings.length} linked listing
            {entry.listings.length === 1 ? "" : "s"}
          </div>
          {entry.listings.map((l) => (
            <LinkedListingRow
              key={l.listing_id}
              listing={l}
              onUnlink={() => onUnlink(l.listing_id)}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/** Inline name input + submit/cancel, shared by "new list" and "rename". */
function ListNameForm({
  value,
  onChange,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  submitLabel: string;
  onSubmit: () => Promise<void> | void;
  onCancel: () => void;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="text"
        className="input !w-40 !py-0.5 !text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        maxLength={80}
        autoFocus
      />
      <button
        type="button"
        className="text-xs text-accent hover:underline disabled:opacity-40"
        onClick={() => void onSubmit()}
        disabled={value.trim() === ""}
      >
        {submitLabel}
      </button>
      <button
        type="button"
        className="text-xs text-fg-subtle hover:text-fg"
        onClick={onCancel}
      >
        Cancel
      </button>
    </span>
  );
}

function ToLineIcon({ direction }: { direction: "up" | "down" }) {
  // Chevron pointing at a line — "jump to end".
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={direction === "down" ? { transform: "rotate(180deg)" } : undefined}
    >
      <line x1="5" y1="4" x2="19" y2="4" />
      <polyline points="6 15 12 9 18 15" />
    </svg>
  );
}

function GripIcon() {
  // Six-dot drag grip.
  return (
    <svg
      width="12"
      height="16"
      viewBox="0 0 12 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="3.5" cy="3" r="1.4" />
      <circle cx="8.5" cy="3" r="1.4" />
      <circle cx="3.5" cy="8" r="1.4" />
      <circle cx="8.5" cy="8" r="1.4" />
      <circle cx="3.5" cy="13" r="1.4" />
      <circle cx="8.5" cy="13" r="1.4" />
    </svg>
  );
}

function LinkedListingRow({
  listing,
  onUnlink,
}: {
  listing: WishlistListing;
  onUnlink: () => void;
}) {
  const total =
    listing.price_cents !== null
      ? listing.price_cents + (listing.shipping_cents ?? 0)
      : null;
  const ended = listing.status !== "active";
  return (
    <div className="flex items-center gap-3 text-xs">
      {listing.image_url ? (
        <img
          src={listing.image_url}
          alt=""
          loading="lazy"
          className="w-10 h-10 object-cover rounded border border-border shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded border border-border bg-bg shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <a
          className={`truncate block hover:underline ${
            ended ? "text-fg-subtle line-through" : "text-accent"
          }`}
          href={listing.url}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(listing.url);
          }}
          title={listing.title}
        >
          {listing.title}
        </a>
        <div className="text-fg-subtle">
          {listing.seller_code === "ebay" ? "eBay" : "FB Marketplace"}
          {ended && <span className="ml-2">({listing.status})</span>}
        </div>
      </div>
      <div className="tabular-nums text-fg shrink-0">{formatCents(total)}</div>
      <button
        type="button"
        className="text-fg-subtle hover:text-red-400 shrink-0"
        onClick={onUnlink}
        title="Unlink this listing from the wish"
      >
        Unlink
      </button>
    </div>
  );
}

function LinkListingModal({
  entry,
  onClose,
  onLinked,
}: {
  entry: WishlistEntry;
  onClose: () => void;
  onLinked: () => Promise<void>;
}) {
  const [listings, setListings] = useState<ListingRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [linking, setLinking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listListings()
      .then(setListings)
      .catch((e) => setError(String(e)));
  }, []);

  const alreadyLinked = useMemo(
    () => new Set(entry.listings.map((l) => l.listing_id)),
    [entry],
  );

  const filtered = useMemo(() => {
    if (!listings) return null;
    const q = query.trim().toLowerCase();
    const matches = q
      ? listings.filter((l) => l.title.toLowerCase().includes(q))
      : listings;
    // Active listings first, then most recently seen — same order as the
    // Listings page.
    return matches.slice(0, 50);
  }, [listings, query]);

  async function onPick(listing: ListingRow) {
    setLinking(listing.listing_id);
    setError(null);
    try {
      await api.linkListingToWishlist(entry.entry_id, listing.listing_id);
      await onLinked();
    } catch (e) {
      setError(String(e));
      setLinking(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && linking === null) onClose();
      }}
    >
      <div
        className="card w-full max-w-2xl max-h-[80vh] flex flex-col space-y-3"
        role="dialog"
        aria-modal="true"
      >
        <header>
          <h3 className="text-lg font-semibold">Link a saved listing</h3>
          <div className="text-xs text-fg-muted mt-0.5 truncate">
            {entry.driver_name ?? "(unknown driver)"}
            {entry.year && (
              <span className="ml-2 text-fg-subtle">{entry.year}</span>
            )}
            {entry.scheme_text && (
              <span className="ml-2 text-fg-subtle">{entry.scheme_text}</span>
            )}
          </div>
        </header>

        <input
          type="text"
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter saved listings by title…"
          autoFocus
        />

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5">
          {filtered === null ? (
            <div className="text-sm text-fg-muted">Loading listings…</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-fg-muted">
              No saved listings match.
            </div>
          ) : (
            filtered.map((l) => {
              const linked = alreadyLinked.has(l.listing_id);
              const total =
                l.price_cents !== null
                  ? l.price_cents + (l.shipping_cents ?? 0)
                  : null;
              return (
                <div
                  key={l.listing_id}
                  className="flex items-center gap-3 text-xs border border-border rounded p-2"
                >
                  {l.image_url ? (
                    <img
                      src={l.image_url}
                      alt=""
                      loading="lazy"
                      className="w-12 h-12 object-cover rounded border border-border shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded border border-border bg-bg shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate" title={l.title}>
                      {l.title}
                    </div>
                    <div className="text-fg-subtle">
                      {l.seller_code === "ebay" ? "eBay" : "FB Marketplace"}
                      {l.status !== "active" && (
                        <span className="ml-2">({l.status})</span>
                      )}
                    </div>
                  </div>
                  <div className="tabular-nums shrink-0">
                    {formatCents(total)}
                  </div>
                  <button
                    type="button"
                    className="btn-secondary !py-1 !text-xs shrink-0"
                    onClick={() => onPick(l)}
                    disabled={linked || linking !== null}
                  >
                    {linked
                      ? "Linked"
                      : linking === l.listing_id
                        ? "Linking…"
                        : "Link"}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={linking !== null}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
