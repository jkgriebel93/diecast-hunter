//! eBay buyer-side offers (Trading API). Fetches Best Offers the user is
//! involved with as a buyer (their own pending offers + seller counter-
//! offers) via GetMyeBayBuying, and lets them decline a single offer via
//! RespondToBestOffer. Accepting a counter-offer is intentionally NOT
//! exposed here — eBay's accept flow has anti-fraud checks the API
//! doesn't surface for buyers, so the UI deep-links to eBay for that.

use std::error::Error as _;
use std::time::Duration;

use chrono::DateTime;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::Serialize;

use crate::ebay::client::EbayEnvironment;
use crate::ebay::parse::dollars_string_to_cents;
use crate::ebay::trading::{parse_watchlist_mutation_response, trading_endpoint};
use crate::error::{AppError, AppResult};

const COMPATIBILITY_LEVEL: &str = "1193";
const SITE_ID_US: &str = "0";

/// One offer on one item, flattened from the nested GetMyeBayBuying
/// response so the UI can render a simple list.
#[derive(Debug, Clone, Serialize)]
pub struct ReceivedOffer {
    pub item_id: String,
    pub item_title: String,
    pub item_web_url: Option<String>,
    pub item_image_url: Option<String>,
    /// Listing's current Buy-It-Now / fixed price, for context next to the
    /// offer amount.
    pub item_current_price_cents: Option<i64>,
    pub offer_id: String,
    /// "Pending" | "Countered" | "Accepted" | "Declined" | "Expired" |
    /// "Retracted" — eBay's BestOfferStatusCodeType. Not exhaustive; we
    /// pass through whatever we got.
    pub offer_status: String,
    pub offer_price_cents: Option<i64>,
    pub offer_currency: String,
    /// "BestOffer" (buyer-initiated) or "CounterOffer" (seller counter).
    /// Only the latter is "an offer the seller sent me."
    pub offer_type: Option<String>,
    pub expiration_time: Option<i64>,
    pub buyer_message: Option<String>,
    pub seller_message: Option<String>,
}

pub async fn fetch_received_offers(
    env: EbayEnvironment,
    iaf_token: &str,
) -> AppResult<Vec<ReceivedOffer>> {
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <BestOfferList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </BestOfferList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBayBuyingRequest>"#;

    let xml = trading_post(env, iaf_token, "GetMyeBayBuying", body).await?;
    parse_offers_response(&xml)
}

/// Decline a single Best Offer / counter-offer the user is involved with.
/// "Already declined / expired" responses from eBay are treated as
/// success — the caller's intent is satisfied either way.
pub async fn decline_offer(
    env: EbayEnvironment,
    iaf_token: &str,
    item_id: &str,
    offer_id: &str,
) -> AppResult<()> {
    if !is_safe_id(item_id) {
        return Err(AppError::Parse(format!(
            "refusing to send malformed item id: {item_id:?}"
        )));
    }
    if !is_safe_id(offer_id) {
        return Err(AppError::Parse(format!(
            "refusing to send malformed offer id: {offer_id:?}"
        )));
    }
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<RespondToBestOfferRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>{item_id}</ItemID>
  <BestOfferID>{offer_id}</BestOfferID>
  <Action>Decline</Action>
</RespondToBestOfferRequest>"#
    );
    let xml = trading_post(env, iaf_token, "RespondToBestOffer", &body).await?;
    parse_watchlist_mutation_response(&xml, "RespondToBestOffer")
}

fn is_safe_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) && s.len() <= 20
}

async fn trading_post(
    env: EbayEnvironment,
    iaf_token: &str,
    call_name: &str,
    body: &str,
) -> AppResult<String> {
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
        .body(body.to_string())
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
    Ok(xml)
}

// ---------- parsing ----------

static FAILURE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<Ack>Failure</Ack>").unwrap());
static LONG_MESSAGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<LongMessage>([^<]+)</LongMessage>").unwrap());
static ITEM_BLOCK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)<Item>(.*?)</Item>").unwrap());
static OFFER_BLOCK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)<BestOffer>(.*?)</BestOffer>").unwrap());

pub fn parse_offers_response(xml: &str) -> AppResult<Vec<ReceivedOffer>> {
    if FAILURE_RE.is_match(xml) {
        let detail = LONG_MESSAGE_RE
            .captures(xml)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_else(|| "GetMyeBayBuying returned Failure".to_string());
        return Err(AppError::Network(format!("trading api: {detail}")));
    }

    let mut out: Vec<ReceivedOffer> = Vec::new();
    for cap in ITEM_BLOCK_RE.captures_iter(xml) {
        let item_xml = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let item_id = match extract_text(item_xml, "ItemID") {
            Some(id) => id,
            None => continue, // not a real item block
        };
        let item_title =
            extract_text(item_xml, "Title").unwrap_or_else(|| "(untitled)".to_string());
        let item_web_url = extract_text(item_xml, "ViewItemURL");
        let item_image_url = extract_text(item_xml, "GalleryURL");
        let item_current_price_cents = extract_text(item_xml, "CurrentPrice")
            .and_then(|s| dollars_string_to_cents(&s));

        for offer_cap in OFFER_BLOCK_RE.captures_iter(item_xml) {
            let off_xml = offer_cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let offer_id = match extract_text(off_xml, "BestOfferID") {
                Some(id) => id,
                None => continue,
            };
            let price_str = extract_text(off_xml, "Price");
            let offer_price_cents = price_str.as_deref().and_then(dollars_string_to_cents);
            let offer_currency = extract_attr(off_xml, "Price", "currencyID")
                .unwrap_or_else(|| "USD".to_string());
            let offer_status =
                extract_text(off_xml, "Status").unwrap_or_else(|| "Unknown".to_string());
            let offer_type = extract_text(off_xml, "BestOfferCodeType");
            let expiration_time = extract_text(off_xml, "ExpirationTime")
                .as_deref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp());
            let buyer_message = extract_text(off_xml, "BuyerMessage");
            let seller_message = extract_text(off_xml, "SellerMessage");

            out.push(ReceivedOffer {
                item_id: item_id.clone(),
                item_title: item_title.clone(),
                item_web_url: item_web_url.clone(),
                item_image_url: item_image_url.clone(),
                item_current_price_cents,
                offer_id,
                offer_status,
                offer_price_cents,
                offer_currency,
                offer_type,
                expiration_time,
                buyer_message,
                seller_message,
            });
        }
    }
    Ok(out)
}

