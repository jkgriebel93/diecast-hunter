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
  registerDiecastInGarage: (input: RegisterDiecastInput) =>
    invoke<RegisterDiecastSummary>("register_diecast_in_garage", { input }),
  refreshRegistryDetails: (force: boolean) =>
    invoke<EnrichSummary>("refresh_registry_details", { force }),
  listDriversWithCounts: () =>
    invoke<DriverGroup[]>("list_drivers_with_counts"),
  listCollectionForDriver: (driverId: number) =>
    invoke<CollectionRow[]>("list_collection_for_driver", { driverId }),
  listAllCollectionItems: () =>
    invoke<CollectionRow[]>("list_all_collection_items"),
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
  searchEbayListings: (
    query: string,
    filters: EbaySearchFilters,
    limit: number,
    offset: number,
  ) =>
    invoke<EbaySearchPage>("search_ebay_listings", {
      query,
      filters,
      limit,
      offset,
    }),
  watchEbayListing: (input: string) =>
    invoke<AddListingResult>("watch_ebay_listing", { input }),
  unwatchEbayListing: (listingId: number) =>
    invoke<void>("unwatch_ebay_listing", { listingId }),
  listEbayOffers: () => invoke<ReceivedOffer[]>("list_ebay_offers"),
  refreshEbayListing: (listingId: number) =>
    invoke<void>("refresh_ebay_listing", { listingId }),
  refreshAllEbayListings: () =>
    invoke<RefreshSummary>("refresh_all_ebay_listings"),
  syncEbayWatchlist: () =>
    invoke<WatchlistSyncSummary>("sync_ebay_watchlist"),
  listListings: () => invoke<ListingRow[]>("list_listings"),
  clearListingMatch: (listingId: number) =>
    invoke<void>("clear_listing_match", { listingId }),
  rejectListingMatch: (listingId: number) =>
    invoke<void>("reject_listing_match", { listingId }),
  refreshRegistryFormOptions: () =>
    invoke<RefreshOptionsSummary>("refresh_registry_form_options"),
  listRegistryFormOptions: (field: string) =>
    invoke<FormOptionRow[]>("list_registry_form_options", { field }),
  searchDcrProduction: (filter: ProductionSearchFilter) =>
    invoke<ProductionSearchResult[]>("search_dcr_production", { filter }),
  linkListingToRegistry: (
    listingId: number,
    registryGuid: string,
    detailUrl: string | null,
  ) =>
    invoke<LinkResult>("link_listing_to_registry", {
      listingId,
      registryGuid,
      detailUrl,
    }),
  getListingReceiverStatus: () =>
    invoke<ListingReceiverStatus>("get_listing_receiver_status"),
  getListingReceiverSecret: () =>
    invoke<string>("get_listing_receiver_secret"),
  regenerateListingReceiverSecret: () =>
    invoke<string>("regenerate_listing_receiver_secret"),
  prewarmRegistryByDriver: (driverGuid: string) =>
    invoke<PrewarmSummary>("prewarm_registry_by_driver", { driverGuid }),
  cancelActiveOperation: () => invoke<boolean>("cancel_active_operation"),
  getEbayFilterNonDiecasts: () =>
    invoke<boolean>("get_ebay_filter_non_diecasts"),
  setEbayFilterNonDiecasts: (enabled: boolean) =>
    invoke<void>("set_ebay_filter_non_diecasts", { enabled }),
  removeNonDiecastListings: () =>
    invoke<CleanupSummary>("remove_non_diecast_listings"),
  listSavedSearches: () => invoke<SavedSearch[]>("list_saved_searches"),
  createSavedSearch: (input: SavedSearchInput) =>
    invoke<SavedSearch>("create_saved_search", { input }),
  updateSavedSearch: (id: number, input: SavedSearchInput) =>
    invoke<SavedSearch>("update_saved_search", { id, input }),
  deleteSavedSearch: (id: number) =>
    invoke<void>("delete_saved_search", { id }),
  runSavedSearch: (id: number, limit: number, offset: number) =>
    invoke<EbaySearchPage>("run_saved_search", { id, limit, offset }),
  listSavedSellers: () => invoke<SavedSeller[]>("list_saved_sellers"),
  addSavedSeller: (input: SavedSellerInput) =>
    invoke<SavedSeller>("add_saved_seller", { input }),
  updateSavedSeller: (id: number, input: SavedSellerInput) =>
    invoke<SavedSeller>("update_saved_seller", { id, input }),
  removeSavedSeller: (id: number) =>
    invoke<void>("remove_saved_seller", { id }),
  savedSellersFeed: (
    query: string,
    filters: EbaySearchFilters,
    limit: number,
    offset: number,
  ) =>
    invoke<EbaySearchPage>("saved_sellers_feed", {
      query,
      filters,
      limit,
      offset,
    }),
  syncEbaySaved: () => invoke<SavedSyncSummary>("sync_ebay_saved"),
  syncEbayAll: () => invoke<EbaySyncAllSummary>("sync_ebay_all"),
};

export interface SavedSyncSummary {
  searches_seen: number;
  searches_created: number;
  searches_updated: number;
  searches_pruned: number;
  sellers_seen: number;
  sellers_created: number;
  sellers_updated: number;
  sellers_pruned: number;
}

export interface EbaySyncAllSummary {
  watchlist: WatchlistSyncSummary;
  saved: SavedSyncSummary;
}

