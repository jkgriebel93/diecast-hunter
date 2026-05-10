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
pub mod trading;

pub use category::is_diecast;

pub use browse::{fetch_item_by_legacy_id, EbayItem};
pub use client::{EbayClient, EbayEnvironment};
pub use oauth::{
    authorize_url, disconnect, exchange_code, get_user_access_token, status, user_iaf_token,
    OauthStatus, DEFAULT_SCOPES,
};
pub use offers::{
    decline_offer, fetch_received_offers, probe_item, probe_message_body, probe_messages,
    ItemProbeResult, MessagesProbeResult, ReceivedOffer,
};
pub use parse::{extract_legacy_item_id, legacy_id_from_v1};
pub use search::{search_diecasts, SearchFilters, SearchPage};
pub use trading::{add_to_watchlist, fetch_watchlist_page, remove_from_watchlist};