/// Extract the text between the first `<tag ...>` ... `</tag>`. Handles
/// open tags with attributes (e.g. `<Price currencyID="USD">10.00</Price>`).
fn extract_text(xml: &str, tag: &str) -> Option<String> {
    let close = format!("</{tag}>");
    let close_pos = xml.find(&close)?;
    let before = &xml[..close_pos];
    // Find the matching open tag — the last `<tag` (with optional attrs)
    // that opens before the close. Using the *last* one tolerates nesting
    // we don't expect, but err toward the closest opener.
    let pat_with_space = format!("<{tag} ");
    let pat_no_space = format!("<{tag}>");
    let open_idx = before
        .rfind(&pat_with_space)
        .or_else(|| before.rfind(&pat_no_space))?;
    let after_open = &before[open_idx..];
    let gt = after_open.find('>')? + 1;
    Some(after_open[gt..].to_string())
}

/// Pull a single attribute off the first `<tag ...>` opening tag.
fn extract_attr(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let pat_with_space = format!("<{tag} ");
    let open_idx = xml.find(&pat_with_space)?;
    let after_open = &xml[open_idx + pat_with_space.len()..];
    let gt = after_open.find('>')?;
    let attrs = &after_open[..gt];
    let needle = format!(r#"{attr}=""#);
    let val_start = attrs.find(&needle)? + needle.len();
    let rest = &attrs[val_start..];
    let val_end = rest.find('"')?;
    Some(rest[..val_end].to_string())
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

    const FIXTURE: &str = include_str!("../../fixtures/ebay/offers_response.xml");

    #[test]
    fn parses_fixture() {
        let offers = parse_offers_response(FIXTURE).unwrap();
        assert_eq!(offers.len(), 2);

        let counter = &offers[0];
        assert_eq!(counter.item_id, "123456789012");
        assert!(counter.item_title.contains("Jeff Gordon"));
        assert_eq!(
            counter.item_web_url.as_deref(),
            Some("https://www.ebay.com/itm/123456789012")
        );
        assert!(counter
            .item_image_url
            .as_deref()
            .is_some_and(|u| u.starts_with("https://i.ebayimg")));
        assert_eq!(counter.item_current_price_cents, Some(4995));
        assert_eq!(counter.offer_id, "5550000001");
        assert_eq!(counter.offer_status, "Countered");
        assert_eq!(counter.offer_type.as_deref(), Some("CounterOffer"));
        assert_eq!(counter.offer_price_cents, Some(4250));
        assert_eq!(counter.offer_currency, "USD");
        assert!(counter.expiration_time.is_some());
        assert_eq!(counter.buyer_message.as_deref(), Some("Would you take $35?"));
        assert_eq!(
            counter.seller_message.as_deref(),
            Some("Best I can do is $42.50.")
        );

        let pending = &offers[1];
        assert_eq!(pending.item_id, "234567890123");
        assert_eq!(pending.offer_status, "Pending");
        assert_eq!(pending.offer_type.as_deref(), Some("BestOffer"));
        assert_eq!(pending.seller_message, None);
    }

    #[test]
    fn empty_offer_list() {
        let xml = r#"<?xml version="1.0"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <BestOfferList>
    <PaginationResult>
      <TotalNumberOfPages>0</TotalNumberOfPages>
      <TotalNumberOfEntries>0</TotalNumberOfEntries>
    </PaginationResult>
  </BestOfferList>
</GetMyeBayBuyingResponse>"#;
        let offers = parse_offers_response(xml).unwrap();
        assert_eq!(offers.len(), 0);
    }

    #[test]
    fn failure_response_propagates() {
        let xml = r#"<?xml version="1.0"?>
<GetMyeBayBuyingResponse>
  <Ack>Failure</Ack>
  <Errors>
    <LongMessage>Auth token is invalid.</LongMessage>
  </Errors>
</GetMyeBayBuyingResponse>"#;
        let err = parse_offers_response(xml).unwrap_err();
        assert!(err.to_string().contains("Auth token is invalid"));
    }

    #[test]
    fn safe_id_rejects_non_digits() {
        assert!(is_safe_id("123"));
        assert!(!is_safe_id(""));
        assert!(!is_safe_id("abc"));
        assert!(!is_safe_id("12345</ItemID><FOO>"));
    }

    #[test]
    fn extract_text_handles_attrs() {
        let xml = r#"<Price currencyID="USD">42.50</Price>"#;
        assert_eq!(extract_text(xml, "Price").as_deref(), Some("42.50"));
    }

    #[test]
    fn extract_attr_pulls_currency() {
        let xml = r#"<Price currencyID="USD">42.50</Price>"#;
        assert_eq!(extract_attr(xml, "Price", "currencyID").as_deref(), Some("USD"));
    }
}
