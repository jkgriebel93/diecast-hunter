//! Orchestration layer: pulls remote data and persists it locally.

pub mod dcr_collection;
pub mod dcr_registry;
pub mod ebay_listing;
pub mod ebay_watchlist;
pub mod fb_listing;
pub mod listing_match;
pub mod registry_link;

pub use dcr_collection::{enrich_only, sync_dcr_collection_and_enrich, SyncSummary};
pub use dcr_registry::EnrichSummary;
pub use ebay_listing::{
    add_listing_from_input, refresh_all_active, refresh_listing, AddListingResult,
    RefreshSummary,
};
pub use ebay_watchlist::{sync_watchlist, WatchlistSyncSummary};
pub use fb_listing::{upsert_from_payload, FbListingPayload, FbSaveResult};
pub use listing_match::{match_all, MatchSummary};
pub use registry_link::{link_listing_to_registry, LinkResult};
