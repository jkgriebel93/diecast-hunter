//! Orchestration layer: pulls remote data and persists it locally.

pub mod dcr_collection;

pub use dcr_collection::{sync_dcr_collection, SyncSummary};
