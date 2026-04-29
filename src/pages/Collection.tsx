import { useEffect, useState } from "react";
import {
  api,
  formatCents,
  type CollectionRow,
  type DriverGroup,
} from "@/lib/tauri";

const DCR_BASE = "https://www.diecastregistry.com";

export function Collection() {
  const [drivers, setDrivers] = useState<DriverGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [itemsByDriver, setItemsByDriver] = useState<
    Record<number, CollectionRow[]>
  >({});

  async function load() {
    try {
      const list = await api.listDriversWithCounts();
      setDrivers(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(driverId: number) {
    if (expanded === driverId) {
      setExpanded(null);
      return;
    }
    setExpanded(driverId);
    if (!itemsByDriver[driverId]) {
      try {
        const items = await api.listCollectionForDriver(driverId);
        setItemsByDriver((prev) => ({ ...prev, [driverId]: items }));
      } catch (e) {
        setError(String(e));
      }
    }
  }

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold">My Collection</h2>
          <p className="text-sm text-slate-500">
            Imported from diecastregistry.com, grouped by driver.
          </p>
        </div>
        {drivers && drivers.length > 0 && (
          <div className="text-xs text-slate-500">
            {drivers.reduce((s, d) => s + d.item_count, 0)} items across{" "}
            {drivers.length} drivers
          </div>
        )}
      </header>

      {error && (
        <div className="card border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}

      {drivers === null ? (
        <div className="card text-sm text-slate-400">Loading…</div>
      ) : drivers.length === 0 ? (
        <div className="card text-sm text-slate-400">
          Empty. Configure your diecastregistry.com credentials in Settings,
          then run a sync.
        </div>
      ) : (
        <div className="space-y-2">
          {drivers.map((d) => (
            <DriverCard
              key={d.driver_id}
              driver={d}
              expanded={expanded === d.driver_id}
              items={itemsByDriver[d.driver_id]}
              onToggle={() => toggle(d.driver_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DriverCard({
  driver,
  expanded,
  items,
  onToggle,
}: {
  driver: DriverGroup;
  expanded: boolean;
  items: CollectionRow[] | undefined;
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
          <span className="font-medium">{driver.driver_name}</span>
          <span className="text-xs text-slate-500">
            {driver.item_count} item{driver.item_count === 1 ? "" : "s"}
          </span>
        </div>
        <div className="text-xs text-slate-400 tabular-nums">
          retail {formatCents(driver.retail_total_cents)} · wholesale{" "}
          {formatCents(driver.wholesale_total_cents)}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {items === undefined ? (
            <div className="p-4 text-sm text-slate-400">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-4 text-sm text-slate-400">No items.</div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
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
                      {[item.year, item.oem, item.brand, item.scale, item.make]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    {item.detail_url && (
                      <a
                        className="text-xs text-accent hover:underline mt-1 inline-block"
                        href={DCR_BASE + item.detail_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View on diecastregistry.com →
                      </a>
                    )}
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
          )}
        </div>
      )}
    </div>
  );
}

function resolveImage(src: string): string {
  if (src.startsWith("http")) return src;
  return DCR_BASE + src;
}
