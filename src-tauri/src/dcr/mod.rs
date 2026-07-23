//! diecastregistry.com integration: HTTP client, auth, and HTML scraping.

pub mod client;
pub mod collection;
pub mod delete;
pub mod detail;
pub mod form_options;
pub mod parse;
pub mod production_search;
pub mod register;
pub mod session;

pub use client::DcrClient;
pub use session::DcrSession;
pub use collection::{CollectionItem, CollectionPage};
pub use delete::{delete_from_garage, DeleteOutcome};
pub use detail::{parse_detail_page, RegistryDetail};
pub use form_options::{refresh_form_options, RefreshOptionsSummary};
pub use production_search::{
    search_all_pages_with_progress, ProductionSearchFilter, ProductionSearchResult,
};
pub use register::{
    register_diecast, Condition, RegisterDiecastInput, RegisterDiecastResult,
};
