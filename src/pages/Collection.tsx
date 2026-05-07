import { useEffect, useMemo, useState } from "react";
import {
  api,
  formatCents,
  type CollectionRow,
} from "@/lib/tauri";

const DCR_BASE = "https://www.diecastregistry.com";

type SortMode =
  | "driver-asc"
  | "value-desc"
  | "count-desc"
  | "year-desc"
  | "year-asc";

interface DriverGroupView {
  driver_id: number | null;
  driver_name: string;
  items: CollectionRow[];
  retail_total_cents: number;
  wholesale_total_cents: number;
}

export function Collection() {
  const [items, setItems] = useState<CollectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number | string>>(new Set());

  const [searchText, setSearchText] = useState("");
  const [scaleFilter, setScaleFilter] = useState<string>("");
  const [oemFilter, setOemFilter] = useState<string>("");
  const [sortMode, setSortMode] = useState<SortMode>("driver-asc");

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

  // Distinct scales / OEMs for filter dropdowns.
  const scales = useMemo(() => {
    const set = new Set<string>();
    for (const i of items ?? [])
      if (i.scale) set.add(i.scale);
    return Array.from(set).sort();
  }, [items]);

  const oems = useMemo(() => {
    const set = new Set<string>();
    for (const i of items ?? [])
      if (i.oem) set.add(i.oem);
    return Array.from(set).sort();
  }, [items]);

  // Filter items, then group by driver, then sort groups.
  const groups: DriverGroupView[] | null = useMemo(() => {
    if (!items) return null;
    const q = searchText.trim().toLowerCase();
    const filtered = items.filter((it) => {
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
      if (scaleFilter && it.scale !== scaleFilter) return false;
      if (oemFilter && it.oem !== oemFilter) return false;
      return true;
    });

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
        };
        map.set(key, g);
      }
      g.items.push(it);
      g.retail_total_cents += it.retail_value_cents ?? 0;
      g.wholesale_total_cents += it.wholesale_value_cents ?? 0;
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
  }, [items, searchText, scaleFilter, oemFilter, sortMode]);

  function toggleGroup(key: number | string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const totalItems = items?.length ?? 0;
  const filteredItems = (groups ?? []).reduce(
    (s, g) => s + g.items.length,
    0,
  );

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold">My Collection</h2>
          <p className="text-sm text-slate-500">
            Imported from diecastregistry.com, grouped by driver.
          </p>
        </div>
        {items && (
          <div className="text-xs text-slate-500">
            {filteredItems === totalItems
              ? `${totalItems} items across ${groups?.length ?? 0} drivers`
              : `${filteredItems} of ${totalItems} items shown`}
          </div>
        )}
      </header>

      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
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
              title="Sort drivers"
            >
              <option value="driver-asc">Driver A → Z</option>
              <option value="value-desc">Total value high → low</option>
              <option value="count-desc">Item count high → low</option>
              <option value="year-desc">Newest year first</option>
              <option value="year-asc">Oldest year first</option>
            </select>
          </div>
          <div className="flex items-center gap-3 text-xs flex-wrap">
            <label className="flex items-center gap-1">
              <span className="text-slate-500">Scale:</span>
              <select
                className="bg-bg-elevated border border-border rounded px-2 py-0.5 text-slate-200"
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
              <span className="text-slate-500">OEM:</span>
              <select
                className="bg-bg-elevated border border-border rounded px-2 py-0.5 text-slate-200"
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
            {(searchText || scaleFilter || oemFilter) && (
              <button
                type="button"
                className="text-slate-500 hover:text-slate-200"
                onClick={() => {
                  setSearchText("");
                  setScaleFilter("");
                  setOemFilter("");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}

      {items === null ? (
        <div className="card text-sm text-slate-400">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card text-sm text-slate-400">
          Empty. Configure your diecastregistry.com credentials in Settings,
          then run a sync.
        </div>
      ) : groups && groups.length === 0 ? (
        <div className="card text-sm text-slate-400">
          No items match the current filters.
        </div>
      ) : (
        <div className="space-y-2">
          {(groups ?? []).map((g) => {
            const key =
              g.driver_id != null ? g.driver_id : `name:${g.driver_name}`;
            const isOpen = expanded.has(key);
            return (
              <DriverCard
                key={key}
                group={g}
                expanded={isOpen}
                onToggle={() => toggleGroup(key)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function DriverCard({
  group,
  expanded,
  onToggle,
}: {
  group: DriverGroupView;
  expanded: boolean;
  onToggle: () => void;
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
          <span className="text-xs text-slate-500">
            {group.items.length} item{group.items.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="text-xs text-slate-400 tabular-nums">
          retail {formatCents(group.retail_total_cents)} · wholesale{" "}
          {formatCents(group.wholesale_total_cents)}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border">
          <ul className="divide-y divide-border">
            {group.items.map((item) => (
              <li key={item.collection_id} className="p-4 flex gap-4">
                {item.image_url && (
                  <img
                    src={resolveImage(item.image_url)}
                    alt=""
                    className="w-24 h-24 object-cover rounded border border-border shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {item.scheme_text ?? "(no scheme)"}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {[
                      item.year,
                      item.oem,
                      item.brand,
                      item.scale,
                      item.make,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {item.enriched && (
                    <div className="text-xs text-slate-500 mt-0.5">
                      {[
                        item.diecast_type,
                        item.finish && `finish: ${item.finish}`,
                        item.production_qty &&
                          `qty: ${item.production_qty.toLocaleString()}`,
                        item.registration_number &&
                          `reg ${item.registration_number}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-1">
                    {item.detail_url && (
                      <a
                        className="text-xs text-accent hover:underline"
                        href={DCR_BASE + item.detail_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View on diecastregistry.com →
                      </a>
                    )}
                    {!item.enriched && (
                      <span className="text-xs text-amber-400/80">
                        stub — needs registry sync
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right text-xs tabular-nums shrink-0">
                  <div>
                    <span className="text-slate-500">retail</span>{" "}
                    {formatCents(item.retail_value_cents)}
                  </div>
                  <div>
                    <span className="text-slate-500">wholesale</span>{" "}
                    {formatCents(item.wholesale_value_cents)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function resolveImage(src: string): string {
  if (src.startsWith("http")) return src;
  return DCR_BASE + src;
}
