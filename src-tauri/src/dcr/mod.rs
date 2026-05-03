//! diecastregistry.com integration: HTTP client, auth, and HTML scraping.

pub mod client;
pub mod collection;
pub mod detail;
pub mod parse;

pub use client::DcrClient;
pub use collection::{CollectionItem, CollectionPage};
pub use detail::{parse_detail_page, RegistryDetail};
