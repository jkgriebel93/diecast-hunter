import { invoke } from "@tauri-apps/api/core";

export interface AppStatus {
  db_path: string;
  schema_version: number;
  registry_count: number;
  collection_count: number;
  listing_count: number;
}

export interface CredentialState {
  diecastregistry_username: string | null;
  diecastregistry_has_password: boolean;
  ebay_connected: boolean;
}

export interface EnrichSummary {
  considered: number;
  enriched: number;
  skipped: number;
  failed: number;
}

export interface SyncSummary {
  items_seen: number;
  drivers_upserted: number;
  registry_entries_upserted: number;
  collection_rows_upserted: number;
  pages_fetched: number;
  enrichment: EnrichSummary | null;
}

export interface DriverGroup {
  driver_id: number;
  driver_name: string;
  item_count: number;
  retail_total_cents: number;
  wholesale_total_cents: number;
}

export interface CollectionRow {
  collection_id: number;
  asset_guid: string;
  driver_id: number | null;
  driver_name: string | null;
  year: number | null;
  year_raced: number | null;
  car_number: string | null;
  diecast_type: string | null;
  registration_number: string | null;
  oem: string | null;
  brand: string | null;
  scale: string | null;
  make: string | null;
  finish: string | null;
  production_qty: number | null;
  scheme_text: string | null;
  image_url: string | null;
  detail_url: string | null;
  retail_value_cents: number | null;
  wholesale_value_cents: number | null;
  registry_int_id: number | null;
  enriched: boolean;
}

export const api = {
  status: () => invoke<AppStatus>("app_status"),
  getCredentials: () => invoke<CredentialState>("get_credentials"),
  saveDiecastRegistryCredentials: (username: string, password: string) =>
    invoke<void>("save_diecastregistry_credentials", { username, password }),
  clearDiecastRegistryCredentials: () =>
    invoke<void>("clear_diecastregistry_credentials"),
  getSetting: (key: string) =>
    invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  syncDcrCollection: () => invoke<SyncSummary>("sync_dcr_collection"),
  refreshRegistryDetails: (force: boolean) =>
    invoke<EnrichSummary>("refresh_registry_details", { force }),
  listDriversWithCounts: () =>
    invoke<DriverGroup[]>("list_drivers_with_counts"),
  listCollectionForDriver: (driverId: number) =>
    invoke<CollectionRow[]>("list_collection_for_driver", { driverId }),
  getEbayCredentials: () =>
    invoke<EbayCredentialsState>("get_ebay_credentials"),
  saveEbayCredentials: (
    appId: string,
    certId: string,
    environment: string,
  ) =>
    invoke<void>("save_ebay_credentials", {
      appId,
      certId,
      environment,
    }),
  clearEbayCredentials: () => invoke<void>("clear_ebay_credentials"),
  testEbayConnection: () => invoke<string>("test_ebay_connection"),
  getEbayRuName: () => invoke<string | null>("get_ebay_ru_name"),
  saveEbayRuName: (ruName: string) =>
    invoke<void>("save_ebay_ru_name", { ruName }),
  getEbayOauthStatus: () =>
    invoke<EbayOauthStatus>("get_ebay_oauth_status"),
  startEbayOauth: () => invoke<string>("start_ebay_oauth"),
  completeEbayOauth: (code: string) =>
    invoke<void>("complete_ebay_oauth", { code }),
  disconnectEbayOauth: () => invoke<void>("disconnect_ebay_oauth"),
  addEbayListing: (input: string) =>
    invoke<AddListingResult>("add_ebay_listing", { input }),
  refreshEbayListing: (listingId: number) =>
    invoke<void>("refresh_ebay_listing", { listingId }),
  refreshAllEbayListings: () =>
    invoke<RefreshSummary>("refresh_all_ebay_listings"),
  syncEbayWatchlist: () =>
    invoke<WatchlistSyncSummary>("sync_ebay_watchlist"),
  listListings: () => invoke<ListingRow[]>("list_listings"),
};

export interface WatchlistSyncSummary {
  items_seen: number;
  created: number;
  updated: number;
  failed: number;
  pages_fetched: number;
}

export interface EbayCredentialsState {
  environment: string;
  has_app_id: boolean;
  has_cert_id: boolean;
}

export interface AddListingResult {
  listing_id: number;
  created: boolean;
  title: string;
}

export interface RefreshSummary {
  considered: number;
  refreshed: number;
  failed: number;
}

export interface EbayOauthStatus {
  connected: boolean;
  environment: string;
  has_ru_name: boolean;
  granted_scopes: string[];
  access_token_expires_at: number | null;
}

export interface ListingRow {
  listing_id: number;
  seller_code: string;
  external_id: string;
  url: string;
  title: string;
  price_cents: number | null;
  shipping_cents: number | null;
  currency: string;
  condition: string | null;
  listing_type: string | null;
  status: string;
  end_time: number | null;
  seller_username: string | null;
  seller_rating: number | null;
  image_url: string | null;
  saved_at: number;
  last_seen_at: number;
}

export function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}
