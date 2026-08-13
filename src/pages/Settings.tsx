import { FormEvent, useEffect, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NoticeBanner } from "@/components/NoticeBanner";
import { describeExpiry } from "@/lib/shareLinks";
import {
  api,
  driverListingCounts,
  formatCount,
  formatDate,
  formatDateTime,
  formatTime,
  sortDriverOptions,
  type AutoSyncSettings,
  type BackgroundSettings,
  type CredentialState,
  type DetailUrlBackfillSummary,
  type EbayCredentialsState,
  type EbayOauthStatus,
  type EnrichSummary,
  type FormOptionRow,
  type ListingReceiverStatus,
  type MatcherStatus,
  type PrewarmedDriver,
  type PrewarmSummary,
  type RegistrySearchMode,
  type ShareRecord,
  type ShareSettings,
  type SyncSummary,
  type TrainOutcome,
} from "@/lib/tauri";

/** Settings groups (DCH-21).
 *
 *  The screen was five cards in one column, in the order features happened to
 *  be built — "each setting simply tacked on at the end". Two of those cards
 *  were also doing more than one job: the diecastregistry.com card held the
 *  sign-in *and* four registry maintenance tools, and the eBay card held API
 *  keys *and* two search preferences.
 *
 *  So the grouping isn't only a nav change: every sub-block is now its own
 *  card, filed by what it is rather than by which integration it happened to
 *  arrive with. Credentials for both services sit together under Accounts;
 *  the registry tools moved to Sync; the search preferences to Search.
 */
export const SETTINGS_TABS = [
  { id: "accounts", label: "Accounts" },
  { id: "sync", label: "Sync" },
  { id: "search", label: "Search & matching" },
  { id: "extension", label: "Extension" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

const TAB_KEY = "settings.tab";

export function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === value);
}

/** Reopen on the group you were last in. Settings is a place you return to
 *  mid-task — usually to the same corner of it. */
function loadTab(): SettingsTab {
  try {
    const raw = localStorage.getItem(TAB_KEY);
    if (isSettingsTab(raw)) return raw;
  } catch {
    // localStorage can throw in private modes.
  }
  return "accounts";
}

