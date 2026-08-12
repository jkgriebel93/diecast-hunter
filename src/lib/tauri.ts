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
  /** Local entries deleted because they're no longer in the DCR garage. */
  collection_rows_removed: number;
  pages_fetched: number;
  enrichment: EnrichSummary | null;
}

export interface AutoSyncSettings {
  enabled: boolean;
  interval_hours: number;
  /** Unix timestamp of the last background-sync attempt, or null if never run. */
  last_run: number | null;
  /** Whether the Windows scheduled task is actually registered. */
  scheduled: boolean;
  /** Cap on registry entries the pre-warm refresh re-walks per sync run. 0 = disabled. */
  prewarm_max_entries: number;
}

export interface RemoveEntrySummary {
  /** False = the asset wasn't in the DCR garage; the local row was removed
   *  anyway and the UI should show a neutral notice, not an error. */
  found_on_dcr: boolean;
  /** True for a manually-added entry, which was never on DCR to begin with.
   *  `found_on_dcr: false` means nothing in that case — report plain
   *  success rather than a "wasn't in your garage" notice. */
  was_local: boolean;
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
  /** Added by hand rather than synced from DCR — a car the registry doesn't
   *  list. Such a row has no appraisal, so `retail_value_cents` is null and
   *  `paid_cents` is the only figure behind it. */
  is_local: boolean;
  /** What the user paid, in cents. A cost basis, never an appraisal. */
  paid_cents: number | null;
  condition: string | null;
  notes: string | null;
}

/** Fields of a manually-added collection entry. Mirrors
 *  `local_collection::LocalEntryInput` (camelCase over the wire). */
export interface LocalEntryInput {
  driverName: string;
  schemeText: string;
  year: number | null;
  yearRaced: number | null;
  carNumber: string | null;
  oem: string | null;
  brand: string | null;
  scale: string | null;
  make: string | null;
  finish: string | null;
  diecastType: string | null;
  productionQty: number | null;
  paidCents: number | null;
  condition: string | null;
  notes: string | null;
  imageUrl: string | null;
}

export interface LocalEntrySummary {
  collection_id: number;
  registry_entry_id: number;
  driver_id: number;
}

