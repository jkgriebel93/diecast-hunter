//! diecastregistry.com integration: HTTP client, auth, and HTML scraping.

pub mod client;
pub mod collection;
pub mod parse;

pub use client::DcrClient;
pub use collection::{CollectionItem, CollectionPage};
