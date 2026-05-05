//! diecastregistry.com integration: HTTP client, auth, and HTML scraping.

pub mod client;
pub mod collection;
pub mod detail;
pub mod form_options;
pub mod parse;
pub mod production_search;

pub use client::DcrClient;
pub use collection::{CollectionItem, CollectionPage};
pub use detail::{parse_detail_page, RegistryDetail};
pub use form_options::{refresh_form_options, RefreshOptionsSummary};
pub use production_search::{
    search, search_all_pages, ProductionSearchFilter, ProductionSearchResult,
};
