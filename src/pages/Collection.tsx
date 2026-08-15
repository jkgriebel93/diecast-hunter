import { useEffect, useMemo, useState } from "react";
import { ErrorBanner } from "@/components/ErrorBanner";
import { ManualEntryDialog } from "@/components/ManualEntryDialog";
import { findLocalDuplicates } from "@/lib/localEntry";
import { YearRangeFilter } from "@/components/YearRangeFilter";
import {
  EMPTY_YEAR_RANGE,
  inYearRange,
  isEmptyRange,
  type YearRange,
} from "@/lib/yearRange";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  filterAllowedScales,
  formatCents,
  formatCount,
  type CollectionRow,
} from "@/lib/tauri";
import { useImageSize, type ImageSize } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";
import {
  MinimizeToggle,
  setManyMinimized,
  useMinimized,
  useMinimizedSet,
} from "@/lib/minimized";

const IMG_CLASS: Record<ImageSize, string> = {
  sm: "w-24 h-24",
  md: "w-48 h-48",
  lg: "w-72 h-72",
};

const DCR_BASE = "https://www.diecastregistry.com";

type SortMode =
  "driver-asc" | "value-desc" | "count-desc" | "year-desc" | "year-asc";

interface DriverGroupView {
  driver_id: number | null;
  driver_name: string;
  items: CollectionRow[];
  retail_total_cents: number;
  wholesale_total_cents: number;
  /** Sum of what the user paid, across the items that record a price.
   *  Shown next to retail because a manually-added car has no registry
   *  appraisal and so contributes $0 to the retail total — without the cost
   *  figure beside it, that zero reads as a defect rather than as "not
   *  appraised". */
  cost_total_cents: number;
  /** Whether any item in the group records a purchase price at all. Groups
   *  with none don't get a cost figure — an unconditional "$0.00" would be
   *  the same confusing zero, one column over. */
  has_cost: boolean;
}

/**
 * Expand/Collapse-all for the flat (ungrouped) view. This component — not
 * Collection() — subscribes to the shared minimized store: the store emits
 * on every card toggle on every page, and pages stay mounted in hidden
 * workspace tabs, so a page-level subscription would re-render the entire
 * collection list (images and all) on each toggle anywhere in the app.
 */
function FlatExpandAllButton({ items }: { items: CollectionRow[] }) {
  const minimizedSet = useMinimizedSet();
  const allExpanded =
    items.length > 0 &&
    items.every((i) => !minimizedSet.has(`collection:${i.collection_id}`));
  return (
    <button
      type="button"
      className="text-xs text-fg-subtle hover:text-fg"
      onClick={() =>
        setManyMinimized(
          items.map((i) => `collection:${i.collection_id}`),
          allExpanded,
        )
      }
    >
      {allExpanded ? "Collapse all" : "Expand all"}
    </button>
  );
}