export const api = {
  status: () => invoke<AppStatus>("app_status"),
  getCredentials: () => invoke<CredentialState>("get_credentials"),
  saveDiecastRegistryCredentials: (username: string, password: string) =>
    invoke<void>("save_diecastregistry_credentials", { username, password }),
  clearDiecastRegistryCredentials: () =>
    invoke<void>("clear_diecastregistry_credentials"),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  getAutoSyncSettings: () => invoke<AutoSyncSettings>("get_auto_sync_settings"),
  setAutoSyncSettings: (
    enabled: boolean,
    intervalHours: number,
    prewarmMaxEntries: number,
  ) =>
    invoke<void>("set_auto_sync_settings", {
      enabled,
      intervalHours,
      prewarmMaxEntries,
    }),
  syncDcrCollection: (enrich: boolean) =>
    invoke<SyncSummary>("sync_dcr_collection", { enrich }),
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
  removeCollectionEntry: (collectionId: number) =>
    invoke<RemoveEntrySummary>("remove_collection_entry", { collectionId }),
  createLocalCollectionEntry: (input: LocalEntryInput) =>
    invoke<LocalEntrySummary>("create_local_collection_entry", { input }),
  updateLocalCollectionEntry: (collectionId: number, input: LocalEntryInput) =>
    invoke<LocalEntrySummary>("update_local_collection_entry", {
      collectionId,
      input,
    }),
  getEbayCredentials: () =>
    invoke<EbayCredentialsState>("get_ebay_credentials"),
  saveEbayCredentials: (appId: string, certId: string, environment: string) =>
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
  getEbayOauthStatus: () => invoke<EbayOauthStatus>("get_ebay_oauth_status"),
  startEbayOauth: () => invoke<string>("start_ebay_oauth"),
  completeEbayOauth: (code: string) =>
    invoke<void>("complete_ebay_oauth", { code }),
  disconnectEbayOauth: () => invoke<void>("disconnect_ebay_oauth"),
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
  syncEbayWatchlist: () => invoke<WatchlistSyncSummary>("sync_ebay_watchlist"),
  listListings: () => invoke<ListingRow[]>("list_listings"),
  clearListingMatch: (listingId: number) =>
    invoke<void>("clear_listing_match", { listingId }),
  rejectListingMatch: (listingId: number) =>
    invoke<void>("reject_listing_match", { listingId }),
  confirmListingMatch: (listingId: number) =>
    invoke<void>("confirm_listing_match", { listingId }),
  autoMatchListing: (listingId: number) =>
    invoke<AutoMatchOutcome>("auto_match_listing", { listingId }),
  autoMatchAllListings: () =>
    invoke<AutoMatchSummary>("auto_match_all_listings"),
  retrainMatcher: () => invoke<TrainOutcome>("retrain_matcher"),
  getListingReceiverStatus: () =>
    invoke<ListingReceiverStatus>("get_listing_receiver_status"),
  getListingReceiverSecret: () => invoke<string>("get_listing_receiver_secret"),
  regenerateListingReceiverSecret: () =>
    invoke<string>("regenerate_listing_receiver_secret"),
  getBackgroundSettings: () =>
    invoke<BackgroundSettings>("get_background_settings"),
  setBackgroundSettings: (runInBackground: boolean, autostart: boolean) =>
    invoke<void>("set_background_settings", { runInBackground, autostart }),
  matcherStatus: () => invoke<MatcherStatus>("matcher_status"),
  resetMatcherModel: () => invoke<void>("reset_matcher_model"),
  listDrivers: () => invoke<DriverOption[]>("list_drivers"),
  setListingDriver: (
    listingId: number,
    driverName: string,
    driverNormalized: string,
  ) =>
    invoke<number>("set_listing_driver", {
      listingId,
      driverName,
      driverNormalized,
    }),
  clearListingDriver: (listingId: number) =>
    invoke<void>("clear_listing_driver", { listingId }),
  resetListingDriver: (listingId: number) =>
    invoke<number | null>("reset_listing_driver", { listingId }),
  setListingAttributes: (listingId: number, attrs: ListingAttributes) =>
    invoke<void>("set_listing_attributes", {
      listingId,
      oem: attrs.oem,
      brand: attrs.brand,
      finish: attrs.finish,
      make: attrs.make,
      isRaceWin: attrs.is_race_win,
      isAutographed: attrs.is_autographed,
      productionCount: attrs.production_count,
    }),
  resetListingAttributes: (listingId: number) =>
    invoke<void>("reset_listing_attributes", { listingId }),
  refreshRegistryFormOptions: () =>
    invoke<RefreshOptionsSummary>("refresh_registry_form_options"),
  listRegistryFormOptions: (field: string) =>
    invoke<FormOptionRow[]>("list_registry_form_options", { field }),
  searchDcrProduction: (filter: ProductionSearchFilter) =>
    invoke<ProductionSearchResult[]>("search_dcr_production", { filter }),
  getRegistrySearchMode: () =>
    invoke<RegistrySearchMode>("get_registry_search_mode"),
  setRegistrySearchMode: (mode: RegistrySearchMode) =>
    invoke<void>("set_registry_search_mode", { mode }),
  listRegistryPresearches: () =>
    invoke<Presearch[]>("list_registry_presearches"),
  createRegistryPresearch: (input: PresearchInput) =>
    invoke<number>("create_registry_presearch", { input }),
  updateRegistryPresearch: (id: number, input: PresearchInput) =>
    invoke<void>("update_registry_presearch", { id, input }),
  deleteRegistryPresearch: (id: number) =>
    invoke<void>("delete_registry_presearch", { id }),
  refreshRegistryPresearch: (id: number) =>
    invoke<number>("refresh_registry_presearch", { id }),
  exportRegistrySearchHtml: (
    results: ProductionSearchResult[],
    finishLabel: string | null,
    path: string,
  ) =>
    invoke<ExportSummary>("export_registry_search_html", {
      results,
      finishLabel,
      path,
    }),
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
  prewarmRegistryByDriver: (driverGuid: string) =>
    invoke<PrewarmSummary>("prewarm_registry_by_driver", { driverGuid }),
  backfillRegistryDetailUrls: () =>
    invoke<DetailUrlBackfillSummary>("backfill_registry_detail_urls"),
  listPrewarmedDrivers: () =>
    invoke<PrewarmedDriver[]>("list_prewarmed_drivers"),
  cancelActiveOperation: () => invoke<boolean>("cancel_active_operation"),
  getEbayFilterNonDiecasts: () =>
    invoke<boolean>("get_ebay_filter_non_diecasts"),
  setEbayFilterNonDiecasts: (enabled: boolean) =>
    invoke<void>("set_ebay_filter_non_diecasts", { enabled }),
  removeNonDiecastListings: () =>
    invoke<CleanupSummary>("remove_non_diecast_listings"),
  getEbayBuyerZip: () => invoke<string | null>("get_ebay_buyer_zip"),
  setEbayBuyerZip: (zip: string) => invoke<void>("set_ebay_buyer_zip", { zip }),
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
  listHiddenFeedListings: () =>
    invoke<HiddenFeedListing[]>("list_hidden_feed_listings"),
  hideFeedListing: (
    itemId: string,
    title: string | null,
    sellerUsername: string | null,
  ) =>
    invoke<HiddenFeedListing>("hide_feed_listing", {
      itemId,
      title,
      sellerUsername,
    }),
  unhideFeedListing: (itemId: string) =>
    invoke<void>("unhide_feed_listing", { itemId }),
  syncEbayAll: () => invoke<EbaySyncAllSummary>("sync_ebay_all"),
  listListingGroups: () => invoke<ListingGroup[]>("list_listing_groups"),
  createListingGroup: (input: ListingGroupInput) =>
    invoke<ListingGroup>("create_listing_group", { input }),
  updateListingGroup: (id: number, input: ListingGroupInput) =>
    invoke<ListingGroup>("update_listing_group", { id, input }),
  deleteListingGroup: (id: number) =>
    invoke<void>("delete_listing_group", { id }),
  addListingToGroup: (groupId: number, listingId: number) =>
    invoke<void>("add_listing_to_group", { groupId, listingId }),
  removeListingFromGroup: (groupId: number, listingId: number) =>
    invoke<void>("remove_listing_from_group", { groupId, listingId }),
  addListingsToGroup: (groupId: number, listingIds: number[]) =>
    invoke<BulkAddResult>("add_listings_to_group", {
      groupId,
      listingIds,
    }),
  removeListingsFromGroup: (groupId: number, listingIds: number[]) =>
    invoke<number>("remove_listings_from_group", {
      groupId,
      listingIds,
    }),
  ensureDriver: (name: string, normalized: string) =>
    invoke<number>("ensure_driver", { name, normalized }),
  proposeGroupMigration: (handles: string[]) =>
    invoke<GroupMigrationProposal[]>("propose_group_migration", { handles }),
  applyGroupMigration: (items: GroupMigrationItem[]) =>
    invoke<number>("apply_group_migration", { items }),
  listWishlists: () => invoke<WishlistInfo[]>("list_wishlists"),
  createWishlist: (name: string) =>
    invoke<WishlistInfo>("create_wishlist", { name }),
  renameWishlist: (wishlistId: number, name: string) =>
    invoke<void>("rename_wishlist", { wishlistId, name }),
  deleteWishlist: (wishlistId: number) =>
    invoke<void>("delete_wishlist", { wishlistId }),
  addWishlistEntry: (wishlistId: number, result: ProductionSearchResult) =>
    invoke<WishlistAddResult>("add_wishlist_entry", { wishlistId, result }),
  listWishlist: (wishlistId: number) =>
    invoke<WishlistEntry[]>("list_wishlist", { wishlistId }),
  listWishlistedGuids: () => invoke<string[]>("list_wishlisted_guids"),
  reorderWishlist: (orderedIds: number[]) =>
    invoke<void>("reorder_wishlist", { orderedIds }),
  removeWishlistEntry: (entryId: number) =>
    invoke<void>("remove_wishlist_entry", { entryId }),
  moveWishlistEntry: (entryId: number, wishlistId: number) =>
    invoke<void>("move_wishlist_entry", { entryId, wishlistId }),
  setWishlistNotes: (entryId: number, notes: string | null) =>
    invoke<void>("set_wishlist_notes", { entryId, notes }),
  linkListingToWishlist: (entryId: number, listingId: number) =>
    invoke<void>("link_listing_to_wishlist", { entryId, listingId }),
  unlinkListingFromWishlist: (entryId: number, listingId: number) =>
    invoke<void>("unlink_listing_from_wishlist", { entryId, listingId }),
  getShareSettings: () => invoke<ShareSettings>("get_share_settings"),
  saveShareSettings: (workerUrl: string, secret: string) =>
    invoke<ShareSettings>("save_share_settings", { workerUrl, secret }),
  clearShareSettings: () => invoke<ShareSettings>("clear_share_settings"),
  wishlistShareStatus: (wishlistId: number) =>
    invoke<ShareStatus>("wishlist_share_status", { wishlistId }),
  shareWishlist: (
    wishlistId: number,
    opts: {
      includeNotes?: boolean;
      includeCandidates?: boolean;
      ttlDays?: number;
    } = {},
  ) =>
    invoke<ShareStatus>("share_wishlist", {
      wishlistId,
      includeNotes: opts.includeNotes ?? false,
      includeCandidates: opts.includeCandidates ?? false,
      ttlDays: opts.ttlDays ?? 30,
    }),
  revokeWishlistShare: (wishlistId: number) =>
    invoke<ShareStatus>("revoke_wishlist_share", { wishlistId }),
  /** Publish a selection of saved listings as a public page (DCH-48). Each
   *  call mints a new link; nothing is replaced. */
  shareListings: (
    listingIds: number[],
    opts?: {
      label?: string;
      includeValuations?: boolean;
      ttlDays?: number;
    },
  ) =>
    invoke<ShareRecord>("share_listings", {
      listingIds,
      label: opts?.label ?? null,
      includeValuations: opts?.includeValuations ?? null,
      ttlDays: opts?.ttlDays ?? null,
    }),
  listShares: () => invoke<ShareRecord[]>("list_shares"),
  revokeShare: (shareId: number) => invoke<void>("revoke_share", { shareId }),
  addListingsToWishlist: (wishlistId: number, listingIds: number[]) =>
    invoke<WishlistBulkAddResult>("add_listings_to_wishlist", {
      wishlistId,
      listingIds,
    }),
  exportWishlistHtml: (wishlistId: number, path: string) =>
    invoke<ExportSummary>("export_wishlist_html", { wishlistId, path }),
  exportCollectionHtml: (rows: CollectionRow[], path: string) =>
    invoke<ExportSummary>("export_collection_html", { rows, path }),
  exportCollectionCsv: (rows: CollectionRow[], path: string) =>
    invoke<ExportSummary>("export_collection_csv", { rows, path }),
};