export interface SavedSearch {
  id: number;
  name: string;
  query: string;
  conditions: string[];
  buying_options: string[];
  sellers: string[];
  price_min_cents: number | null;
  price_max_cents: number | null;
  sort: string | null;
  created_at: number;
  last_run_at: number | null;
  /** True when this row was pulled from eBay (and is therefore subject to
   *  prune on the next sync). False for locally-added rows. */
  ebay_origin: boolean;
  ebay_external_id: string | null;
  last_synced_at: number | null;
}

export interface SavedSearchInput {
  name: string;
  query: string;
  conditions: string[];
  buying_options: string[];
  sellers: string[];
  price_min_cents: number | null;
  price_max_cents: number | null;
  sort: string | null;
}

export interface SavedSeller {
  id: number;
  seller_code: string;
  username: string;
  display_name: string | null;
  notes: string | null;
  created_at: number;
  ebay_origin: boolean;
  last_synced_at: number | null;
}

export interface SavedSellerInput {
  seller_code: string;
  username: string;
  display_name: string | null;
  notes: string | null;
}

export interface CleanupSummary {
  examined: number;
  removed: number;
}

export interface PrewarmSummary {
  driver_name: string;
  results_seen: number;
  registry_entries_upserted: number;
  pages_fetched: number;
}

export interface ListingReceiverStatus {
  url: string;
  port: number;
  has_secret: boolean;
}

export interface RefreshOptionsSummary {
  fields_seen: number;
  options_upserted: number;
}

export interface FormOptionRow {
  value: string;
  display: string;
  normalized: string;
}

export interface ProductionSearchFilter {
  diecast_type?: string;
  driver_guids?: string[];
  year_opt?: string;
  years?: string[];
  oem_guids?: string[];
  brand_guids?: string[];
  make_guids?: string[];
  scale_guids?: string[];
  finish_guids?: string[];
  autographed?: boolean;
  raced?: boolean;
}

export interface ProductionSearchResult {
  registry_guid: string;
  detail_url: string | null;
  image_url: string | null;
  driver_name: string;
  driver_normalized: string;
  year: number | null;
  oem: string | null;
  brand: string | null;
  scale: string | null;
  make: string | null;
  scheme_text: string | null;
  seq_produced_total: number | null;
  retail_value_cents: number | null;
  wholesale_value_cents: number | null;
}

export interface LinkResult {
  registry_entry_id: number;
  enriched: boolean;
}

export type Condition =
  | "mint"
  | "excellent"
  | "very_good"
  | "good"
  | "average"
  | "below_average"
  | "new";

export interface RegisterDiecastInput {
  registry_guid: string;
  condition: Condition;
  autographed: boolean;
  prototype: boolean;
  chassis_number: number | null;
  comments: string | null;
}

export interface RegisterDiecastSummary {
  registration_number: string;
  registry_int_id: number;
  refreshed_items_seen: number;
}

export interface WatchlistSyncSummary {
  items_seen: number;
  created: number;
  updated: number;
  failed: number;
  filtered: number;
  pages_fetched: number;
  /** Local listings deleted because they're no longer on the eBay watchlist. */
  pruned: number;
}

export interface EbayCredentialsState {
  environment: string;
  has_app_id: boolean;
  has_cert_id: boolean;
}

export interface AddListingResult {
  /** null when the listing was filtered out (see filtered_reason). */
  listing_id: number | null;
  created: boolean;
  title: string;
  filtered_reason: string | null;
}

export interface EbaySearchFilters {
  conditions: string[];
  price_min_cents: number | null;
  price_max_cents: number | null;
  buying_options: string[];
  /** Restrict to specific eBay seller usernames. Empty array → no restriction. */
  sellers: string[];
  sort: string | null;
}

export interface EbaySearchItem {
  item_id: string;
  legacy_item_id: string | null;
  title: string;
  price_cents: number | null;
  shipping_cents: number | null;
  currency: string;
  condition: string | null;
  listing_type: string | null;
  seller_username: string | null;
  seller_rating: number | null;
  image_url: string | null;
  web_url: string;
  end_time: number | null;
}

export interface EbaySearchPage {
  items: EbaySearchItem[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ReceivedOffer {
  message_id: string;
  item_id: string;
  item_title: string;
  /** Deep-link to the listing on eBay. */
  item_web_url: string;
  /** Image from the local listings table when watchlist has been synced. */
  item_image_url: string | null;
  /** Buy-It-Now price quoted in the offer email. */
  original_price_cents: number | null;
  offer_price_cents: number | null;
  currency: string;
  /** % off, parsed from the message subject. */
  discount_percent: number | null;
  /** Raw "Offer expires: May-14 15:58:53 PDT" text — fallback display. */
  expires_at_text: string | null;
  /** Best-effort Unix timestamp; null when the format/timezone isn't recognized. */
  expires_at: number | null;
  received_at: number;
  is_read: boolean;
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
  registry_entry_id: number | null;
  match_confidence: number | null;
  match_user_confirmed: boolean;
  matched_driver_name: string | null;
  matched_scheme_text: string | null;
  matched_year: number | null;
  matched_oem: string | null;
  matched_brand: string | null;
  matched_scale: string | null;
  matched_retail_cents: number | null;
  matched_wholesale_cents: number | null;
  /** Site-relative path on diecastregistry.com to the matched entry's detail page. */
  matched_detail_url: string | null;
  /** Total (price + shipping) as percentage of registry retail. Lower = better deal. */
  deal_score: number | null;
}

export function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}
