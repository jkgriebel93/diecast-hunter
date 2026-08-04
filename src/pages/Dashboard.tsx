import { useEffect, useState } from "react";
import { api, formatCount, type AppStatus } from "@/lib/tauri";
import { ErrorBanner } from "@/components/ErrorBanner";

export function Dashboard() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="p-6 space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Dashboard</h2>
        <p className="text-sm text-fg-subtle">
          Overview of your collection and tracked listings.
        </p>
      </header>

      {error && <ErrorBanner error={error} />}

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Registry entries" value={status?.registry_count ?? "—"} />
        <Stat label="My collection" value={status?.collection_count ?? "—"} />
        <Stat label="Saved listings" value={status?.listing_count ?? "—"} />
      </div>

      {status && (
        <div className="card text-xs text-fg-subtle font-mono break-all">
          <div>db: {status.db_path}</div>
          <div>schema: v{status.schema_version}</div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="text-3xl font-semibold tabular-nums">
        {typeof value === "number" ? formatCount(value) : value}
      </div>
    </div>
  );
}