/** One named wishlist, for the list-management UI. */
export interface WishlistInfo {
  wishlist_id: number;
  name: string;
  created_at: number;
  entry_count: number;
}

export interface WishlistAddResult {
  entry_id: number;
  registry_entry_id: number;
  /** False when the entry was already on this list. */
  created: boolean;
}

/** Sharing config, as Settings needs it. The secret is never returned. */
export interface ShareSettings {
  worker_url: string | null;
  has_secret: boolean;
}

/** Share state of one wishlist (DCH-46). */
export interface ShareStatus {
  wishlist_id: number;
  /** null when never shared, or after a revoke. */
  slug: string | null;
  url: string | null;
  shared_at: number | null;
  /** Unix seconds. The Worker's KV TTL is the real authority; this is what
   *  lets the UI say "expires in 12 days" without a round trip. */
  expires_at: number | null;
  /** False when no Worker URL / secret is configured — the dialog explains
   *  what's missing rather than offering a button that fails. */
  configured: boolean;
}

/** One row of the `shares` table (DCH-48): a public link with no durable
 *  entity behind it, so the row is the share. */
export interface ShareRecord {
  id: number;
  /** What the slug points at. Only "listings" today. */
  kind: string;
  label: string;
  slug: string;
  url: string;
  item_count: number;
  shared_at: number;
  /** Unix seconds, or null if the Worker didn't say. */
  expires_at: number | null;
}

