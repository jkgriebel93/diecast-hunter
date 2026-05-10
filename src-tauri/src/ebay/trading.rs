//! Trading API integration. Used only for `GetMyeBayBuying` (watchlist sync) —
//! eBay's REST APIs don't expose the watchlist, but the legacy Trading API
//! still does and accepts modern OAuth user (IAF) tokens in the
//! `X-EBAY-API-IAF-TOKEN` header.
//!
//! Trading API is XML, but we only need the item ids, so we extract them
//! via a focused regex rather than pulling in a full XML parser.

use std::collections::HashSet;
use std::error::Error as _;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;

use crate::ebay::client::EbayEnvironment;
use crate::error::{AppError, AppResult};

const COMPATIBILITY_LEVEL: &str = "1193";
const SITE_ID_US: &str = "0";

#[derive(Debug, Clone)]
pub struct WatchlistPage {
    pub item_ids: Vec<String>,
    pub current_page: u32,
    pub total_pages: u32,
}

pub fn trading_endpoint(env: EbayEnvironment) -> &'static str {
    match env {
        EbayEnvironment::Sandbox => "https://api.sandbox.ebay.com/ws/api.dll",
        EbayEnvironment::Production => "https://api.ebay.com/ws/api.dll",
    }
}

/// Add a single item to the authenticated user's eBay watchlist.
/// "Already on watchlist" responses are treated as success.
pub async fn add_to_watchlist(
    env: EbayEnvironment,
    iaf_token: &str,
    legacy_item_id: &str,
) -> AppResult<()> {
    call_watchlist_mutation(env, iaf_token, "AddToWatchList", legacy_item_id).await
}

/// Remove a single item from the authenticated user's eBay watchlist.
/// "Not on watchlist" responses are treated as success so callers can
/// safely use this on listings that may have been added by URL paste.
pub async fn remove_from_watchlist(
    env: EbayEnvironment,
    iaf_token: &str,
    legacy_item_id: &str,
) -> AppResult<()> {
    call_watchlist_mutation(env, iaf_token, "RemoveFromWatchList", legacy_item_id).await
}

async fn call_watchlist_mutation(
    env: EbayEnvironment,
    iaf_token: &str,
    call_name: &str,
    legacy_item_id: &str,
) -> AppResult<()> {
    if !is_safe_item_id(legacy_item_id) {
        return Err(AppError::Parse(format!(
            "refusing to send malformed item id to trading api: {legacy_item_id:?}"
        )));
    }
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<{call_name}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>{legacy_item_id}</ItemID>
</{call_name}Request>"#
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .gzip(true)
        .http1_only()
        .build()
        .map_err(map_reqwest)?;

    let resp = client
        .post(trading_endpoint(env))
        .header("X-EBAY-API-CALL-NAME", call_name)
        .header("X-EBAY-API-IAF-TOKEN", iaf_token)
        .header("X-EBAY-API-COMPATIBILITY-LEVEL", COMPATIBILITY_LEVEL)
        .header("X-EBAY-API-SITEID", SITE_ID_US)
        .header("Content-Type", "text/xml")
        .body(body)
        .send()
        .await
        .map_err(map_reqwest)?;

    let status = resp.status();
    let xml = resp.text().await.map_err(map_reqwest)?;
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "trading api {call_name} returned {status}: {xml}"
        )));
    }
    parse_watchlist_mutation_response(&xml, call_name)
}

fn is_safe_item_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) && s.len() <= 20
}

pub async fn fetch_watchlist_page(
    env: EbayEnvironment,
    iaf_token: &str,
    page_number: u32,
    entries_per_page: u32,
) -> AppResult<WatchlistPage> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <WatchList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>{entries_per_page}</EntriesPerPage>
      <PageNumber>{page_number}</PageNumber>
    </Pagination>
  </WatchList>
  <DetailLevel>ReturnSummary</DetailLevel>
</GetMyeBayBuyingRequest>"#
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .gzip(true)
        .http1_only()
        .build()
        .map_err(map_reqwest)?;

    let resp = client
        .post(trading_endpoint(env))
        .header("X-EBAY-API-CALL-NAME", "GetMyeBayBuying")
        .header("X-EBAY-API-IAF-TOKEN", iaf_token)
        .header("X-EBAY-API-COMPATIBILITY-LEVEL", COMPATIBILITY_LEVEL)
        .header("X-EBAY-API-SITEID", SITE_ID_US)
        .header("Content-Type", "text/xml")
        .body(body)
        .send()
        .await
        .map_err(map_reqwest)?;

    let status = resp.status();
    let xml = resp.text().await.map_err(map_reqwest)?;
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "trading api returned {status}: {xml}"
        )));
    }
    parse_watchlist_response(&xml)
}

static ITEM_ID_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<ItemID>(\d{6,})</ItemID>").unwrap());
static FAILURE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<Ack>Failure</Ack>").unwrap());
static LONG_MESSAGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<LongMessage>([^<]+)</LongMessage>").unwrap());
static PAGE_NUMBER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<PageNumber>(\d+)</PageNumber>").unwrap());
static TOTAL_PAGES_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<TotalNumberOfPages>(\d+)</TotalNumberOfPages>").unwrap());

