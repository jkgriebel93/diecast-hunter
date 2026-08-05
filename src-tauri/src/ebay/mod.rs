//! eBay Browse API integration. Uses application access tokens (Client
//! Credentials grant) — sufficient for read-only catalog/item lookups.
//! Watchlist sync (which needs user OAuth) is a later milestone.

pub mod browse;
pub mod category;
pub mod client;
pub mod oauth;
pub mod offers;
pub mod parse;
pub mod search;
pub mod search_url;
pub mod trading;

pub use category::is_diecast;

pub use browse::{fetch_item_by_legacy_id, EbayItem};
pub use client::{EbayClient, EbayEnvironment};
pub use oauth::{
    authorize_url, disconnect, exchange_code, invalidate_user_token_cache,
    is_iaf_token_expired_error, status, user_iaf_token, OauthStatus, DEFAULT_SCOPES,
};
pub use offers::{fetch_received_offers, ReceivedOffer};
pub use parse::{
    end_reason_from_raw, extract_legacy_item_id, is_item_not_found_error, legacy_id_from_v1,
};
pub use search::{search_diecasts, SearchFilters, SearchPage};
pub use trading::{
    add_to_watchlist, fetch_my_ebay_favorites, fetch_watchlist_page, remove_from_watchlist,
    MyEbayFavorites,
};