/** Outcome of bulk-adding saved listings to a wishlist (DCH-45). */
export interface WishlistBulkAddResult {
  /** Listings newly linked to an entry on this list. */
  linked: number;
  /** Listings that were already candidates — skipped without erroring. */
  already_present: number;
  /** Wishes created because the list didn't have that diecast yet. Always
   *  ≤ `linked`; several listings can land on one new entry. */
  entries_created: number;
  /** Listings with no registry match, which can't be represented as a wish. */
  skipped_no_match: number;
}

/** A saved listing linked to a wishlist entry as a purchase candidate. */
export interface WishlistListing {
  listing_id: number;
  seller_code: string;
  title: string;
  url: string;
  price_cents: number | null;
  shipping_cents: number | null;
  currency: string;
  status: string;
  end_time: number | null;
  image_url: string | null;
  linked_at: number;
}

export interface WishlistEntry {
  entry_id: number;
  wishlist_id: number;
  registry_entry_id: number;
  registry_guid: string;
  driver_name: string | null;
  year: number | null;
  oem: string | null;
  brand: string | null;
  scale: string | null;
  make: string | null;
  scheme_text: string | null;
  production_qty: number | null;
  retail_value_cents: number | null;
  wholesale_value_cents: number | null;
  image_url: string | null;
  /** Site-relative path on diecastregistry.com to the entry's detail page. */
  detail_url: string | null;
  notes: string | null;
  added_at: number;
  /** Stack-rank priority within its list; lower = higher priority. Entries
   *  arrive already sorted by this — display rank is just the list index. */
  sort_rank: number;
  /** Linked candidate listings, oldest link first. */
  listings: WishlistListing[];
}

