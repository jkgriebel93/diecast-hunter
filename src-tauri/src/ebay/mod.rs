//! eBay Browse API integration. Uses application access tokens (Client
//! Credentials grant) — sufficient for read-only catalog/item lookups.
//! Watchlist sync (which needs user OAuth) is a later milestone.

pub mod browse;
pub mod client;
pub mod oauth;
pub mod parse;
pub mod trading;

pub use browse::{fetch_item_by_legacy_id, EbayItem};
pub use client::{EbayClient, EbayEnvironment};
pub use oauth::{
    authorize_url, disconnect, exchange_code, get_user_access_token, status,
    OauthStatus, DEFAULT_SCOPES,
};
pub use parse::extract_legacy_item_id;
pub use trading::{fetch_watchlist_page, WatchlistPage};
