import { FormEvent, useEffect, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  api,
  driverListingCounts,
  sortDriverOptions,
  type AutoSyncSettings,
  type CredentialState,
  type DetailUrlBackfillSummary,
  type EbayCredentialsState,
  type EbayOauthStatus,
  type EnrichSummary,
  type FormOptionRow,
  type PrewarmedDriver,
  type PrewarmSummary,
  type RegistrySearchMode,
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

  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [autoSyncInterval, setAutoSyncInterval] = useState("12");
  const [autoSyncLastRun, setAutoSyncLastRun] = useState<number | null>(null);
  const [autoSyncScheduled, setAutoSyncScheduled] = useState(false);
  const [autoSyncPrewarmMax, setAutoSyncPrewarmMax] = useState("5000");
  const [autoSyncSaving, setAutoSyncSaving] = useState(false);
  const [autoSyncMessage, setAutoSyncMessage] = useState<string | null>(null);
  const [autoSyncError, setAutoSyncError] = useState<string | null>(null);

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

  const [buyerZip, setBuyerZip] = useState("");
  const [buyerZipSaving, setBuyerZipSaving] = useState(false);
  const [buyerZipMessage, setBuyerZipMessage] = useState<string | null>(null);
  const [buyerZipError, setBuyerZipError] = useState<string | null>(null);

  const [drivers, setDrivers] = useState<FormOptionRow[]>([]);
  const [prewarmInput, setPrewarmInput] = useState("");
  const [prewarmDriverGuid, setPrewarmDriverGuid] = useState("");
  const [prewarming, setPrewarming] = useState(false);
  const [prewarmSummary, setPrewarmSummary] =
    useState<PrewarmSummary | null>(null);
  const [prewarmError, setPrewarmError] = useState<string | null>(null);
  const [prewarmedDrivers, setPrewarmedDrivers] = useState<PrewarmedDriver[]>(
    [],
  );
  const [prewarmedSearch, setPrewarmedSearch] = useState("");
  const [searchMode, setSearchMode] = useState<RegistrySearchMode>("remote");
  const [searchModeSaving, setSearchModeSaving] = useState(false);
  const [searchModeError, setSearchModeError] = useState<string | null>(null);

  const [linkRepairRunning, setLinkRepairRunning] = useState(false);
  const [linkRepairSummary, setLinkRepairSummary] =
    useState<DetailUrlBackfillSummary | null>(null);
  const [linkRepairError, setLinkRepairError] = useState<string | null>(null);

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
      try {
        const autoSync: AutoSyncSettings = await api.getAutoSyncSettings();
        setAutoSyncEnabled(autoSync.enabled);
        setAutoSyncInterval(String(autoSync.interval_hours));
        setAutoSyncLastRun(autoSync.last_run);
        setAutoSyncScheduled(autoSync.scheduled);
        setAutoSyncPrewarmMax(String(autoSync.prewarm_max_entries));
      } catch {
        // not fatal — leave defaults
      }
      const e = await api.getEbayCredentials();
      setEbayCreds(e);
      setEbayEnv(e.environment === "production" ? "production" : "sandbox");
      const ru = await api.getEbayRuName();
      setEbayRuNameSaved(ru);
      setEbayRuName(ru ?? "");
      const status = await api.getEbayOauthStatus();
      setOauthStatus(status);
      try {
        setFilterDiecasts(await api.getEbayFilterNonDiecasts());
      } catch {
        // not fatal — leave default
      }
      try {
        setBuyerZip((await api.getEbayBuyerZip()) ?? "");
      } catch {
        // not fatal — field starts empty
      }
      // Drivers list is for the pre-warm picker; harmless if empty (the
      // form-options cache hasn't been populated yet).
      try {
        const [ds, listingCounts] = await Promise.all([
          api.listRegistryFormOptions("driver"),
          driverListingCounts(),
        ]);
        setDrivers(
          sortDriverOptions(
            ds,
            (x) => x.display,
            (x) => listingCounts.get(x.normalized) ?? 0,
          ),
        );
      } catch {
        // not fatal — picker shows empty
      }
      try {
        setPrewarmedDrivers(await api.listPrewarmedDrivers());
      } catch {
        // not fatal — list shows empty
      }
      try {
        setSearchMode(await api.getRegistrySearchMode());
      } catch {
        // not fatal — leave default (remote)
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

  async function onSaveBuyerZip(e: FormEvent) {
    e.preventDefault();
    setBuyerZipSaving(true);
    setBuyerZipMessage(null);
    setBuyerZipError(null);
    try {
      await api.setEbayBuyerZip(buyerZip.trim());
      setBuyerZipMessage(
        buyerZip.trim()
          ? "Saved. Use “Refresh all” on the Listings page to fill in missing shipping costs."
          : "Cleared — eBay will no longer quote location-based shipping.",
      );
    } catch (e) {
      setBuyerZipError(String(e));
    } finally {
      setBuyerZipSaving(false);
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

  async function onChangeSearchMode(mode: RegistrySearchMode) {
    setSearchModeSaving(true);
    setSearchModeError(null);
    try {
      await api.setRegistrySearchMode(mode);
      setSearchMode(mode);
    } catch (e) {
      setSearchModeError(String(e));
    } finally {
      setSearchModeSaving(false);
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
      try {
        setPrewarmedDrivers(await api.listPrewarmedDrivers());
      } catch {
        // not fatal — list refresh is best-effort
      }
    } catch (e) {
      setPrewarmError(String(e));
    } finally {
      setPrewarming(false);
    }
  }

  async function onRepairRegistryLinks() {
    setLinkRepairRunning(true);
    setLinkRepairError(null);
    setLinkRepairSummary(null);
    try {
      setLinkRepairSummary(await api.backfillRegistryDetailUrls());
      try {
        setPrewarmedDrivers(await api.listPrewarmedDrivers());
      } catch {
        // not fatal — list refresh is best-effort
      }
    } catch (e) {
      setLinkRepairError(String(e));
    } finally {
      setLinkRepairRunning(false);
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

  async function onSaveAutoSync(e: FormEvent) {
    e.preventDefault();
    setAutoSyncSaving(true);
    setAutoSyncMessage(null);
    setAutoSyncError(null);
    try {
      const hours = Math.min(
        23,
        Math.max(1, parseInt(autoSyncInterval, 10) || 12),
      );
      // 0 is meaningful (refresh disabled); only blank/garbage falls back.
      const parsedPrewarmMax = parseInt(autoSyncPrewarmMax, 10);
      const prewarmMax = Number.isNaN(parsedPrewarmMax)
        ? 5000
        : Math.max(0, parsedPrewarmMax);
      await api.setAutoSyncSettings(autoSyncEnabled, hours, prewarmMax);
      setAutoSyncInterval(String(hours));
      setAutoSyncPrewarmMax(String(prewarmMax));
      setAutoSyncMessage(
        autoSyncEnabled
          ? `Automatic sync on — Windows will run it every ${hours} hour${hours === 1 ? "" : "s"}, even when the app is closed.`
          : "Automatic sync off — scheduled task removed.",
      );
      // Re-read so the registered/last-run status reflects what just happened.
      try {
        const autoSync = await api.getAutoSyncSettings();
        setAutoSyncScheduled(autoSync.scheduled);
        setAutoSyncLastRun(autoSync.last_run);
      } catch {
        // not fatal — status badge may lag until next page load
      }
    } catch (e) {
      setAutoSyncError(String(e));
    } finally {
      setAutoSyncSaving(false);
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
          <h3 className="text-base font-medium">Automatic background sync</h3>
          <p className="text-xs text-fg-subtle mt-1">
            Registers a Windows scheduled task that syncs your collection (My
            Garage) and eBay (watchlist + saved searches/sellers) on a timer —
            even when this app is closed, as long as you're signed in to
            Windows. Whichever source isn't configured — diecastregistry.com
            credentials or a connected eBay account — is skipped. Interval is in
            hours (1–23).
          </p>
        </div>

        <form onSubmit={onSaveAutoSync} className="space-y-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={autoSyncEnabled}
              onChange={(e) => setAutoSyncEnabled(e.target.checked)}
            />
            <span>Enable automatic sync</span>
          </label>

          <div className="flex items-end gap-2">
            <div>
              <label className="label">Interval (hours)</label>
              <input
                className="input w-32"
                type="number"
                min={1}
                max={23}
                step={1}
                value={autoSyncInterval}
                disabled={!autoSyncEnabled}
                onChange={(e) => setAutoSyncInterval(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Max registry entries per refresh</label>
              <input
                className="input w-32"
                type="number"
                min={0}
                step={500}
                value={autoSyncPrewarmMax}
                disabled={!autoSyncEnabled}
                onChange={(e) => setAutoSyncPrewarmMax(e.target.value)}
              />
            </div>
            <button
              className="btn-primary"
              type="submit"
              disabled={autoSyncSaving}
            >
              {autoSyncSaving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="text-xs text-fg-subtle">
            Each sync also re-walks stale pre-warmed registry drivers (older
            than 30 days), up to this many entries per run so a single sync
            never tries the whole registry at once. Drivers that don't fit are
            picked up on later runs, oldest first. Set to 0 to skip the
            registry refresh entirely.
          </p>
        </form>

        <div className="space-y-1">
          <div className="text-xs">
            {autoSyncEnabled && autoSyncScheduled && (
              <span className="text-emerald-400">✓ Scheduled task registered</span>
            )}
            {autoSyncEnabled && !autoSyncScheduled && (
              <span className="text-amber-400">
                ⚠ Enabled, but no scheduled task is registered — click Save to
                (re)create it.
              </span>
            )}
            {!autoSyncEnabled && autoSyncScheduled && (
              <span className="text-amber-400">
                ⚠ A scheduled task still exists — click Save to remove it.
              </span>
            )}
            {!autoSyncEnabled && !autoSyncScheduled && (
              <span className="text-fg-subtle">Not scheduled.</span>
            )}
          </div>
          <div className="text-xs text-fg-subtle">
            {autoSyncLastRun
              ? `Last background sync ${new Date(
                  autoSyncLastRun * 1000,
                ).toLocaleString()}`
              : "Background sync hasn't run yet."}
          </div>
        </div>

        {autoSyncMessage && (
          <div className="text-xs text-emerald-400">{autoSyncMessage}</div>
        )}
        {autoSyncError && (
          <div className="text-xs text-red-400">{autoSyncError}</div>
        )}
      </section>

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
              {syncSummary.collection_rows_removed > 0 && (
                <div>
                  Removed {syncSummary.collection_rows_removed} local entr
                  {syncSummary.collection_rows_removed === 1 ? "y" : "ies"} no
                  longer in your garage.
                </div>
              )}
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

          <div className="pt-1 space-y-1.5">
            <div className="text-sm font-medium">Registry search mode</div>
            {(
              [
                {
                  mode: "remote",
                  label: "Live",
                  hint: "Always search diecastregistry.com (slowest, always complete).",
                },
                {
                  mode: "hybrid",
                  label: "Hybrid — recommended",
                  hint: "Answer instantly from pre-warmed data when it fully covers the query; otherwise search the site.",
                },
                {
                  mode: "local",
                  label: "Local only",
                  hint: "Never hit the network. Drivers you haven't pre-warmed return no results, and autographed / race-win filters are ignored.",
                },
              ] as { mode: RegistrySearchMode; label: string; hint: string }[]
            ).map((opt) => (
              <label
                key={opt.mode}
                className="flex items-start gap-2 text-sm cursor-pointer"
              >
                <input
                  type="radio"
                  name="registry-search-mode"
                  className="mt-0.5"
                  checked={searchMode === opt.mode}
                  disabled={searchModeSaving}
                  onChange={() => onChangeSearchMode(opt.mode)}
                />
                <span>
                  <span>{opt.label}</span>
                  <span className="block text-xs text-fg-subtle">
                    {opt.hint}
                  </span>
                </span>
              </label>
            ))}
            {searchModeError && (
              <div className="text-xs text-red-400 mt-1">{searchModeError}</div>
            )}
          </div>

          <div className="pt-1">
            <div className="text-xs font-medium text-fg-subtle">
              Pre-warmed drivers ({prewarmedDrivers.length})
            </div>
            {prewarmedDrivers.length === 0 ? (
              <div className="text-xs text-fg-subtle mt-1">
                No drivers pre-warmed yet.
              </div>
            ) : (
              (() => {
                const q = prewarmedSearch.trim().toLowerCase();
                const filtered = q
                  ? prewarmedDrivers.filter((d) =>
                      d.driver_name.toLowerCase().includes(q),
                    )
                  : prewarmedDrivers;
                return (
                  <>
                    <input
                      type="text"
                      className="input mt-2 w-full"
                      value={prewarmedSearch}
                      onChange={(e) => setPrewarmedSearch(e.target.value)}
                      placeholder="Filter pre-warmed drivers…"
                      autoComplete="off"
                    />
                    {filtered.length === 0 ? (
                      <div className="text-xs text-fg-subtle mt-2">
                        No drivers match “{prewarmedSearch}”.
                      </div>
                    ) : (
                      <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-border rounded-md border border-border">
                        {filtered.map((d) => (
                          <li
                            key={d.driver_guid}
                            className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
                          >
                            <span className="truncate">{d.driver_name}</span>
                            <span className="shrink-0 text-fg-subtle">
                              {d.entry_count} entr
                              {d.entry_count === 1 ? "y" : "ies"} ·{" "}
                              {new Date(
                                d.last_prewarmed_at * 1000,
                              ).toLocaleDateString()}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                );
              })()
            )}
          </div>
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">
                Repair diecastregistry.com links
              </div>
              <div className="text-xs text-fg-subtle mt-1">
                Some registry entries saved by older versions lost the URL of
                their diecastregistry.com page, so matched listings show no
                "View on diecastregistry.com" link. This re-walks the registry
                search for the affected drivers and restores the links. Safe to
                re-run; does nothing when no links are missing.
              </div>
            </div>
            <button
              className="btn-secondary shrink-0"
              type="button"
              disabled={
                linkRepairRunning || !creds?.diecastregistry_has_password
              }
              onClick={onRepairRegistryLinks}
            >
              {linkRepairRunning ? "Repairing…" : "Repair links"}
            </button>
          </div>
          {linkRepairSummary && (
            <div className="text-xs text-emerald-400">
              {linkRepairSummary.missing_before === 0
                ? "All registry entries already have links."
                : `Restored links for ${linkRepairSummary.entries_patched} of ` +
                  `${linkRepairSummary.missing_before} entries across ` +
                  `${linkRepairSummary.drivers_processed} driver` +
                  `${linkRepairSummary.drivers_processed === 1 ? "" : "s"}` +
                  (linkRepairSummary.still_missing > 0
                    ? ` (${linkRepairSummary.still_missing} still missing).`
                    : ".")}
            </div>
          )}
          {linkRepairError && (
            <div className="text-xs text-red-400">{linkRepairError}</div>
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

        <div className="border-t border-border pt-4 space-y-3">
          <div>
            <h4 className="text-sm font-medium">Shipping quote location</h4>
            <p className="text-xs text-fg-subtle mt-1">
              Your US zip code, sent to eBay so it can price shipping for
              listings that calculate it from the buyer's location. Without
              it, those listings come back with no shipping cost at all and
              show price-only totals. After saving, run “Refresh all” on the
              Listings page to backfill.
            </p>
          </div>

          <form onSubmit={onSaveBuyerZip} className="flex items-center gap-2">
            <input
              className="input w-32"
              type="text"
              value={buyerZip}
              onChange={(e) => setBuyerZip(e.target.value)}
              placeholder="e.g. 28117"
              autoComplete="postal-code"
            />
            <button
              className="btn-secondary"
              type="submit"
              disabled={buyerZipSaving}
            >
              {buyerZipSaving ? "Saving…" : "Save"}
            </button>
          </form>

          {buyerZipMessage && (
            <div className="text-xs text-emerald-400">{buyerZipMessage}</div>
          )}
          {buyerZipError && (
            <div className="text-xs text-red-400">{buyerZipError}</div>
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
