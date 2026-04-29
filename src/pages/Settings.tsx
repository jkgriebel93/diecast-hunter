import { FormEvent, useEffect, useState } from "react";
import {
  api,
  type CredentialState,
  type SyncSummary,
} from "@/lib/tauri";

export function Settings() {
  const [creds, setCreds] = useState<CredentialState | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function refresh() {
    try {
      const c = await api.getCredentials();
      setCreds(c);
      setUsername(c.diecastregistry_username ?? "");
      const ts = await api.getSetting("dcr.last_collection_sync");
      setLastSync(ts);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await api.saveDiecastRegistryCredentials(username, password);
      setPassword("");
      setMessage("Saved.");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onClear() {
    setError(null);
    setMessage(null);
    try {
      await api.clearDiecastRegistryCredentials();
      setPassword("");
      setMessage("Cleared.");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onSync() {
    setSyncing(true);
    setSyncError(null);
    setSyncSummary(null);
    try {
      const summary = await api.syncDcrCollection();
      setSyncSummary(summary);
      await refresh();
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <header>
        <h2 className="text-2xl font-semibold">Settings</h2>
        <p className="text-sm text-slate-500">
          Account credentials and sync sources.
        </p>
      </header>

      <section className="card space-y-4">
        <div>
          <h3 className="text-base font-medium">diecastregistry.com</h3>
          <p className="text-xs text-slate-500 mt-1">
            Used to import your collection and the master registry. Credentials
            are stored in the Windows Credential Manager.
          </p>
        </div>

        <form onSubmit={onSave} className="space-y-3">
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="label">
              Password{" "}
              {creds?.diecastregistry_has_password && (
                <span className="text-slate-500 normal-case">
                  (saved — leave blank to keep)
                </span>
              )}
            </label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={
                creds?.diecastregistry_has_password ? "••••••••" : ""
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-primary"
              type="submit"
              disabled={saving || !username || !password}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {creds?.diecastregistry_has_password && (
              <button
                className="btn-secondary"
                type="button"
                onClick={onClear}
              >
                Clear
              </button>
            )}
          </div>
        </form>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Sync My Garage</div>
              <div className="text-xs text-slate-500">
                {lastSync
                  ? `Last synced ${new Date(
                      Number(lastSync) * 1000,
                    ).toLocaleString()}`
                  : "Never synced"}
              </div>
            </div>
            <button
              className="btn-primary"
              type="button"
              disabled={
                syncing || !creds?.diecastregistry_has_password
              }
              onClick={onSync}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
          {syncSummary && (
            <div className="text-xs text-emerald-400">
              Pulled {syncSummary.items_seen} items across{" "}
              {syncSummary.pages_fetched} page
              {syncSummary.pages_fetched === 1 ? "" : "s"}.
            </div>
          )}
          {syncError && (
            <div className="text-xs text-red-400">{syncError}</div>
          )}
        </div>
      </section>

      <section className="card space-y-3">
        <div>
          <h3 className="text-base font-medium">eBay</h3>
          <p className="text-xs text-slate-500 mt-1">
            Connect via OAuth to sync watched listings and refresh prices.
          </p>
        </div>
        <button className="btn-secondary" type="button" disabled>
          Connect eBay account (coming soon)
        </button>
      </section>

      {message && (
        <div className="text-sm text-emerald-400">{message}</div>
      )}
      {error && <div className="text-sm text-red-400">{error}</div>}
    </div>
  );
}