function SettingsTabs({
  tab,
  onChange,
}: {
  tab: SettingsTab;
  onChange: (t: SettingsTab) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
      {SETTINGS_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className={`px-3 py-1.5 text-sm rounded-t border-b-2 -mb-px transition-colors ${
            tab === t.id
              ? "border-accent text-fg"
              : "border-transparent text-fg-muted hover:text-fg"
          }`}
          onClick={() => {
            onChange(t.id);
            try {
              localStorage.setItem(TAB_KEY, t.id);
            } catch {
              // ignore
            }
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

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
  const [autoSyncEnrichMax, setAutoSyncEnrichMax] = useState("500");
  const [autoSyncSaving, setAutoSyncSaving] = useState(false);
  const [autoSyncMessage, setAutoSyncMessage] = useState<string | null>(null);
  const [autoSyncError, setAutoSyncError] = useState<string | null>(null);

  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncEnrich, setSyncEnrich] = useState(true);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshSummary, setRefreshSummary] = useState<EnrichSummary | null>(
    null,
  );
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
  const [prewarmSummary, setPrewarmSummary] = useState<PrewarmSummary | null>(
    null,
  );
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

  const [ebayCreds, setEbayCreds] = useState<EbayCredentialsState | null>(null);
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

  // Wishlist sharing (DCH-46).
  const [shareSettings, setShareSettings] = useState<ShareSettings | null>(
    null,
  );
  const [shareUrl, setShareUrl] = useState("");
  const [shareSecret, setShareSecret] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [shareError, setShareError] = useState<unknown>(null);

  async function loadShareSettings() {
    try {
      const s = await api.getShareSettings();
      setShareSettings(s);
      setShareUrl(s.worker_url ?? "");
    } catch (e) {
      setShareError(e);
    }
  }

  async function onShareSave(e: FormEvent) {
    e.preventDefault();
    setShareBusy(true);
    setShareError(null);
    setShareNotice(null);
    try {
      const saved = await api.saveShareSettings(shareUrl, shareSecret);
      setShareSettings(saved);
      setShareSecret("");
      setShareNotice("Sharing settings saved.");
    } catch (err) {
      setShareError(err);
    } finally {
      setShareBusy(false);
    }
  }

  // Active public links (DCH-48). Separate state from the credential card
  // above: one is a setting, the other is a list of live things, and a
  // failure to load the list must not blank out the settings form.
  const [shares, setShares] = useState<ShareRecord[] | null>(null);
  const [sharesBusy, setSharesBusy] = useState<number | null>(null);
  const [sharesNotice, setSharesNotice] = useState<{
    tone: "success" | "warning";
    message: string;
  } | null>(null);
  const [sharesError, setSharesError] = useState<unknown>(null);

  async function loadShares() {
    try {
      setShares(await api.listShares());
    } catch (e) {
      setSharesError(e);
    }
  }

  // A refused clipboard is a partial success, not a failure — the URL is on
  // screen and selectable either way (DCH-36).
  async function onCopyShare(share: ShareRecord) {
    setSharesError(null);
    try {
      await navigator.clipboard.writeText(share.url);
      setSharesNotice({ tone: "success", message: "Link copied." });
    } catch {
      setSharesNotice({
        tone: "warning",
        message:
          "Couldn't reach the clipboard — select the link above to copy it.",
      });
    }
  }

  async function onRevokeShare(share: ShareRecord) {
    // Irreversible in the way that matters: the slug is unguessable and a
    // new share mints a new one, so anyone holding this link loses access
    // for good (DCH-33).
    const ok = window.confirm(
      `Turn off the link for "${share.label}"?\n\nAnyone holding it loses ` +
        `access immediately, and re-sharing creates a different link. Your ` +
        `saved listings are not touched.`,
    );
    if (!ok) return;
    setSharesBusy(share.id);
    setSharesError(null);
    setSharesNotice(null);
    try {
      await api.revokeShare(share.id);
      setSharesNotice({
        tone: "success",
        message: `"${share.label}" is no longer shared.`,
      });
      await loadShares();
    } catch (e) {
      setSharesError(e);
    } finally {
      setSharesBusy(null);
    }
  }

  async function onShareClear() {
    const ok = window.confirm(
      "Remove the sharing Worker URL and secret?\n\nLinks you have already " +
        "shared keep working until they expire — turn them off in Active " +
        "links below first if you want them gone now.",
    );
    if (!ok) return;
    setShareBusy(true);
    setShareError(null);
    setShareNotice(null);
    try {
      const cleared = await api.clearShareSettings();
      setShareSettings(cleared);
      setShareUrl("");
      setShareSecret("");
      setShareNotice("Sharing settings removed.");
    } catch (err) {
      setShareError(err);
    } finally {
      setShareBusy(false);
    }
  }
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>(loadTab);

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
        setAutoSyncEnrichMax(String(autoSync.enrich_max_entries));
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
    // Named, because the App ID and Cert ID live in the OS keychain and are
    // not recoverable from the app — clearing them means a trip back to the
    // eBay developer console.
    if (
      !window.confirm(
        "Clear your saved eBay App ID and Cert ID?\n\n" +
          "They're deleted from the system keychain. eBay search, watchlist " +
          "sync and the Browse pages stop working until you enter them again.",
      )
    ) {
      return;
    }
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
    if (
      !window.confirm(
        "Disconnect your eBay account?\n\n" +
          "The saved access and refresh tokens are deleted. Watchlist sync " +
          "and offers stop working until you reconnect, which needs another " +
          "trip through eBay's sign-in. Listings already saved locally are " +
          "not touched.",
      )
    ) {
      return;
    }
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
    void loadShareSettings();
    void loadShares();
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
    if (
      !window.confirm(
        "Clear your saved diecastregistry.com sign-in?\n\n" +
          "The username and password are deleted from the system keychain. " +
          "My Garage sync and registry lookups stop working until you enter " +
          "them again. Your collection data stays.",
      )
    ) {
      return;
    }
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
      const parsedEnrichMax = parseInt(autoSyncEnrichMax, 10);
      const enrichMax = Number.isNaN(parsedEnrichMax)
        ? 500
        : Math.max(0, parsedEnrichMax);
      await api.setAutoSyncSettings(
        autoSyncEnabled,
        hours,
        prewarmMax,
        enrichMax,
      );
      setAutoSyncInterval(String(hours));
      setAutoSyncPrewarmMax(String(prewarmMax));
      setAutoSyncEnrichMax(String(enrichMax));
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
          Accounts, syncing, search behaviour and the browser extension.
        </p>
      </header>

      <SettingsTabs tab={tab} onChange={setTab} />

      {tab === "accounts" && (
        <>
          <section className="card space-y-4">
            <div>
              <h3 className="text-base font-medium">diecastregistry.com</h3>
              <p className="text-xs text-fg-subtle mt-1">
                Used to import your collection and the master registry.
                Credentials are stored in the Windows Credential Manager.
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
                    className="btn-danger"
                    type="button"
                    onClick={onClear}
                  >
                    Clear
                  </button>
                )}
              </div>
            </form>
          </section>
          <section className="card space-y-4">
            <div>
              <h3 className="text-base font-medium">eBay Developers</h3>
              <p className="text-xs text-fg-subtle mt-1">
                App ID and Cert ID from your eBay developer keyset. Used for
                looking up item details via the Browse API. Stored in the
                Windows Credential Manager. Watchlist sync needs the user OAuth
                connection below as well.
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
                    className="btn-danger"
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
            {ebayError && <ErrorBanner error={ebayError} variant="inline" />}
          </section>
          <section className="card space-y-4">
            <div className="space-y-3">
              <div>
                <h4 className="text-sm font-medium">
                  Watchlist sync (user OAuth)
                </h4>
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
                        {formatTime(oauthStatus.access_token_expires_at)}
                      </span>
                    )}
                  </div>
                  <button
                    className="btn-danger"
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
                <ErrorBanner error={oauthError} variant="inline" />
              )}
            </div>
          </section>

          {/* Its own card, filed by what it is — a credential — rather than
              by the feature that happens to use it (DCH-21). */}
          <section className="card space-y-4">
            <div>
              <h3 className="text-base font-medium">Wishlist sharing</h3>
              <p className="text-xs text-fg-subtle mt-1">
                Your own Cloudflare Worker, used to publish a wishlist behind a
                private link. Deploy <code>worker/</code> with{" "}
                <code>wrangler deploy</code>, then paste its URL and the{" "}
                <code>APP_SHARED_SECRET</code> you set on it. The secret is
                stored in the Windows Credential Manager. Leave this blank and
                the Wishlist page's <em>Copy as text</em> still works.
              </p>
            </div>

            <form onSubmit={onShareSave} className="space-y-3">
              <div>
                <label className="label">Worker URL</label>
                <input
                  className="input"
                  type="url"
                  value={shareUrl}
                  onChange={(e) => setShareUrl(e.target.value)}
                  autoComplete="off"
                  placeholder="https://diecast-hunter-ebay.you.workers.dev"
                />
              </div>
              <div>
                <label className="label">
                  Shared secret{" "}
                  {shareSettings?.has_secret && (
                    <span className="text-fg-subtle normal-case">
                      (saved — leave blank to keep)
                    </span>
                  )}
                </label>
                <input
                  className="input"
                  type="password"
                  value={shareSecret}
                  onChange={(e) => setShareSecret(e.target.value)}
                  autoComplete="off"
                  placeholder={shareSettings?.has_secret ? "••••••••" : ""}
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  className="btn-primary"
                  type="submit"
                  disabled={shareBusy}
                >
                  {shareBusy ? "Saving…" : "Save"}
                </button>
                {(shareSettings?.worker_url || shareSettings?.has_secret) && (
                  <button
                    className="btn-danger"
                    type="button"
                    onClick={onShareClear}
                    disabled={shareBusy}
                  >
                    Remove
                  </button>
                )}
              </div>
              {shareNotice && (
                <NoticeBanner
                  variant="inline"
                  tone="success"
                  message={shareNotice}
                />
              )}
              {shareError !== null && (
                <ErrorBanner error={shareError} variant="inline" />
              )}
            </form>
          </section>

          {/* Its own card: the one above is a credential, this is a list of
              live things published under someone's name (DCH-21, DCH-48). */}
          <section className="card space-y-4">
            <div>
              <h3 className="text-base font-medium">Active links</h3>
              <p className="text-xs text-fg-subtle mt-1">
                Pages you've published from the Saved Listings page. Each is
                public to anyone holding its link until it expires or you turn
                it off here.
              </p>
            </div>

            {sharesNotice && (
              <NoticeBanner
                variant="inline"
                tone={sharesNotice.tone}
                message={sharesNotice.message}
              />
            )}
            {sharesError !== null && (
              <ErrorBanner error={sharesError} variant="inline" />
            )}

            {shares === null ? (
              <p className="text-sm text-fg-muted">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No links yet. Turn on Select mode on Saved Listings, pick some
                listings, then choose <em>Share selection…</em>.
              </p>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => {
                  const expiry = describeExpiry(
                    s.expires_at,
                    Math.floor(Date.now() / 1000),
                  );
                  return (
                    <li
                      key={s.id}
                      className="rounded border border-border bg-bg-elevated px-3 py-2 space-y-1"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium truncate">
                          {s.label}
                        </span>
                        <span
                          className={`shrink-0 text-[11px] ${
                            expiry.expired ? "text-fg" : "text-fg-subtle"
                          }`}
                        >
                          {expiry.text}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] break-all text-fg-muted">
                        {s.url}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-fg-subtle">
                        <span>
                          {formatCount(s.item_count)} listings ·{" "}
                          {formatDate(s.shared_at)}
                        </span>
                        <button
                          type="button"
                          className="text-fg-muted hover:text-fg"
                          onClick={() => void onCopyShare(s)}
                        >
                          Copy link
                        </button>
                        <button
                          type="button"
                          className="link-danger"
                          onClick={() => void onRevokeShare(s)}
                          disabled={sharesBusy === s.id}
                        >
                          {sharesBusy === s.id ? "Turning off…" : "Turn off"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      {tab === "sync" && (
        <>
          <section className="card space-y-4">
            <div>
              <h3 className="text-base font-medium">
                Automatic background sync
              </h3>
              <p className="text-xs text-fg-subtle mt-1">
                Registers a Windows scheduled task that syncs your collection
                (My Garage) and eBay (watchlist + saved searches/sellers) on a
                timer — even when this app is closed, as long as you're signed
                in to Windows. Whichever source isn't configured —
                diecastregistry.com credentials or a connected eBay account — is
                skipped. Interval is in hours (1–23).
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
                  <label className="label">
                    Max registry entries per refresh
                  </label>
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
                <div>
                  <label className="label">Max detail pages per sync</label>
                  <input
                    className="input w-32"
                    type="number"
                    min={0}
                    step={100}
                    value={autoSyncEnrichMax}
                    disabled={!autoSyncEnabled}
                    onChange={(e) => setAutoSyncEnrichMax(e.target.value)}
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
                never tries the whole registry at once. Drivers that don't fit
                are picked up on later runs, oldest first. Set to 0 to skip the
                registry refresh entirely.
              </p>
              <p className="text-xs text-fg-subtle">
                Detail pages fill in an entry's specifics (finish, values,
                photos). Each sync fetches at most this many, prioritizing
                entries in your collection, matched to a saved listing, or on a
                wishlist; the rest wait for later runs. Entries none of those
                reference are fetched once and not refreshed.{" "}
                <em>Force refresh all</em> (under Registry details) ignores this
                cap. Set to 0 to skip detail fetching entirely.
              </p>
            </form>

            <div className="space-y-1">
              <div className="text-xs">
                {autoSyncEnabled && autoSyncScheduled && (
                  <span className="text-emerald-400">
                    ✓ Scheduled task registered
                  </span>
                )}
                {autoSyncEnabled && !autoSyncScheduled && (
                  <span className="text-amber-400">
                    ⚠ Enabled, but no scheduled task is registered — click Save
                    to (re)create it.
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
                  ? `Last background sync ${formatDateTime(autoSyncLastRun)}`
                  : "Background sync hasn't run yet."}
              </div>
            </div>

            {autoSyncMessage && (
              <div className="text-xs text-emerald-400">{autoSyncMessage}</div>
            )}
            {autoSyncError && (
              <ErrorBanner error={autoSyncError} variant="inline" />
            )}
          </section>
          <section className="card space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Sync My Garage</div>
                  <div className="text-xs text-fg-subtle">
                    {lastSync
                      ? `Last synced ${formatDateTime(Number(lastSync))}`
                      : "Never synced"}
                  </div>
                </div>
                <button
                  className="btn-primary"
                  type="button"
                  disabled={syncing || !creds?.diecastregistry_has_password}
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
                      {syncSummary.collection_rows_removed === 1
                        ? "y"
                        : "ies"}{" "}
                      no longer in your garage.
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
              {syncError && <ErrorBanner error={syncError} variant="inline" />}
            </div>
          </section>
          <section className="card space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Registry details</div>
                  <div className="text-xs text-fg-subtle">
                    Re-fetch detail pages for cars in your collection. Stale
                    entries (older than 30 days) refresh automatically,
                    prioritized and capped like the background sync.
                  </div>
                </div>
                <div className="flex gap-2">
                  {/* nowrap on both: this block is its own card since
                      DCH-21, narrower than the combined one it came from,
                      and each label was wrapping to three lines. */}
                  <button
                    className="btn-secondary whitespace-nowrap"
                    type="button"
                    disabled={
                      refreshing || !creds?.diecastregistry_has_password
                    }
                    onClick={() => onRefresh(false)}
                  >
                    {refreshing ? "Refreshing…" : "Refresh stale"}
                  </button>
                  <button
                    className="btn-secondary whitespace-nowrap"
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
                  {refreshSummary.considered} ({refreshSummary.failed} failed,{" "}
                  {refreshSummary.skipped} skipped).
                </div>
              )}
              {refreshError && (
                <ErrorBanner error={refreshError} variant="inline" />
              )}
            </div>
          </section>
          <section className="card space-y-4">
            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium">
                  Pre-warm registry by driver
                </div>
                <div className="text-xs text-fg-subtle mt-1">
                  Pull every registry entry for one driver and store them
                  locally so the registry-search dialog can surface candidates
                  without hitting diecastregistry.com on every keystroke. Takes
                  a minute or two for a prolific driver — pages are paced to be
                  polite. Repeat for every driver you watch.
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
                <ErrorBanner error={prewarmError} variant="inline" />
              )}
            </div>
          </section>
          <section className="card space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">
                    Repair diecastregistry.com links
                  </div>
                  <div className="text-xs text-fg-subtle mt-1">
                    Some registry entries saved by older versions lost the URL
                    of their diecastregistry.com page, so matched listings show
                    no "View on diecastregistry.com" link. This re-walks the
                    registry search for the affected drivers and restores the
                    links. Safe to re-run; does nothing when no links are
                    missing.
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
                <ErrorBanner error={linkRepairError} variant="inline" />
              )}
            </div>
          </section>
        </>
      )}

      {tab === "search" && (
        <>
          <section className="card space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">
                    Registry search options
                  </div>
                  <div className="text-xs text-fg-subtle">
                    Cache driver / OEM / brand / scale / finish dropdown choices
                    from diecastregistry.com. Used by the "Search registry…"
                    dialog on saved listings. Refresh occasionally to pick up
                    new drivers / brands.
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
                <ErrorBanner error={optionsError} variant="inline" />
              )}
            </div>
          </section>
          <section className="card space-y-4">
            <div className="space-y-3">
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
                  ] as {
                    mode: RegistrySearchMode;
                    label: string;
                    hint: string;
                  }[]
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
                  <ErrorBanner
                    error={searchModeError}
                    variant="inline"
                    className="mt-1"
                  />
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
                                <span className="truncate">
                                  {d.driver_name}
                                </span>
                                <span className="shrink-0 text-fg-subtle">
                                  {d.entry_count} entr
                                  {d.entry_count === 1 ? "y" : "ies"} ·{" "}
                                  {formatDate(d.last_prewarmed_at)}
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
          </section>
          <section className="card space-y-4">
            <div className="space-y-3">
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
                <ErrorBanner error={filterError} variant="inline" />
              )}
            </div>
          </section>
          <section className="card space-y-4">
            <div className="space-y-3">
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

              <form
                onSubmit={onSaveBuyerZip}
                className="flex items-center gap-2"
              >
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
                <div className="text-xs text-emerald-400">
                  {buyerZipMessage}
                </div>
              )}
              {buyerZipError && (
                <ErrorBanner error={buyerZipError} variant="inline" />
              )}
            </div>
          </section>
          <MatcherLearningSection />
        </>
      )}

      {tab === "extension" && <ExtensionSection />}

      {message && <div className="text-sm text-emerald-400">{message}</div>}
      {error && <ErrorBanner error={error} variant="inline" />}
    </div>
  );
}

