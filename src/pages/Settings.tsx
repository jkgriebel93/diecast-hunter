import { FormEvent, useEffect, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  api,
  type CredentialState,
  type EbayCredentialsState,
  type EbayOauthStatus,
  type EnrichSummary,
  type FormOptionRow,
  type ListingReceiverStatus,
  type PrewarmSummary,
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
  const [syncEnrich, setSyncEnrich] = useState(true);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshSummary, setRefreshSummary] =
    useState<EnrichSummary | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const [optionsRefreshing, setOptionsRefreshing] = useState(false);
  const [optionsMessage, setOptionsMessage] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [filterDiecasts, setFilterDiecasts] = useState(true);
  const [filterSaving, setFilterSaving] = useState(false);
  const [filterMessage, setFilterMessage] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [cleanupRunning, setCleanupRunning] = useState(false);

  const [drivers, setDrivers] = useState<FormOptionRow[]>([]);
  const [prewarmInput, setPrewarmInput] = useState("");
  const [prewarmDriverGuid, setPrewarmDriverGuid] = useState("");
  const [prewarming, setPrewarming] = useState(false);
  const [prewarmSummary, setPrewarmSummary] =
    useState<PrewarmSummary | null>(null);
  const [prewarmError, setPrewarmError] = useState<string | null>(null);

  const [receiverStatus, setReceiverStatus] =
    useState<ListingReceiverStatus | null>(null);
  const [receiverSecret, setReceiverSecret] = useState<string | null>(null);
  const [receiverSecretShown, setReceiverSecretShown] = useState(false);
  const [receiverError, setReceiverError] = useState<string | null>(null);
  const [receiverMessage, setReceiverMessage] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const [ebayCreds, setEbayCreds] = useState<EbayCredentialsState | null>(
    null,
  );
  const [ebayAppId, setEbayAppId] = useState("");
  const [ebayCertId, setEbayCertId] = useState("");
  const [ebayEnv, setEbayEnv] = useState<"sandbox" | "production">("sandbox");
  const [ebaySaving, setEbaySaving] = useState(false);
  const [ebayTesting, setEbayTesting] = useState(false);
  const [ebayMessage, setEbayMessage] = useState<string | null>(null);
  const [ebayError, setEbayError] = useState<string | null>(null);

  const [ebayRuName, setEbayRuName] = useState("");
  const [ebayRuNameSaved, setEbayRuNameSaved] = useState<string | null>(null);
  const [savingRuName, setSavingRuName] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<EbayOauthStatus | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [awaitingPaste, setAwaitingPaste] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthMessage, setOauthMessage] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  async function refresh() {
    try {
      const c = await api.getCredentials();
      setCreds(c);
      setUsername(c.diecastregistry_username ?? "");
      const ts = await api.getSetting("dcr.last_collection_sync");
      setLastSync(ts);
      const e = await api.getEbayCredentials();
      setEbayCreds(e);
      setEbayEnv(e.environment === "production" ? "production" : "sandbox");
      const ru = await api.getEbayRuName();
      setEbayRuNameSaved(ru);
      setEbayRuName(ru ?? "");
      const status = await api.getEbayOauthStatus();
      setOauthStatus(status);
      const rs = await api.getListingReceiverStatus();
      setReceiverStatus(rs);
      try {
        setFilterDiecasts(await api.getEbayFilterNonDiecasts());
      } catch {
        // not fatal — leave default
      }
      // Drivers list is for the pre-warm picker; harmless if empty (the
      // form-options cache hasn't been populated yet).
      try {
        const ds = await api.listRegistryFormOptions("driver");
        setDrivers(ds);
      } catch {
        // not fatal — picker shows empty
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function onToggleFilter(enabled: boolean) {
    setFilterSaving(true);
    setFilterMessage(null);
    setFilterError(null);
    try {
      await api.setEbayFilterNonDiecasts(enabled);
      setFilterDiecasts(enabled);
      setFilterMessage(
        enabled
          ? "Non-diecast eBay listings will be skipped on save."
          : "All eBay listings will be saved regardless of category.",
      );
    } catch (e) {
      setFilterError(String(e));
    } finally {
      setFilterSaving(false);
    }
  }

  async function onCleanupNonDiecasts() {
    setCleanupRunning(true);
    setFilterMessage(null);
    setFilterError(null);
    try {
      const summary = await api.removeNonDiecastListings();
      setFilterMessage(
        `Removed ${summary.removed} non-diecast listing${summary.removed === 1 ? "" : "s"} of ${summary.examined} examined.`,
      );
    } catch (e) {
      setFilterError(String(e));
    } finally {
      setCleanupRunning(false);
    }
  }

  async function onPrewarm() {
    if (!prewarmDriverGuid) return;
    setPrewarming(true);
    setPrewarmError(null);
    setPrewarmSummary(null);
    try {
      const s = await api.prewarmRegistryByDriver(prewarmDriverGuid);
      setPrewarmSummary(s);
    } catch (e) {
      setPrewarmError(String(e));
    } finally {
      setPrewarming(false);
    }
  }

  async function onRevealReceiverSecret() {
    setReceiverError(null);
    setReceiverMessage(null);
    try {
      const s = await api.getListingReceiverSecret();
      setReceiverSecret(s);
      setReceiverSecretShown(true);
      const rs = await api.getListingReceiverStatus();
      setReceiverStatus(rs);
    } catch (e) {
      setReceiverError(String(e));
    }
  }

  async function onCopyReceiverSecret() {
    setReceiverError(null);
    setReceiverMessage(null);
    try {
      const s = receiverSecret ?? (await api.getListingReceiverSecret());
      setReceiverSecret(s);
      await navigator.clipboard.writeText(s);
      setReceiverMessage("Secret copied to clipboard.");
    } catch (e) {
      setReceiverError(String(e));
    }
  }

  async function onRegenerateReceiverSecret() {
    setRegenerating(true);
    setReceiverError(null);
    setReceiverMessage(null);
    try {
      const s = await api.regenerateListingReceiverSecret();
      setReceiverSecret(s);
      setReceiverSecretShown(true);
      setReceiverMessage(
        "New secret generated. Update it in your browser extension.",
      );
    } catch (e) {
      setReceiverError(String(e));
    } finally {
      setRegenerating(false);
    }
  }

  async function onEbaySave(e: FormEvent) {
    e.preventDefault();
    setEbaySaving(true);
    setEbayError(null);
    setEbayMessage(null);
    try {
      await api.saveEbayCredentials(ebayAppId, ebayCertId, ebayEnv);
      setEbayAppId("");
      setEbayCertId("");
      setEbayMessage("Saved.");
      await refresh();
    } catch (e) {
      setEbayError(String(e));
    } finally {
      setEbaySaving(false);
    }
  }

  async function onEbayClear() {
    setEbayError(null);
    setEbayMessage(null);
    try {
      await api.clearEbayCredentials();
      setEbayAppId("");
      setEbayCertId("");
      setEbayMessage("Cleared.");
      await refresh();
    } catch (e) {
      setEbayError(String(e));
    }
  }

  async function onEbayTest() {
    setEbayTesting(true);
    setEbayError(null);
    setEbayMessage(null);
    try {
      const result = await api.testEbayConnection();
      setEbayMessage(result);
    } catch (e) {
      setEbayError(String(e));
    } finally {
      setEbayTesting(false);
    }
  }

  async function onSaveRuName() {
    setSavingRuName(true);
    setOauthError(null);
    setOauthMessage(null);
    try {
      await api.saveEbayRuName(ebayRuName.trim());
      await refresh();
      setOauthMessage("RuName saved.");
    } catch (e) {
      setOauthError(String(e));
    } finally {
      setSavingRuName(false);
    }
  }

  async function onConnectEbay() {
    setOauthBusy(true);
    setOauthError(null);
    setOauthMessage(null);
    try {
      const url = await api.startEbayOauth();
      await openExternal(url);
      setAwaitingPaste(true);
      setOauthMessage(
        "Opened eBay sign-in in your browser. After you authorize, copy the code from the success page and paste it below.",
      );
    } catch (e) {
      setOauthError(String(e));
    } finally {
      setOauthBusy(false);
    }
  }

  async function onSubmitCode() {
    setOauthBusy(true);
    setOauthError(null);
    setOauthMessage(null);
    try {
      await api.completeEbayOauth(oauthCode.trim());
      setOauthCode("");
      setAwaitingPaste(false);
      setOauthMessage("Connected to eBay.");
      await refresh();
    } catch (e) {
      setOauthError(String(e));
    } finally {
      setOauthBusy(false);
    }
  }

  async function onDisconnectEbay() {
    setOauthBusy(true);
    setOauthError(null);
    setOauthMessage(null);
    try {
      await api.disconnectEbayOauth();
      setOauthMessage("Disconnected.");
      setAwaitingPaste(false);
      await refresh();
    } catch (e) {
      setOauthError(String(e));
    } finally {
      setOauthBusy(false);
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
      const summary = await api.syncDcrCollection(syncEnrich);
      setSyncSummary(summary);
      await refresh();
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function onRefresh(force: boolean) {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshSummary(null);
    try {
      const summary = await api.refreshRegistryDetails(force);
      setRefreshSummary(summary);
    } catch (e) {
      setRefreshError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function onRefreshFormOptions() {
    setOptionsRefreshing(true);
    setOptionsMessage(null);
    setOptionsError(null);
    try {
      const summary = await api.refreshRegistryFormOptions();
      setOptionsMessage(
        `Cached ${summary.options_upserted} dropdown options across ${summary.fields_seen} fields.`,
      );
    } catch (e) {
      setOptionsError(String(e));
    } finally {
      setOptionsRefreshing(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <header>
        <h2 className="text-2xl font-semibold">Settings</h2>
        <p className="text-sm text-fg-subtle">
          Account credentials and sync sources.
        </p>
      </header>

      <section className="card space-y-4">
        <div>
          <h3 className="text-base font-medium">diecastregistry.com</h3>
          <p className="text-xs text-fg-subtle mt-1">
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
                <span className="text-fg-subtle normal-case">
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
              <div className="text-xs text-fg-subtle">
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
          <label className="flex items-center gap-2 text-xs text-fg-subtle">
            <input
              type="checkbox"
              checked={syncEnrich}
              disabled={syncing}
              onChange={(e) => setSyncEnrich(e.target.checked)}
            />
            Refresh registry details after sync (slower)
          </label>
          {syncSummary && (
            <div className="text-xs text-emerald-400 space-y-1">
              <div>
                Pulled {syncSummary.items_seen} items across{" "}
                {syncSummary.pages_fetched} page
                {syncSummary.pages_fetched === 1 ? "" : "s"}.
              </div>
              {syncSummary.enrichment && (
                <div>
                  Enriched {syncSummary.enrichment.enriched} of{" "}
                  {syncSummary.enrichment.considered} registry entries (
                  {syncSummary.enrichment.failed} failed,{" "}
                  {syncSummary.enrichment.skipped} skipped).
                </div>
              )}
            </div>
          )}
          {syncError && (
            <div className="text-xs text-red-400">{syncError}</div>
          )}
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Registry details</div>
              <div className="text-xs text-fg-subtle">
                Re-fetch detail pages for cars in your collection. Stale
                entries (older than 30 days) refresh automatically.
              </div>
            </div>
            <div className="flex gap-2">
              <button
                className="btn-secondary"
                type="button"
                disabled={
                  refreshing || !creds?.diecastregistry_has_password
                }
                onClick={() => onRefresh(false)}
              >
                {refreshing ? "Refreshing…" : "Refresh stale"}
              </button>
              <button
                className="btn-secondary"
                type="button"
                disabled={
                  refreshing || !creds?.diecastregistry_has_password
                }
                onClick={() => onRefresh(true)}
              >
                Force refresh all
              </button>
            </div>
          </div>
          {refreshSummary && (
            <div className="text-xs text-emerald-400">
              Refreshed {refreshSummary.enriched} of{" "}
              {refreshSummary.considered} (
              {refreshSummary.failed} failed,{" "}
              {refreshSummary.skipped} skipped).
            </div>
          )}
          {refreshError && (
            <div className="text-xs text-red-400">{refreshError}</div>
          )}
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Registry search options</div>
              <div className="text-xs text-fg-subtle">
                Cache driver / OEM / brand / scale / finish dropdown choices
                from diecastregistry.com. Used by the "Search registry…" dialog
                on saved listings. Refresh occasionally to pick up new
                drivers / brands.
              </div>
            </div>
            <button
              className="btn-secondary"
              type="button"
              disabled={
                optionsRefreshing || !creds?.diecastregistry_has_password
              }
              onClick={onRefreshFormOptions}
            >
              {optionsRefreshing ? "Fetching…" : "Refresh options"}
            </button>
          </div>
          {optionsMessage && (
            <div className="text-xs text-emerald-400">{optionsMessage}</div>
          )}
          {optionsError && (
            <div className="text-xs text-red-400">{optionsError}</div>
          )}
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div>
            <div className="text-sm font-medium">Pre-warm registry by driver</div>
            <div className="text-xs text-fg-subtle mt-1">
              Pull every registry entry for one driver and store them locally
              so the registry-search dialog can surface candidates without
              hitting diecastregistry.com on every keystroke. Takes a minute
              or two for a prolific driver — pages are paced to be polite.
              Repeat for every driver you watch.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              list="prewarm-drivers-list"
              type="text"
              className="input flex-1"
              value={prewarmInput}
              onChange={(e) => {
                setPrewarmInput(e.target.value);
                const m = drivers.find((d) => d.display === e.target.value);
                setPrewarmDriverGuid(m?.value ?? "");
              }}
              placeholder={
                drivers.length === 0
                  ? "Refresh registry options first…"
                  : "Type a driver name…"
              }
              autoComplete="off"
              disabled={drivers.length === 0}
            />
            <datalist id="prewarm-drivers-list">
              {drivers.map((d) => (
                <option key={d.value} value={d.display} />
              ))}
            </datalist>
            <button
              className="btn-primary shrink-0"
              type="button"
              onClick={onPrewarm}
              disabled={prewarming || !prewarmDriverGuid}
            >
              {prewarming ? "Fetching…" : "Pre-warm"}
            </button>
          </div>

          {prewarmSummary && (
            <div className="text-xs text-emerald-400">
              {prewarmSummary.driver_name}: pulled{" "}
              {prewarmSummary.results_seen} entries across{" "}
              {prewarmSummary.pages_fetched} page
              {prewarmSummary.pages_fetched === 1 ? "" : "s"} (
              {prewarmSummary.registry_entries_upserted} upserted).
            </div>
          )}
          {prewarmError && (
            <div className="text-xs text-red-400">{prewarmError}</div>
          )}
        </div>
      </section>

      <section className="card space-y-4">
        <div>
          <h3 className="text-base font-medium">eBay Developers</h3>
          <p className="text-xs text-fg-subtle mt-1">
            App ID and Cert ID from your eBay developer keyset. Used for
            looking up item details via the Browse API. Stored in the Windows
            Credential Manager. User OAuth (for watchlist sync) comes later.
          </p>
        </div>

        <form onSubmit={onEbaySave} className="space-y-3">
          <div>
            <label className="label">Environment</label>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="ebay-env"
                  value="sandbox"
                  checked={ebayEnv === "sandbox"}
                  onChange={() => setEbayEnv("sandbox")}
                />
                Sandbox
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="ebay-env"
                  value="production"
                  checked={ebayEnv === "production"}
                  onChange={() => setEbayEnv("production")}
                />
                Production
              </label>
            </div>
          </div>
          <div>
            <label className="label">
              App ID (Client ID){" "}
              {ebayCreds?.has_app_id && (
                <span className="text-fg-subtle normal-case">
                  (saved — leave blank to keep)
                </span>
              )}
            </label>
            <input
              className="input"
              type="text"
              value={ebayAppId}
              onChange={(e) => setEbayAppId(e.target.value)}
              autoComplete="off"
              placeholder={ebayCreds?.has_app_id ? "••••••••" : ""}
            />
          </div>
          <div>
            <label className="label">
              Cert ID (Client Secret){" "}
              {ebayCreds?.has_cert_id && (
                <span className="text-fg-subtle normal-case">
                  (saved — leave blank to keep)
                </span>
              )}
            </label>
            <input
              className="input"
              type="password"
              value={ebayCertId}
              onChange={(e) => setEbayCertId(e.target.value)}
              autoComplete="new-password"
              placeholder={ebayCreds?.has_cert_id ? "••••••••" : ""}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-primary"
              type="submit"
              disabled={ebaySaving || !ebayAppId || !ebayCertId}
            >
              {ebaySaving ? "Saving…" : "Save"}
            </button>
            <button
              className="btn-secondary"
              type="button"
              disabled={
                ebayTesting ||
                !ebayCreds?.has_app_id ||
                !ebayCreds?.has_cert_id
              }
              onClick={onEbayTest}
            >
              {ebayTesting ? "Testing…" : "Test connection"}
            </button>
            {(ebayCreds?.has_app_id || ebayCreds?.has_cert_id) && (
              <button
                className="btn-secondary"
                type="button"
                onClick={onEbayClear}
              >
                Clear
              </button>
            )}
          </div>
        </form>
        {ebayMessage && (
          <div className="text-xs text-emerald-400">{ebayMessage}</div>
        )}
        {ebayError && (
          <div className="text-xs text-red-400">{ebayError}</div>
        )}

        <div className="border-t border-border pt-4 space-y-3">
          <div>
            <h4 className="text-sm font-medium">Watchlist sync (user OAuth)</h4>
            <p className="text-xs text-fg-subtle mt-1">
              Connect your eBay account so the app can read your watchlist.
              Configure a RuName on developer.ebay.com pointing to{" "}
              <code className="text-fg-muted">
                https://&lt;your-worker&gt;/ebay-oauth-callback
              </code>{" "}
              and paste the resulting RuName below.
            </p>
          </div>

          <div>
            <label className="label">RuName</label>
            <div className="flex gap-2">
              <input
                className="input flex-1 font-mono text-xs"
                type="text"
                value={ebayRuName}
                onChange={(e) => setEbayRuName(e.target.value)}
                placeholder="MyApp-Account-PRD-xxxxxxxx-xxxxxxxx"
                autoComplete="off"
              />
              <button
                className="btn-secondary shrink-0"
                type="button"
                onClick={onSaveRuName}
                disabled={
                  savingRuName ||
                  !ebayRuName.trim() ||
                  ebayRuName.trim() === (ebayRuNameSaved ?? "")
                }
              >
                {savingRuName ? "Saving…" : "Save"}
              </button>
            </div>
          </div>

          {oauthStatus?.connected ? (
            <div className="flex items-center justify-between rounded-md bg-bg-elevated border border-border px-3 py-2">
              <div className="text-xs">
                <span className="text-emerald-400">✓ Connected</span>
                <span className="text-fg-subtle ml-2">
                  ({oauthStatus.environment})
                </span>
                {oauthStatus.access_token_expires_at && (
                  <span className="text-fg-subtle ml-2">
                    token expires{" "}
                    {new Date(
                      oauthStatus.access_token_expires_at * 1000,
                    ).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <button
                className="btn-secondary"
                type="button"
                onClick={onDisconnectEbay}
                disabled={oauthBusy}
              >
                {oauthBusy ? "…" : "Disconnect"}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                className="btn-primary"
                type="button"
                onClick={onConnectEbay}
                disabled={
                  oauthBusy ||
                  !ebayCreds?.has_app_id ||
                  !ebayCreds?.has_cert_id ||
                  !oauthStatus?.has_ru_name
                }
              >
                {oauthBusy && !awaitingPaste
                  ? "Opening…"
                  : "Connect eBay account"}
              </button>
              {awaitingPaste && (
                <div className="space-y-2">
                  <label className="label">Paste auth code</label>
                  <div className="flex gap-2">
                    <input
                      className="input flex-1 font-mono text-xs"
                      type="text"
                      value={oauthCode}
                      onChange={(e) => setOauthCode(e.target.value)}
                      placeholder="v^1.1#i^1#..."
                      autoComplete="off"
                    />
                    <button
                      className="btn-primary shrink-0"
                      type="button"
                      onClick={onSubmitCode}
                      disabled={oauthBusy || !oauthCode.trim()}
                    >
                      {oauthBusy ? "Exchanging…" : "Submit"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {oauthMessage && (
            <div className="text-xs text-emerald-400">{oauthMessage}</div>
          )}
          {oauthError && (
            <div className="text-xs text-red-400">{oauthError}</div>
          )}
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div>
            <h4 className="text-sm font-medium">Diecast filter</h4>
            <p className="text-xs text-fg-subtle mt-1">
              Reject non-diecast eBay listings on save. Watchlist sync still
              sees them but doesn't store them; manual URL adds error out
              with a helpful message. Heuristic is a substring check on
              eBay's category path — turn it off if you want to track an
              accessory or transporter that lives in a different category.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={filterDiecasts}
              disabled={filterSaving}
              onChange={(e) => onToggleFilter(e.target.checked)}
            />
            <span>Filter non-diecast eBay listings</span>
          </label>

          <div>
            <button
              type="button"
              className="btn-secondary"
              onClick={onCleanupNonDiecasts}
              disabled={cleanupRunning}
              title="Walk every saved eBay listing and delete any whose category isn't a diecast. Listings without category data (saved before this feature) are skipped — refresh those first."
            >
              {cleanupRunning
                ? "Cleaning…"
                : "Remove existing non-diecast listings"}
            </button>
          </div>

          {filterMessage && (
            <div className="text-xs text-emerald-400">{filterMessage}</div>
          )}
          {filterError && (
            <div className="text-xs text-red-400">{filterError}</div>
          )}
        </div>
      </section>

      <section className="card space-y-4">
        <div>
          <h3 className="text-base font-medium">
            Browser-extension receiver
          </h3>
          <p className="text-xs text-fg-subtle mt-1">
            Local HTTP server (running on {receiverStatus?.url ?? "…"}) that
            the Diecast Hunter browser extension POSTs Facebook Marketplace
            listings to. Paste the URL and shared secret into the extension's
            options page.
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Endpoint URL</label>
            <div className="flex gap-2">
              <input
                className="input flex-1 font-mono text-xs"
                type="text"
                value={
                  receiverStatus
                    ? `${receiverStatus.url}/listings/save`
                    : ""
                }
                readOnly
              />
              <button
                type="button"
                className="btn-secondary shrink-0"
                onClick={async () => {
                  if (receiverStatus) {
                    await navigator.clipboard.writeText(
                      `${receiverStatus.url}/listings/save`,
                    );
                    setReceiverMessage("URL copied.");
                  }
                }}
              >
                Copy
              </button>
            </div>
          </div>

          <div>
            <label className="label">Shared secret</label>
            <div className="flex gap-2">
              <input
                className="input flex-1 font-mono text-xs"
                type={receiverSecretShown ? "text" : "password"}
                value={receiverSecret ?? "•".repeat(32)}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className="btn-secondary shrink-0"
                onClick={
                  receiverSecretShown
                    ? () => setReceiverSecretShown(false)
                    : onRevealReceiverSecret
                }
                title={receiverSecretShown ? "Hide" : "Reveal"}
              >
                {receiverSecretShown ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className="btn-secondary shrink-0"
                onClick={onCopyReceiverSecret}
              >
                Copy
              </button>
              <button
                type="button"
                className="btn-secondary shrink-0"
                onClick={onRegenerateReceiverSecret}
                disabled={regenerating}
                title="Generate a new secret. You'll need to update the extension."
              >
                {regenerating ? "…" : "Regenerate"}
              </button>
            </div>
          </div>

          {receiverMessage && (
            <div className="text-xs text-emerald-400">{receiverMessage}</div>
          )}
          {receiverError && (
            <div className="text-xs text-red-400">{receiverError}</div>
          )}
        </div>
      </section>

      {message && (
        <div className="text-sm text-emerald-400">{message}</div>
      )}
      {error && <div className="text-sm text-red-400">{error}</div>}
    </div>
  );
}