/// Inspect the response body of an AddToWatchList / RemoveFromWatchList
/// call and either return Ok(()) for success (or benign "already on / not
/// on" responses) or Err for real failures.
pub fn parse_watchlist_mutation_response(xml: &str, call_name: &str) -> AppResult<()> {
    if !FAILURE_RE.is_match(xml) {
        return Ok(());
    }
    let detail = LONG_MESSAGE_RE
        .captures(xml)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        .unwrap_or_else(|| format!("{call_name} returned Failure"));
    let lower = detail.to_lowercase();

    // Forgiving: treat "already on watchlist" / "not on watchlist" as benign
    // — the caller's intent is satisfied either way.
    let already_on = lower.contains("already") && lower.contains("watch");
    let not_on = (lower.contains("not on") || lower.contains("not in"))
        && lower.contains("watch");
    if (call_name == "AddToWatchList" && already_on)
        || (call_name == "RemoveFromWatchList" && not_on)
    {
        tracing::info!("trading api {call_name}: benign no-op ({detail})");
        return Ok(());
    }
    Err(AppError::Network(format!("trading api {call_name}: {detail}")))
}

pub fn parse_watchlist_response(xml: &str) -> AppResult<WatchlistPage> {
    if FAILURE_RE.is_match(xml) {
        let detail = LONG_MESSAGE_RE
            .captures(xml)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_else(|| "trading api returned Failure".to_string());
        return Err(AppError::Network(format!("trading api: {detail}")));
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut item_ids: Vec<String> = Vec::new();
    for cap in ITEM_ID_RE.captures_iter(xml) {
        if let Some(m) = cap.get(1) {
            let id = m.as_str().to_string();
            if seen.insert(id.clone()) {
                item_ids.push(id);
            }
        }
    }

    let current_page = PAGE_NUMBER_RE
        .captures(xml)
        .and_then(|c| c.get(1).and_then(|m| m.as_str().parse().ok()))
        .unwrap_or(1);
    let total_pages = TOTAL_PAGES_RE
        .captures(xml)
        .and_then(|c| c.get(1).and_then(|m| m.as_str().parse().ok()))
        .unwrap_or(1);

    Ok(WatchlistPage {
        item_ids,
        current_page,
        total_pages,
    })
}

fn map_reqwest(e: reqwest::Error) -> AppError {
    let mut parts = vec![e.to_string()];
    let mut src: Option<&dyn std::error::Error> = e.source();
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    AppError::Network(parts.join(": "))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixtures/ebay/watchlist_response.xml");

    #[test]
    fn parses_fixture() {
        let page = parse_watchlist_response(FIXTURE).unwrap();
        assert_eq!(page.item_ids.len(), 3);
        assert_eq!(page.item_ids[0], "123456789012");
        assert_eq!(page.item_ids[1], "234567890123");
        assert_eq!(page.item_ids[2], "345678901234");
        assert_eq!(page.current_page, 1);
        assert_eq!(page.total_pages, 2);
    }

    #[test]
    fn detects_failure() {
        let xml = r#"<?xml version="1.0"?>
<GetMyeBayBuyingResponse>
  <Ack>Failure</Ack>
  <Errors>
    <LongMessage>Auth token is invalid.</LongMessage>
  </Errors>
</GetMyeBayBuyingResponse>"#;
        let err = parse_watchlist_response(xml).unwrap_err();
        let s = err.to_string();
        assert!(s.contains("Auth token is invalid"));
    }

    #[test]
    fn add_to_watchlist_success() {
        let xml = r#"<?xml version="1.0"?>
<AddToWatchListResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <WatchListMaximum>100</WatchListMaximum>
  <WatchListCount>5</WatchListCount>
</AddToWatchListResponse>"#;
        parse_watchlist_mutation_response(xml, "AddToWatchList").unwrap();
    }

    #[test]
    fn add_to_watchlist_already_on_is_benign() {
        let xml = r#"<?xml version="1.0"?>
<AddToWatchListResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <LongMessage>Item is already on the watch list.</LongMessage>
  </Errors>
</AddToWatchListResponse>"#;
        parse_watchlist_mutation_response(xml, "AddToWatchList").unwrap();
    }

    #[test]
    fn remove_from_watchlist_not_on_is_benign() {
        let xml = r#"<?xml version="1.0"?>
<RemoveFromWatchListResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <LongMessage>Item is not on the watch list.</LongMessage>
  </Errors>
</RemoveFromWatchListResponse>"#;
        parse_watchlist_mutation_response(xml, "RemoveFromWatchList").unwrap();
    }

    #[test]
    fn add_to_watchlist_real_failure_propagates() {
        let xml = r#"<?xml version="1.0"?>
<AddToWatchListResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <LongMessage>Auth token is invalid.</LongMessage>
  </Errors>
</AddToWatchListResponse>"#;
        let err = parse_watchlist_mutation_response(xml, "AddToWatchList").unwrap_err();
        assert!(err.to_string().contains("Auth token is invalid"));
    }

    #[test]
    fn safe_item_id_rejects_garbage() {
        assert!(is_safe_item_id("123456789012"));
        assert!(!is_safe_item_id(""));
        assert!(!is_safe_item_id("abc"));
        assert!(!is_safe_item_id("12345</ItemID><FOO>"));
    }

    #[test]
    fn empty_watchlist() {
        let xml = r#"<?xml version="1.0"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <WatchList>
    <PaginationResult>
      <TotalNumberOfPages>0</TotalNumberOfPages>
      <TotalNumberOfEntries>0</TotalNumberOfEntries>
    </PaginationResult>
    <PageNumber>1</PageNumber>
  </WatchList>
</GetMyeBayBuyingResponse>"#;
        let page = parse_watchlist_response(xml).unwrap();
        assert_eq!(page.item_ids.len(), 0);
    }
}