/** Browser extension + background mode: the embedded localhost receiver's
 *  endpoint/secret for the eBay extension, and the tray/autostart toggles
 *  that keep it available while the window is closed. */
function ExtensionSection() {
  const [status, setStatus] = useState<ListingReceiverStatus | null>(null);
  const [bg, setBg] = useState<BackgroundSettings | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setStatus(await api.getListingReceiverStatus());
      setBg(await api.getBackgroundSettings());
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onToggle = async (patch: Partial<BackgroundSettings>) => {
    if (!bg) return;
    const next = { ...bg, ...patch };
    setBg(next);
    setError(null);
    try {
      await api.setBackgroundSettings(next.run_in_background, next.autostart);
    } catch (e) {
      setError(String(e));
      void load();
    }
  };

  const onReveal = async () => {
    setError(null);
    try {
      setSecret(await api.getListingReceiverSecret());
    } catch (e) {
      setError(String(e));
    }
  };

  const onCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`${label} copied.`);
    } catch (e) {
      setError(String(e));
    }
  };

  const onRegenerate = async () => {
    if (
      !window.confirm(
        "Regenerate the shared secret? The browser extension will stop " +
          "working until you paste the new secret into its options page.",
      )
    ) {
      return;
    }
    setError(null);
    try {
      setSecret(await api.regenerateListingReceiverSecret());
      setMessage("Secret regenerated — update the extension's options.");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="card space-y-4">
      <div>
        <h3 className="text-base font-medium">
          Browser extension &amp; background
        </h3>
        <p className="text-xs text-fg-subtle mt-1">
          The eBay browser extension talks to a local server inside this app to
          show registry matches and valuations while you browse. Copy the
          endpoint and secret into the extension&apos;s options page. The
          toggles below keep that server available when the window is closed.
        </p>
      </div>

      {status && (
        <div className="text-sm space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-fg-subtle">Endpoint:</span>
            <code className="text-xs bg-bg-elevated border border-border rounded px-1.5 py-0.5">
              {status.url}
            </code>
            <button
              className="text-xs text-accent hover:underline"
              type="button"
              onClick={() => onCopy(status.url, "Endpoint")}
            >
              Copy
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-fg-subtle">Shared secret:</span>
            {secret ? (
              <>
                <code className="text-xs bg-bg-elevated border border-border rounded px-1.5 py-0.5">
                  {secret}
                </code>
                <button
                  className="text-xs text-accent hover:underline"
                  type="button"
                  onClick={() => onCopy(secret, "Secret")}
                >
                  Copy
                </button>
              </>
            ) : (
              <button
                className="text-xs text-accent hover:underline"
                type="button"
                onClick={onReveal}
              >
                Reveal
              </button>
            )}
            <button
              className="text-xs text-fg-subtle hover:text-fg"
              type="button"
              onClick={onRegenerate}
            >
              Regenerate
            </button>
          </div>
        </div>
      )}

      {bg && (
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-accent"
              checked={bg.run_in_background}
              onChange={(e) =>
                onToggle({ run_in_background: e.target.checked })
              }
            />
            Keep running in the background when the window is closed (tray icon
            reopens it)
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-accent"
              checked={bg.autostart}
              onChange={(e) => onToggle({ autostart: e.target.checked })}
            />
            Start Diecast Hunter at login
          </label>
        </div>
      )}

      {message && <div className="text-xs text-emerald-400">{message}</div>}
      {error && <ErrorBanner error={error} variant="inline" />}
    </section>
  );
}