export interface BulkAddResult {
  added: number;
  already_present: number;
}

export interface GroupDriver {
  id: number;
  name: string;
}

export interface ListingGroup {
  id: number;
  name: string;
  description: string | null;
  target_price_cents: number | null;
  archived: boolean;
  created_at: number;
  member_count: number;
  /** Drivers this group is associated with. Empty = driverless. */
  drivers: GroupDriver[];
}

export interface ListingGroupInput {
  name: string;
  description: string | null;
  target_price_cents: number | null;
  archived: boolean;
  /** Driver ids to associate; replaces the existing set on update. */
  driver_ids: number[];
}

export interface GroupMigrationProposal {
  group_id: number;
  original_name: string;
  matched_handle: string | null;
  new_name: string;
  empty_remainder: boolean;
}

export interface GroupMigrationItem {
  group_id: number;
  new_name: string;
  driver_ids: number[];
}

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

/** A Seller Feed "not interested" dismissal (DCH-51). Title and seller are
 *  snapshots taken at dismissal time for the review list — the listing may
 *  be gone from eBay by then. */
export interface HiddenFeedListing {
  item_id: string;
  title: string | null;
  seller_username: string | null;
  hidden_at: number;
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

export interface DetailUrlBackfillSummary {
  drivers_processed: number;
  missing_before: number;
  entries_patched: number;
  still_missing: number;
}

export interface PrewarmedDriver {
  driver_guid: string;
  driver_name: string;
  entry_count: number;
  last_prewarmed_at: number;
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

export const PREFERRED_OEM_DISPLAYS = [
  "Action/Lionel",
  "Racing Champions",
  "Revell",
  "Team Caliber",
  "Winners Circle",
];

function normalizeOptionKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const PREFERRED_OEM_KEYS = new Set(
  PREFERRED_OEM_DISPLAYS.map(normalizeOptionKey),
);

export function isPreferredOem(display: string): boolean {
  return PREFERRED_OEM_KEYS.has(normalizeOptionKey(display));
}

/** Brands floated to the top of brand dropdowns, in this order. */
export const PREFERRED_BRAND_DISPLAYS = [
  "ARC",
  "Elite",
  "NASCAR Authentics",
  "QVC FRFO",
  "RCCA",
];

const PREFERRED_BRAND_RANK = new Map(
  PREFERRED_BRAND_DISPLAYS.map((d, i) => [normalizeOptionKey(d), i]),
);

/** Preferred brands first (in PREFERRED_BRAND_DISPLAYS order), then the
 *  rest in their original order. */
export function prepareBrandOptions(brands: FormOptionRow[]): FormOptionRow[] {
  const rankOf = (b: FormOptionRow) =>
    PREFERRED_BRAND_RANK.get(normalizeOptionKey(b.display));
  const preferred = brands.filter((b) => rankOf(b) !== undefined);
  const rest = brands.filter((b) => rankOf(b) === undefined);
  preferred.sort((a, b) => rankOf(a)! - rankOf(b)!);
  return [...preferred, ...rest];
}

/** Makes floated to the top of make dropdowns, in this order. */
export const PREFERRED_MAKE_DISPLAYS = [
  "CWC",
  "BWC",
  "Bank BWB",
  "Bank CWB",
  "Late Model / Modified",
  "Midget / Sprint",
  "Multi Car Set",
  "Pit Wagon",
  "Transporter",
];

const PREFERRED_MAKE_RANK = new Map(
  PREFERRED_MAKE_DISPLAYS.map((d, i) => [normalizeOptionKey(d), i]),
);

/** Preferred makes first (in PREFERRED_MAKE_DISPLAYS order), then the
 *  rest in their original order. */
export function prepareMakeOptions(makes: FormOptionRow[]): FormOptionRow[] {
  const rankOf = (m: FormOptionRow) =>
    PREFERRED_MAKE_RANK.get(normalizeOptionKey(m.display));
  const preferred = makes.filter((m) => rankOf(m) !== undefined);
  const rest = makes.filter((m) => rankOf(m) === undefined);
  preferred.sort((a, b) => rankOf(a)! - rankOf(b)!);
  return [...preferred, ...rest];
}

/** NASCAR's first season was 1948, so registry year dropdowns never need to
 *  offer anything earlier. Drops pre-1948 (and non-numeric) options and sorts
 *  the rest newest-first. */
export const EARLIEST_YEAR = 1948;
export function prepareYearOptions(years: FormOptionRow[]): FormOptionRow[] {
  const yearOf = (y: FormOptionRow) => parseInt(y.value || y.display, 10);
  return years
    .filter((y) => {
      const n = yearOf(y);
      return Number.isFinite(n) && n >= EARLIEST_YEAR;
    })
    .sort((a, b) => yearOf(b) - yearOf(a));
}

/** The only model scales we surface in scale dropdowns, in display order. */
export const ALLOWED_SCALES = ["1:18", "1:24", "1:32", "1:64"] as const;
const SCALE_ORDER = new Map<string, number>(
  ALLOWED_SCALES.map((s, i) => [s, i]),
);

/** Keep only the allowed model scales, ordered largest → smallest. */
export function prepareScaleOptions(scales: FormOptionRow[]): FormOptionRow[] {
  return scales
    .filter((s) => SCALE_ORDER.has(s.display))
    .sort((a, b) => SCALE_ORDER.get(a.display)! - SCALE_ORDER.get(b.display)!);
}

/** Same filtering as prepareScaleOptions, for plain scale strings. */
export function filterAllowedScales(scales: string[]): string[] {
  return scales
    .filter((s) => SCALE_ORDER.has(s))
    .sort((a, b) => SCALE_ORDER.get(a)! - SCALE_ORDER.get(b)!);
}

/** How registry searches are answered — see Settings → pre-warm section. */
export type RegistrySearchMode = "remote" | "hybrid" | "local";

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

/** A saved registry filter combination whose matching entries are pulled
 *  down ahead of time (DCH-14). What's cached is `registry_entries` itself,
 *  so opening one answers from local rows — see the Rust `presearch` module. */
export interface Presearch {
  id: number;
  name: string;
  filter: ProductionSearchFilter;
  created_at: number;
  /** When the DCR walk last completed. null = never cached, so opening it
   *  falls back to whatever local rows happen to exist. */
  last_refreshed_at: number | null;
  /** Results the last successful walk saw. */
  last_result_count: number | null;
  /** Why the last refresh failed, if it did. Surfaced in the list because
   *  the overnight auto-sync is headless and would otherwise swallow it. */
  last_error: string | null;
}

export interface PresearchInput {
  name: string;
  filter: ProductionSearchFilter;
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

export interface ExportSummary {
  path: string;
  entries: number;
  images_embedded: number;
  images_failed: number;
}

export interface LinkResult {
  registry_entry_id: number;
  enriched: boolean;
}

export interface AutoMatchOutcome {
  matched: boolean;
  registry_entry_id: number | null;
  confidence: number | null;
  reasons: string[];
  /** Why no match was written, when matched is false. */
  skipped_reason: string | null;
}

export interface AutoMatchSummary {
  considered: number;
  matched: number;
  no_driver: number;
  no_candidates: number;
  below_threshold: number;
  prewarmed_drivers: number;
}

export interface ListingReceiverStatus {
  url: string;
  port: number;
  has_secret: boolean;
}

export interface BackgroundSettings {
  /** Closing the window hides to the tray instead of exiting. */
  run_in_background: boolean;
  /** Launch at login (minimized when combined with the above). */
  autostart: boolean;
}

export interface TrainOutcome {
  /** True when a learned model was stored. */
  activated: boolean;
  positives: number;
  explicit_negatives: number;
  implicit_negatives: number;
  cv_accuracy: number | null;
  cv_accuracy_baseline: number | null;
  cv_rank_accuracy: number | null;
  cv_rank_accuracy_baseline: number | null;
  learned_aliases: number;
  message: string;
}

export interface WeightRow {
  name: string;
  default_weight: number;
  learned_weight: number | null;
}

export interface MatcherStatus {
  /** False -> the built-in hand-tuned weights are scoring. */
  learned: boolean;
  trained_at: number | null;
  /** Last training run (manual or automatic), even if it declined to
   *  activate a model. */
  last_train_at: number | null;
  positives: number | null;
  explicit_negatives: number | null;
  implicit_negatives: number | null;
  cv_accuracy: number | null;
  cv_accuracy_baseline: number | null;
  cv_rank_accuracy: number | null;
  cv_rank_accuracy_baseline: number | null;
  feedback_rows: number;
  new_since_train: number | null;
  learned_aliases: number;
  weights: WeightRow[];
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
  /** Still-watched items skipped because they're within their staleness
   *  window (3 days fixed-price / 1 day auction; final-day auctions always
   *  refresh). */
  skipped_fresh: number;
  /** Ended listings newly archived this run (kept locally as history). */
  archived: number;
  /** Watched listings that vanished from eBay entirely (Browse 404),
   *  archived this run with end_reason 'removed'. */
  removed: number;
  /** Archived listings removed from the eBay watchlist this run. */
  unwatched: number;
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

/** Sold-price statistics over comparable archived listings (see the Rust
 *  `comps` module). All amounts are delivered cost — price plus shipping. */
export interface CompSummary {
  /** "exact" = sales of this same registry entry; "similar" = same driver at
   *  the same scale, used only when exact sales are too few. */
  tier: "exact" | "similar";
  count: number;
  low_cents: number;
  median_cents: number;
  high_cents: number;
  /** Unix seconds of the most / least recent sale in the set. */
  newest_sold_at: number;
  oldest_sold_at: number;
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
  /** eBay buyingOptions contains BEST_OFFER — independent of listing_type. */
  accepts_offers: boolean;
  status: string;
  /** Ended listing kept locally as history after the sync removed it from
   *  the eBay watchlist. Exempt from watchlist pruning. */
  is_archived: boolean;
  /** Why an archived listing ended: 'sold', 'ended' (unsold), or 'removed'
   *  (vanished from eBay). null for active rows and pre-migration archives
   *  not yet backfilled by a sync. */
  end_reason: string | null;
  /** When the sync archived the listing (Unix seconds). */
  archived_at: number | null;
  end_time: number | null;
  seller_username: string | null;
  seller_rating: number | null;
  image_url: string | null;
  saved_at: number;
  last_seen_at: number;
  registry_entry_id: number | null;
  match_confidence: number | null;
  match_user_confirmed: boolean;
  /** 'manual' (registry-search dialog), 'auto' (auto-matcher), or null for
   *  rows written before provenance tracking (all manual links). */
  matched_by: string | null;
  /** Human-readable signals behind an auto-match's confidence. Empty for
   *  manual links. */
  match_reasons: string[];
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
  /** What comparable cars actually sold for, from the local archive of ended
   *  listings. null until enough sales have accumulated for this entry. */
  comps: CompSummary | null;
  /** Total as percentage of the comp median. Same shape as `deal_score` but
   *  measured against real sales rather than list value. */
  comp_score: number | null;
  /** Driver auto-detected from the listing title (independent of any registry match). */
  auto_driver_id: number | null;
  auto_driver_name: string | null;
  /** True when the user manually pinned the driver — auto-association leaves it alone. */
  auto_driver_user_set: boolean;
  /** ids of user-curated listing groups this row belongs to. */
  group_ids: number[];
  /** Listing-level attributes, auto-filled from the title unless the user
   *  pinned them. For matched rows the registry entry's values are
   *  authoritative; these matter for unmatched listings and as a
   *  cross-check. */
  oem: string | null;
  brand: string | null;
  finish: string | null;
  /** Windowed-car/bank code: CWC, CWB, BWC, BWB. */
  make: string | null;
  is_race_win: boolean;
  is_autographed: boolean;
  /** Production-run size, read off the listing's production-tag photo
   *  or copied from the confirmed match. */
  production_count: number | null;
  /** True when the attributes were copied from the confirmed registry
   *  match rather than derived from the listing itself. */
  attrs_from_match: boolean;
  /** True when the user saved the attribute editor — auto-fill skips the
   *  row until "Reset to auto". */
  attributes_user_set: boolean;
}

/** The editable attribute set on a listing — saved as one unit by
 *  `setListingAttributes`. Null/empty strings clear the field. */
export interface ListingAttributes {
  oem: string | null;
  brand: string | null;
  finish: string | null;
  make: string | null;
  is_race_win: boolean;
  is_autographed: boolean;
  /** Production-run size, read off the listing's production-tag photo. */
  production_count: number | null;
}

export interface DriverOption {
  id: number;
  name: string;
  normalized_name: string;
  /** Saved listings currently linked to this driver. */
  listing_count: number;
}

/** Generational suffixes that belong to one driver's name rather than
 *  signalling a second driver. */
const DRIVER_SUFFIX_TOKENS = new Set([
  "jr",
  "jr.",
  "sr",
  "sr.",
  "ii",
  "iii",
  "iv",
  "v",
]);

/** Multi-driver entries concatenate full names with no delimiter
 *  (e.g. "Jeff Gordon Tony Stewart"), so word count is the only signal we
 *  have: an entry of two words or fewer — ignoring suffixes like "Jr" —
 *  names a single driver. (Rare three-word single names like
 *  "Juan Pablo Montoya" are misread as multi-driver; there's no reliable
 *  way to tell them apart from a name string alone.) */
export function isSingleDriverName(name: string): boolean {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w && !DRIVER_SUFFIX_TOKENS.has(w.toLowerCase()));
  return words.length <= 2;
}

/** Comparator that floats single-driver entries above multi-driver ones,
 *  leaving same-bucket ordering to a caller-supplied secondary sort. */
export function byDriverNamePriority(a: string, b: string): number {
  return Number(!isSingleDriverName(a)) - Number(!isSingleDriverName(b));
}

/** Sort a list of driver-bearing rows: most saved listings first, ties
 *  alphabetically — so drivers with no saved listings trail the ones that
 *  have any. Omit `countOf` when no counts apply (pure alphabetical).
 *  Returns a new array; the input is left untouched. */
export function sortDriverOptions<T>(
  list: T[],
  nameOf: (row: T) => string,
  countOf: (row: T) => number = () => 0,
): T[] {
  return [...list].sort(
    (a, b) => countOf(b) - countOf(a) || nameOf(a).localeCompare(nameOf(b)),
  );
}

/** Saved-listing counts keyed by the driver's normalized name — the shared
 *  key between the local `drivers` table and the DCR form-options cache.
 *  Never throws; dropdowns fall back to alphabetical on an empty map. */
export async function driverListingCounts(): Promise<Map<string, number>> {
  try {
    const drivers = await api.listDrivers();
    return new Map(drivers.map((d) => [d.normalized_name, d.listing_count]));
  } catch {
    return new Map();
  }
}

// Re-exported so the many existing `import { formatCents } from "@/lib/tauri"`
// sites keep working; the implementation lives in format.ts (Tauri-free,
// unit-testable).
export {
  formatAgo,
  formatCents,
  formatCount,
  formatDate,
  formatDateTime,
  formatTime,
  formatUntil,
} from "./format";
