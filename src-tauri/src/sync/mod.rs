//! Orchestration layer: pulls remote data and persists it locally.

pub mod attribute_assoc;
pub mod auto_sync;
pub mod dcr_collection;
pub mod dcr_register;
pub mod dcr_registry;
pub mod dcr_remove;
pub mod detail_url_backfill;
pub mod driver_assoc;
pub(crate) mod driver_upsert;
pub mod ebay_all;
pub mod ebay_listing;
pub mod ebay_saved;
pub mod ebay_watchlist;
pub mod registry_auto_match;
pub mod registry_link;
pub mod registry_prewarm;

pub use dcr_collection::{enrich_only, sync_dcr_collection_and_enrich, SyncSummary};
pub use dcr_register::{register_in_garage, RegisterDiecastSummary};
pub use dcr_registry::EnrichSummary;
pub use dcr_remove::{remove_collection_entry, RemoveEntrySummary};
pub use detail_url_backfill::{backfill_detail_urls, DetailUrlBackfillSummary};
pub use ebay_all::{sync_all as sync_all_ebay, EbaySyncAllSummary};
pub use ebay_listing::{
    add_listing_from_input, refresh_all_active, refresh_listing, AddListingResult, RefreshSummary,
};
pub use ebay_saved::{sync_saved_from_ebay, SavedSyncSummary};
pub use ebay_watchlist::{
    sync_watchlist, unwatch_and_delete, watch_and_save, WatchlistSyncSummary,
};
pub use registry_auto_match::{AutoMatchOutcome, AutoMatchSummary};
pub use registry_link::{link_listing_to_registry, LinkResult};
pub use registry_prewarm::{prewarm_by_driver, refresh_stale_prewarms, PrewarmSummary};