/** Auto-match learning: retrain the scorer from confirm/reject verdicts,
 *  show which weights are active, and revert to the built-ins. */
function MatcherLearningSection() {
  const [status, setStatus] = useState<MatcherStatus | null>(null);
  const [training, setTraining] = useState(false);
  const [outcome, setOutcome] = useState<TrainOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWeights, setShowWeights] = useState(false);

  const loadStatus = async () => {
    try {
      setStatus(await api.matcherStatus());
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRetrain = async () => {
    setTraining(true);
    setError(null);
    setOutcome(null);
    try {
      setOutcome(await api.retrainMatcher());
      await loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setTraining(false);
    }
  };

  const onReset = async () => {
    setError(null);
    setOutcome(null);
    try {
      await api.resetMatcherModel();
      await loadStatus();
    } catch (e) {
      setError(String(e));
    }
  };

  const pct = (v: number | null | undefined) =>
    v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`;

  return (
    <section className="card space-y-4">
      <div>
        <h3 className="text-base font-medium">Auto-match learning</h3>
        <p className="text-xs text-fg-subtle mt-1">
          Every match you confirm, reject, or re-link is recorded and used to
          tune the auto-matcher&apos;s scoring weights to your collection.
          Retraining also runs automatically at startup once enough new verdicts
          accumulate. A learned model only activates when it beats the built-in
          weights in cross-validation.
        </p>
      </div>

      {status && (
        <div className="text-sm space-y-1">
          <div>
            Active weights:{" "}
            {status.learned ? (
              <span className="text-emerald-400">
                learned
                {status.trained_at
                  ? ` (trained ${formatDateTime(status.trained_at)})`
                  : ""}
              </span>
            ) : (
              <span>built-in defaults</span>
            )}
          </div>
          {status.learned && (
            <div className="text-xs text-fg-subtle">
              Verdict accuracy {pct(status.cv_accuracy)} vs{" "}
              {pct(status.cv_accuracy_baseline)} built-in · ranking accuracy{" "}
              {pct(status.cv_rank_accuracy)} vs{" "}
              {pct(status.cv_rank_accuracy_baseline)} built-in — trained on{" "}
              {status.positives ?? 0} confirms,{" "}
              {(status.explicit_negatives ?? 0) +
                (status.implicit_negatives ?? 0)}{" "}
              negatives ({status.implicit_negatives ?? 0} implied by runner-up
              candidates).
            </div>
          )}
          <div className="text-xs text-fg-subtle">
            Last training run:{" "}
            {status.last_train_at
              ? formatDateTime(status.last_train_at)
              : "never"}
          </div>
          <div className="text-xs text-fg-subtle">
            {status.feedback_rows} verdicts recorded
            {status.new_since_train !== null
              ? ` (${status.new_since_train} since last training)`
              : ""}
            {status.learned_aliases > 0
              ? ` · ${status.learned_aliases} learned scheme aliases`
              : ""}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          className="btn-secondary"
          type="button"
          onClick={onRetrain}
          disabled={training}
        >
          {training ? "Training…" : "Retrain now"}
        </button>
        {status?.learned && (
          <button className="btn-secondary" type="button" onClick={onReset}>
            Revert to built-in weights
          </button>
        )}
        {status && (
          <button
            className="btn-secondary"
            type="button"
            onClick={() => setShowWeights((v) => !v)}
          >
            {showWeights ? "Hide weights" : "Show weights"}
          </button>
        )}
      </div>

      {outcome && (
        <div
          className={`text-xs ${outcome.activated ? "text-emerald-400" : "text-amber-400"}`}
        >
          {outcome.message}
          {outcome.learned_aliases > 0 &&
            ` Learned ${outcome.learned_aliases} scheme aliases.`}
        </div>
      )}
      {error && <ErrorBanner error={error} variant="inline" />}

      {showWeights && status && (
        <table className="text-xs w-full max-w-md">
          <thead>
            <tr className="text-left text-fg-subtle">
              <th className="py-1 pr-4 font-normal">Signal</th>
              <th className="py-1 pr-4 font-normal">Built-in</th>
              <th className="py-1 font-normal">Learned</th>
            </tr>
          </thead>
          <tbody>
            {status.weights.map((w) => (
              <tr key={w.name}>
                <td className="py-0.5 pr-4 font-mono">{w.name}</td>
                <td className="py-0.5 pr-4 tabular-nums">
                  {w.default_weight.toFixed(1)}
                </td>
                <td className="py-0.5 tabular-nums">
                  {w.learned_weight === null
                    ? "–"
                    : w.learned_weight.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