export function Collection() {
  const [items, setItems] = useState<CollectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number | string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  /** Neutral informational banner (e.g. "wasn't on DCR") — not an error. */
  const [notice, setNotice] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [searchText, setSearchText] = useState("");
  const [driverFilter, setDriverFilter] = useState<string>("");
  const [scaleFilter, setScaleFilter] = useState<string>("");
  const [oemFilter, setOemFilter] = useState<string>("");
  const [yearFilter, setYearFilter] = useState<YearRange>(EMPTY_YEAR_RANGE);
  const [exporting, setExporting] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("driver-asc");
  const [groupByDriver, setGroupByDriver] = useGroupByDriver();
  const [imgSize, setImgSize] = useImageSize("collection");
  /** null = closed. "new" = adding; a row = editing that row. */
  const [manualEntry, setManualEntry] = useState<CollectionRow | "new" | null>(
    null,
  );

  async function load() {
    setError(null);
    try {
      const list = await api.listAllCollectionItems();
      setItems(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onSync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    setSuccessMsg(null);
    try {
      const summary = await api.syncDcrCollection(false);
      const parts = [
        `Synced ${summary.items_seen} item${summary.items_seen === 1 ? "" : "s"} from diecastregistry.com.`,
      ];
      if (summary.collection_rows_removed > 0) {
        parts.push(
          `Removed ${summary.collection_rows_removed} entr${
            summary.collection_rows_removed === 1 ? "y" : "ies"
          } no longer in your garage.`,
        );
      }
      setSuccessMsg(parts.join(" "));
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function onRemove(item: CollectionRow) {
    const label = item.scheme_text ?? item.driver_name ?? "this diecast";
    // A manual entry was never on DCR, so warning about deleting it there
    // would be describing something that isn't going to happen.
    const ok = window.confirm(
      item.is_local
        ? `Remove "${label}" from your collection?\n\n` +
            "It was added by hand, so nothing on diecastregistry.com changes."
        : `Remove "${label}" from your collection?\n\n` +
            "This also deletes it from your diecastregistry.com garage, which " +
            "cannot be undone.",
    );
    if (!ok) return;
    setRemovingId(item.collection_id);
    setError(null);
    setNotice(null);
    setSuccessMsg(null);
    try {
      const result = await api.removeCollectionEntry(item.collection_id);
      if (result.found_on_dcr) {
        setSuccessMsg(
          `Removed "${label}" from your diecastregistry.com garage and local collection.`,
        );
      } else if (result.was_local) {
        // Expected outcome, not a shortfall — no DCR call was made.
        setSuccessMsg(`Removed "${label}" from your collection.`);
      } else {
        setNotice(
          `"${label}" wasn't in your diecastregistry.com garage — removed the local entry.`,
        );
      }
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemovingId(null);
    }
  }

  /** Export the currently displayed rows (post-filter, in displayed order)
   *  as a print-friendly HTML file (images embedded, opened in the browser
   *  for printing) or a CSV spreadsheet. */
  async function onExport(format: "html" | "csv") {
    const rows = groupByDriver
      ? (groups ?? []).flatMap((g) => g.items)
      : (flatItems ?? []);
    if (rows.length === 0) return;
    const path = await saveDialog({
      title: format === "csv" ? "Export collection CSV" : "Export collection",
      defaultPath: `my-collection.${format}`,
      filters:
        format === "csv"
          ? [{ name: "CSV", extensions: ["csv"] }]
          : [{ name: "HTML", extensions: ["html"] }],
    });
    if (!path) return;
    setExporting(true);
    setError(null);
    setNotice(null);
    setSuccessMsg(null);
    try {
      const summary =
        format === "csv"
          ? await api.exportCollectionCsv(rows, path)
          : await api.exportCollectionHtml(rows, path);
      setSuccessMsg(
        `Exported ${summary.entries} item${summary.entries === 1 ? "" : "s"} to ${summary.path}` +
          (summary.images_failed > 0
            ? ` (${summary.images_failed} image${summary.images_failed === 1 ? "" : "s"} could not be downloaded).`
            : ".") +
          (format === "html"
            ? " Opening in your browser — print from there."
            : ""),
      );
      if (format === "html") void openExternal(summary.path);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  // Distinct driver names / scales / OEMs for filter dropdowns. Scales are
  // limited to the standard model sizes we surface everywhere
  // (1:18, 1:24, 1:32, 1:64).
  const driverNames = useMemo(() => {
    const set = new Set<string>();
    for (const i of items ?? []) set.add(i.driver_name ?? "(unknown)");
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const scales = useMemo(() => {
    const set = new Set<string>();
    for (const i of items ?? []) if (i.scale) set.add(i.scale);
    return filterAllowedScales(Array.from(set));
  }, [items]);

  const oems = useMemo(() => {
    const set = new Set<string>();
    for (const i of items ?? []) if (i.oem) set.add(i.oem);
    return Array.from(set).sort();
  }, [items]);

  /** Release years present in the collection, newest-first. Derived from the
   *  items so the range dropdowns only offer years you actually own. */
  const yearOptions = useMemo(() => {
    const set = new Set<number>();
    for (const i of items ?? []) if (i.year != null) set.add(i.year);
    return Array.from(set)
      .sort((a, b) => b - a)
      .map(String);
  }, [items]);

  // Apply the search + scale/OEM filters once; both the grouped and flat
  // views derive from this.
  const filtered: CollectionRow[] | null = useMemo(() => {
    if (!items) return null;
    const q = searchText.trim().toLowerCase();
    return items.filter((it) => {
      if (q) {
        const hay = [
          it.driver_name,
          it.scheme_text,
          it.oem,
          it.brand,
          it.scale,
          it.make,
          it.year != null ? String(it.year) : null,
          it.car_number,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (driverFilter && (it.driver_name ?? "(unknown)") !== driverFilter)
        return false;
      if (scaleFilter && it.scale !== scaleFilter) return false;
      if (oemFilter && it.oem !== oemFilter) return false;
      // `year` is the release year the registry records. Entries without one
      // drop out as soon as a bound is set — see inYearRange.
      if (!inYearRange(it.year, yearFilter)) return false;
      return true;
    });
  }, [items, searchText, driverFilter, scaleFilter, oemFilter, yearFilter]);

  // Group filtered items by driver, then sort groups.
  const groups: DriverGroupView[] | null = useMemo(() => {
    if (!filtered) return null;

    const map = new Map<string, DriverGroupView>();
    for (const it of filtered) {
      const key =
        it.driver_id != null
          ? `id:${it.driver_id}`
          : `name:${it.driver_name ?? "(unknown)"}`;
      let g = map.get(key);
      if (!g) {
        g = {
          driver_id: it.driver_id,
          driver_name: it.driver_name ?? "(unknown)",
          items: [],
          retail_total_cents: 0,
          wholesale_total_cents: 0,
          cost_total_cents: 0,
          has_cost: false,
        };
        map.set(key, g);
      }
      g.items.push(it);
      g.retail_total_cents += it.retail_value_cents ?? 0;
      g.wholesale_total_cents += it.wholesale_value_cents ?? 0;
      if (it.paid_cents != null) {
        g.cost_total_cents += it.paid_cents;
        g.has_cost = true;
      }
    }

    // Sort items within each group by year desc (consistent with the
    // server's previous list_collection_for_driver ordering).
    for (const g of map.values()) {
      g.items.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    }

    const list = Array.from(map.values());
    list.sort((a, b) => {
      switch (sortMode) {
        case "driver-asc":
          return a.driver_name.localeCompare(b.driver_name);
        case "value-desc":
          return b.retail_total_cents - a.retail_total_cents;
        case "count-desc":
          return b.items.length - a.items.length;
        case "year-desc":
          return (
            Math.max(...b.items.map((i) => i.year ?? 0)) -
            Math.max(...a.items.map((i) => i.year ?? 0))
          );
        case "year-asc":
          return (
            Math.min(...a.items.map((i) => i.year ?? 9999)) -
            Math.min(...b.items.map((i) => i.year ?? 9999))
          );
      }
    });
    return list;
  }, [filtered, sortMode]);

  // Flat (ungrouped) view of the filtered items, sorted to mirror the
  // group sort where it makes sense at the item level.
  const flatItems: CollectionRow[] | null = useMemo(() => {
    if (!filtered) return null;
    const list = [...filtered];
    list.sort((a, b) => {
      switch (sortMode) {
        case "value-desc":
          return (b.retail_value_cents ?? 0) - (a.retail_value_cents ?? 0);
        case "year-desc":
          return (b.year ?? 0) - (a.year ?? 0);
        case "year-asc":
          return (a.year ?? 9999) - (b.year ?? 9999);
        case "driver-asc":
        case "count-desc":
        default: {
          // Fall back to driver name, then newest year within a driver.
          const byName = (a.driver_name ?? "").localeCompare(
            b.driver_name ?? "",
          );
          if (byName !== 0) return byName;
          return (b.year ?? 0) - (a.year ?? 0);
        }
      }
    });
    return list;
  }, [filtered, sortMode]);

  function toggleGroup(key: number | string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Whether every group section is currently expanded — drives the grouped
  // view's Expand all / Collapse all button. The flat view's equivalent
  // lives in FlatExpandAllButton, which owns the minimized-store
  // subscription (see that component's comment).
  const allGroupsExpanded =
    (groups?.length ?? 0) > 0 &&
    (groups ?? []).every((g) => expanded.has(groupKey(g)));

  function toggleAllGroups() {
    setExpanded(
      allGroupsExpanded ? new Set() : new Set((groups ?? []).map(groupKey)),
    );
  }

  const totalItems = items?.length ?? 0;
  const filteredItems = filtered?.length ?? 0;

  // Computed over the *unfiltered* set: a duplicate that the current filters
  // hide is still a duplicate, and the flag would flicker off for no reason
  // the user can see.
  const duplicates = useMemo(() => findLocalDuplicates(items ?? []), [items]);

  return (
    <div className="p-6 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-2xl font-semibold">My Collection</h2>
          <p className="text-sm text-fg-subtle">
            Imported from diecastregistry.com
            {groupByDriver ? ", grouped by driver." : "."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {items && (
            <div className="text-xs text-fg-subtle">
              {filteredItems === totalItems
                ? groupByDriver
                  ? `${totalItems} items across ${groups?.length ?? 0} drivers`
                  : `${totalItems} items`
                : `${filteredItems} of ${totalItems} items shown`}
            </div>
          )}
          <button
            className="btn-secondary"
            type="button"
            disabled={exporting || filteredItems === 0}
            onClick={() => onExport("csv")}
            title={
              filteredItems > 0
                ? "Save the displayed items as a CSV spreadsheet"
                : "Nothing to export"
            }
          >
            Export CSV…
          </button>
          <button
            className="btn-secondary"
            type="button"
            disabled={exporting || filteredItems === 0}
            onClick={() => onExport("html")}
            title={
              filteredItems > 0
                ? "Save the displayed items as a print-friendly HTML file (images embedded) and open it for printing"
                : "Nothing to export"
            }
          >
            {exporting ? "Exporting…" : "Export / Print…"}
          </button>
          <button
            className="btn-secondary"
            type="button"
            disabled={syncing || removingId !== null}
            onClick={() => setManualEntry("new")}
            title="Add a car diecastregistry.com doesn't list. Stays local — nothing is added to your DCR garage."
          >
            Add manually…
          </button>
          <button
            className="btn-secondary"
            type="button"
            disabled={syncing || removingId !== null}
            onClick={onSync}
            title="Pull My Garage from diecastregistry.com. Local entries no longer in the garage are removed."
          >
            {syncing ? "Syncing…" : "Sync with DCR"}
          </button>
        </div>
      </header>

      {manualEntry && (
        <ManualEntryDialog
          editing={manualEntry === "new" ? null : manualEntry}
          driverNames={driverNames}
          onClose={() => setManualEntry(null)}
          onSaved={(message, partial) => {
            setManualEntry(null);
            setError(null);
            // A partial save is a shortfall, not a failure — the entry is in
            // the collection either way, so it must not be reported in the
            // colour that says "this didn't happen".
            setNotice(partial ? message : null);
            setSuccessMsg(partial ? null : message);
            void load();
          }}
        />
      )}

      {error && <ErrorBanner error={error} />}
      {notice && <div className="card text-sm text-fg-muted">{notice}</div>}
      {successMsg && (
        <div className="card text-sm text-emerald-400">{successMsg}</div>
      )}

      {items && items.length > 0 && (
        <div className="card !p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="input flex-1"
              placeholder="Search driver, scheme, year, OEM, brand, scale, car #…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <select
              className="input !w-auto"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              title={groupByDriver ? "Sort drivers" : "Sort items"}
            >
              <option value="driver-asc">Driver A → Z</option>
              <option value="value-desc">
                {groupByDriver ? "Total value high → low" : "Value high → low"}
              </option>
              {groupByDriver && (
                <option value="count-desc">Item count high → low</option>
              )}
              <option value="year-desc">Year newest → oldest</option>
              <option value="year-asc">Year oldest → newest</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs text-fg-subtle select-none w-fit">
            <input
              type="checkbox"
              checked={groupByDriver}
              onChange={(e) => setGroupByDriver(e.target.checked)}
            />
            Group by driver
          </label>
          <div className="flex items-center gap-3 text-xs flex-wrap">
            <label className="flex items-center gap-1">
              <span className="text-fg-subtle">Driver:</span>
              <select
                className="bg-bg-elevated border border-border rounded px-2 py-0.5 text-fg"
                value={driverFilter}
                onChange={(e) => setDriverFilter(e.target.value)}
              >
                <option value="">Any</option>
                {driverNames.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-fg-subtle">Scale:</span>
              <select
                className="bg-bg-elevated border border-border rounded px-2 py-0.5 text-fg"
                value={scaleFilter}
                onChange={(e) => setScaleFilter(e.target.value)}
              >
                <option value="">Any</option>
                {scales.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-fg-subtle">OEM:</span>
              <select
                className="bg-bg-elevated border border-border rounded px-2 py-0.5 text-fg"
                value={oemFilter}
                onChange={(e) => setOemFilter(e.target.value)}
              >
                <option value="">Any</option>
                {oems.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-fg-subtle">Year:</span>
              <YearRangeFilter
                id="collection-year"
                years={yearOptions}
                value={yearFilter}
                onChange={setYearFilter}
                selectClassName="bg-bg-elevated border border-border rounded px-2 py-0.5 text-fg"
              />
            </label>
            {(searchText ||
              driverFilter ||
              scaleFilter ||
              oemFilter ||
              !isEmptyRange(yearFilter)) && (
              <button
                type="button"
                className="text-fg-subtle hover:text-fg"
                onClick={() => {
                  setSearchText("");
                  setDriverFilter("");
                  setScaleFilter("");
                  setOemFilter("");
                  setYearFilter(EMPTY_YEAR_RANGE);
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}

      {items === null ? (
        // A failed load leaves this null forever; the error banner above
        // is the state, not "still loading".
        error ? null : (
          <div className="card text-sm text-fg-muted">Loading…</div>
        )
      ) : items.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          Empty. Configure your diecastregistry.com credentials in Settings,
          then run a sync — or use “Add manually…” for a car the registry
          doesn&apos;t list.
        </div>
      ) : filtered && filtered.length === 0 ? (
        <div className="card text-sm text-fg-muted">
          No items match the current filters.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            {groupByDriver ? (
              <button
                type="button"
                className="text-xs text-fg-subtle hover:text-fg"
                onClick={toggleAllGroups}
              >
                {allGroupsExpanded ? "Collapse all" : "Expand all"}
              </button>
            ) : (
              <FlatExpandAllButton items={flatItems ?? []} />
            )}
            <ImageSizeToggle size={imgSize} onChange={setImgSize} />
          </div>
          {groupByDriver ? (
            (groups ?? []).map((g) => {
              const key = groupKey(g);
              const isOpen = expanded.has(key);
              return (
                <DriverCard
                  key={key}
                  group={g}
                  expanded={isOpen}
                  onToggle={() => toggleGroup(key)}
                  imgSizeClass={IMG_CLASS[imgSize]}
                  onRemove={onRemove}
                  onEdit={setManualEntry}
                  removingId={removingId}
                  duplicates={duplicates}
                />
              );
            })
          ) : (
            <ul className="card !p-0 divide-y divide-border overflow-hidden">
              {(flatItems ?? []).map((item) => (
                <CollectionItemRow
                  key={item.collection_id}
                  item={item}
                  imgSizeClass={IMG_CLASS[imgSize]}
                  onRemove={onRemove}
                  onEdit={setManualEntry}
                  removingId={removingId}
                  duplicateOf={duplicates.get(item.collection_id)}
                  showDriver
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DriverCard({
  group,
  expanded,
  onToggle,
  imgSizeClass,
  onRemove,
  onEdit,
  removingId,
  duplicates,
}: {
  group: DriverGroupView;
  expanded: boolean;
  onToggle: () => void;
  imgSizeClass: string;
  onRemove: (item: CollectionRow) => void;
  onEdit: (item: CollectionRow) => void;
  removingId: number | null;
  duplicates: Map<number, CollectionRow>;
}) {
  return (
    <div className="card !p-0 overflow-hidden">
      <button
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-bg-elevated"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <span
            className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          <span className="font-medium">{group.driver_name}</span>
          <span className="text-xs text-fg-subtle">
            {group.items.length} item{group.items.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="text-xs text-fg-muted tabular-nums">
          retail {formatCents(group.retail_total_cents)} · wholesale{" "}
          {formatCents(group.wholesale_total_cents)}
          {group.has_cost && <> · cost {formatCents(group.cost_total_cents)}</>}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border">
          <ul className="divide-y divide-border">
            {group.items.map((item) => (
              <CollectionItemRow
                key={item.collection_id}
                item={item}
                imgSizeClass={imgSizeClass}
                onRemove={onRemove}
                onEdit={onEdit}
                removingId={removingId}
                duplicateOf={duplicates.get(item.collection_id)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CollectionItemRow({
  item,
  imgSizeClass,
  onRemove,
  onEdit,
  removingId,
  duplicateOf,
  showDriver = false,
}: {
  item: CollectionRow;
  imgSizeClass: string;
  onRemove: (item: CollectionRow) => void;
  onEdit: (item: CollectionRow) => void;
  removingId: number | null;
  /** Set when this manually-added row now also exists as a synced DCR row —
   *  see findLocalDuplicates. */
  duplicateOf?: CollectionRow;
  /** Show the driver name (used by the flat, ungrouped view). */
  showDriver?: boolean;
}) {
  const [isCollapsed, onToggle] = useMinimized(
    `collection:${item.collection_id}`,
  );

  // A photo the user attached wins over the catalog image: it shows the copy
  // they own rather than a stock shot of the production run.
  const imageSrc = item.local_image_path
    ? convertFileSrc(item.local_image_path)
    : item.image_url
      ? resolveImage(item.image_url)
      : null;

  const title = (
    <div className="text-sm font-medium truncate flex items-center gap-2">
      <span className="truncate">{item.scheme_text ?? "(no scheme)"}</span>
      {item.is_local && (
        <span
          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-fg-subtle"
          title="Added by hand — not from diecastregistry.com"
        >
          Manual
        </span>
      )}
    </div>
  );
  const driverLine = showDriver && (
    <div className="text-xs text-fg-subtle mb-0.5">
      {item.driver_name ?? "(unknown)"}
    </div>
  );

  return (
    <li className={`${isCollapsed ? "px-4 py-2" : "p-4"} flex gap-4`}>
      <MinimizeToggle
        minimized={isCollapsed}
        onToggle={onToggle}
        className="self-start -mt-0.5"
      />
      {!isCollapsed && imageSrc && (
        <img
          src={imageSrc}
          alt=""
          loading="lazy"
          decoding="async"
          className={`${imgSizeClass} object-cover rounded border border-border shrink-0`}
        />
      )}
      <div className="flex-1 min-w-0">
        <button
          type="button"
          className="w-full text-left flex items-start gap-2 hover:opacity-80"
          onClick={onToggle}
          title={isCollapsed ? "Expand" : "Minimize"}
          aria-expanded={!isCollapsed}
        >
          <div className="min-w-0">
            {driverLine}
            {title}
          </div>
        </button>
        {!isCollapsed && (
          <>
            <div className="text-xs text-fg-subtle mt-0.5">
              {[item.year, item.oem, item.brand, item.scale, item.make]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {item.enriched && (
              <div className="text-xs text-fg-subtle mt-0.5">
                {[
                  item.diecast_type,
                  item.finish && `finish: ${item.finish}`,
                  item.production_qty &&
                    `qty: ${formatCount(item.production_qty)}`,
                  item.registration_number && `reg ${item.registration_number}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            {/* Outside the `enriched` block above, unlike the other spec
                fields: the DIN identifies the copy on the shelf, so it is
                just as real on a manual entry — which never becomes
                "enriched", having no detail page to enrich from. */}
            {item.din != null && (
              <div className="text-xs text-fg-subtle mt-0.5">
                DIN #{formatCount(item.din)}
                {item.production_qty != null &&
                  ` of ${formatCount(item.production_qty)}`}
              </div>
            )}
            {item.condition && (
              <div className="text-xs text-fg-subtle mt-0.5">
                condition: {item.condition}
              </div>
            )}
            {item.notes && (
              <div className="text-xs text-fg-muted mt-0.5 whitespace-pre-wrap">
                {item.notes}
              </div>
            )}
            {duplicateOf && (
              <div className="text-xs text-amber-400/80 mt-1">
                diecastregistry.com now lists this car too — you have a synced
                copy of it. Remove whichever you don&apos;t want.
              </div>
            )}
            <div className="flex items-center gap-3 mt-1">
              {item.detail_url && (
                <a
                  className="text-xs text-accent hover:underline"
                  href={DCR_BASE + item.detail_url}
                  onClick={(e) => {
                    e.preventDefault();
                    void openExternal(DCR_BASE + item.detail_url!);
                  }}
                >
                  View on diecastregistry.com →
                </a>
              )}
              {/* A manual entry has no detail page, so it can never become
                  "enriched" — the stub warning would be permanent and would
                  be telling the user to fix something that isn't broken. */}
              {!item.enriched && !item.is_local && (
                <span className="text-xs text-amber-400/80">
                  stub — needs registry sync
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <div className="text-right text-xs tabular-nums shrink-0 flex flex-col items-end gap-1">
        <div>
          <span className="text-fg-subtle">retail</span>{" "}
          {formatCents(item.retail_value_cents)}
        </div>
        {!isCollapsed && (
          <div>
            <span className="text-fg-subtle">wholesale</span>{" "}
            {formatCents(item.wholesale_value_cents)}
          </div>
        )}
        {item.paid_cents != null && (
          <div title="What you paid — a cost basis, not a registry appraisal">
            <span className="text-fg-subtle">cost</span>{" "}
            {formatCents(item.paid_cents)}
          </div>
        )}
        <div className="flex items-center gap-2 mt-1">
          {item.is_local && (
            <button
              type="button"
              className="text-fg-subtle hover:text-fg disabled:opacity-50"
              disabled={removingId !== null}
              onClick={() => onEdit(item)}
              title="Edit this manually-added entry"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="link-danger disabled:opacity-50"
            disabled={removingId !== null}
            onClick={() => onRemove(item)}
            title={
              item.is_local
                ? "Remove this manually-added entry"
                : "Remove from collection (also deletes from your DCR garage)"
            }
          >
            {removingId === item.collection_id ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </li>
  );
}

/** Stable expand/collapse key for a driver group. */
function groupKey(g: DriverGroupView): number | string {
  return g.driver_id != null ? g.driver_id : `name:${g.driver_name}`;
}

function resolveImage(src: string): string {
  if (src.startsWith("http")) return src;
  return DCR_BASE + src;
}

const GROUP_BY_DRIVER_KEY = "collection:group-by-driver";

/** Persisted toggle for grouping the collection by driver (defaults on). */
function useGroupByDriver(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GROUP_BY_DRIVER_KEY) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(GROUP_BY_DRIVER_KEY, value ? "1" : "0");
    } catch {
      // ignore
    }
  }, [value]);
  return [value, setValue];
}
