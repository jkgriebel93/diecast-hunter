//! Orchestration layer: pulls remote data and persists it locally.

pub mod dcr_collection;
pub mod dcr_registry;

pub use dcr_collection::{enrich_only, sync_dcr_collection_and_enrich, SyncSummary};
pub use dcr_registry::EnrichSummary;
