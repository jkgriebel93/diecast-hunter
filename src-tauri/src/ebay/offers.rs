//! eBay buyer-side offers (Trading API). Fetches Best Offers attached to
//! items the user has watch-listed — primarily seller-initiated "Send
//! Offer to Buyer" promotions — by pulling the watchlist with full
//! detail and surfacing items that have a <BestOffer> attached. Decline
//! goes through RespondToBestOffer; accepting deep-links to eBay so its
//! anti-fraud checks can run during checkout.

use std::collections::HashMap;
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
  <WatchList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </WatchList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBayBuyingRequest>"#;

    let xml = trading_post(env, iaf_token, "GetMyeBayBuying", body).await?;
    let (offers, stats) = parse_offers_response_with_stats(&xml)?;
    tracing::info!(
        "ebay offers diagnostic: items={}, with_BestOfferDetails={}, with_BestOfferCount>0={}, with_inline_offer={}",
        stats.watched_count,
        stats.items_with_best_offer_details,
        stats.items_with_nonzero_count,
        stats.items_with_inline_offer,
    );
    if let Some(sample) = stats.sample_best_offer_details {
        let trimmed: String = sample.chars().take(600).collect();
        tracing::info!("ebay offers: sample BestOfferDetails XML: {trimmed}");
    }
    // When we got items but no offer markup at all, log substring counts
    // for every plausible offer-related fragment so we can tell whether
    // (a) eBay didn't include offer data under any tag name, or (b) it's
    // there but we're looking for the wrong tag. Also drop the raw XML
    // to a temp file for inspection.
    if stats.items_with_best_offer_details == 0 && stats.watched_count > 0 {
        let count = |needle: &str| xml.matches(needle).count();
        tracing::info!(
            "ebay offers fragments: <BestOfferDetails={}, <BestOffer>={}, <BestOffer (with attrs)={}, BestOfferEnabled={}, BestOfferCount={}, BestOfferID={}, SellerOffer={}, OfferID={}",
            count("<BestOfferDetails"),
            count("<BestOffer>"),
            count("<BestOffer "),
            count("BestOfferEnabled"),
            count("BestOfferCount"),
            count("BestOfferID"),
            count("SellerOffer"),
            count("OfferID"),
        );
        let path = std::env::temp_dir().join(format!(
            "diecast_offers_{}.xml",
            chrono::Utc::now().timestamp()
        ));
        match std::fs::write(&path, xml.as_bytes()) {
            Ok(()) => tracing::info!(
                "ebay offers: dumped raw response to {} for inspection",
                path.display()
            ),
            Err(e) => tracing::warn!("ebay offers: failed to dump raw response: {e}"),
        }
    }
    Ok(offers)
}

/// Result of a one-shot Trading-API GetItem probe — used while we figure
/// out which buyer-side endpoint actually exposes Send-Offer-to-Buyer
/// data. Returns substring counts for offer-related XML fragments and a
/// path to a temp file containing the full response.
#[derive(Debug, Clone, Serialize)]
pub struct ItemProbeResult {
    pub item_id: String,
    pub dump_path: String,
    pub best_offer_details_count: usize,
    pub best_offer_inline_count: usize,
    pub best_offer_with_attrs_count: usize,
    pub best_offer_enabled_count: usize,
    pub best_offer_count_tag_count: usize,
    pub best_offer_id_count: usize,
    pub seller_offer_count: usize,
    pub response_size_bytes: usize,
}

/// Probe a single watched item via Trading API GetItem with the buyer's
/// IAF token. Diagnostic-only — gives us the full GetItem response so we
/// can see whether eBay surfaces Send-Offer-to-Buyer info there (and if
/// so under what tag), without making 200+ calls fanning out from the
/// watchlist.
pub async fn probe_item(
    env: EbayEnvironment,
    iaf_token: &str,
    item_id: &str,
) -> AppResult<ItemProbeResult> {
    if !is_safe_id(item_id) {
        return Err(AppError::Parse(format!(
            "refusing to send malformed item id: {item_id:?}"
        )));
    }
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>{item_id}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>"#
    );
    let xml = trading_post(env, iaf_token, "GetItem", &body).await?;

    let path = std::env::temp_dir().join(format!(
        "diecast_getitem_{}_{}.xml",
        item_id,
        chrono::Utc::now().timestamp()
    ));
    if let Err(e) = std::fs::write(&path, xml.as_bytes()) {
        tracing::warn!("ebay probe: failed to write dump: {e}");
    }

    let count = |needle: &str| xml.matches(needle).count();
    let result = ItemProbeResult {
        item_id: item_id.to_string(),
        dump_path: path.to_string_lossy().into_owned(),
        best_offer_details_count: count("<BestOfferDetails"),
        best_offer_inline_count: count("<BestOffer>"),
        best_offer_with_attrs_count: count("<BestOffer "),
        best_offer_enabled_count: count("BestOfferEnabled"),
        best_offer_count_tag_count: count("<BestOfferCount>"),
        best_offer_id_count: count("BestOfferID"),
        seller_offer_count: count("SellerOffer"),
        response_size_bytes: xml.len(),
    };
    tracing::info!(
        "ebay GetItem probe ({item_id}): {} bytes, BestOfferDetails={}, <BestOffer>={}, <BestOffer (attrs)={}, BestOfferEnabled={}, BestOfferCount={}, BestOfferID={}, SellerOffer={}",
        result.response_size_bytes,
        result.best_offer_details_count,
        result.best_offer_inline_count,
        result.best_offer_with_attrs_count,
        result.best_offer_enabled_count,
        result.best_offer_count_tag_count,
        result.best_offer_id_count,
        result.seller_offer_count,
    );
    tracing::info!("ebay GetItem probe: dumped raw response to {}", result.dump_path);
    Ok(result)
}

/// Result of the GetMyMessages probe. Each <MessageType> seen is
/// reported with its count so we can spot the type that flags
/// Send-Offer-to-Buyer notifications.
#[derive(Debug, Clone, Serialize)]
pub struct MessagesProbeResult {
    pub dump_path: String,
    pub response_size_bytes: usize,
    pub message_count: usize,
    pub item_id_count: usize,
    pub offer_keyword_count: usize,
    pub sent_you_keyword_count: usize,
    /// (MessageType value, count). Sorted descending by count.
    pub message_types: Vec<(String, usize)>,
}

/// Probe Trading API GetMyMessages over the last 30 days. Returns
/// substring + MessageType breakdown so we can identify whether
/// Send-Offer-to-Buyer notifications come through here and what
/// <MessageType> value flags them.
pub async fn probe_messages(
    env: EbayEnvironment,
    iaf_token: &str,
) -> AppResult<MessagesProbeResult> {
    let now = chrono::Utc::now();
    let start = now - chrono::Duration::days(30);
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnHeaders</DetailLevel>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
  <StartTime>{}</StartTime>
  <EndTime>{}</EndTime>
</GetMyMessagesRequest>"#,
        start.to_rfc3339(),
        now.to_rfc3339(),
    );
    let xml = trading_post(env, iaf_token, "GetMyMessages", &body).await?;

    let path = std::env::temp_dir().join(format!(
        "diecast_messages_{}.xml",
        now.timestamp()
    ));
    if let Err(e) = std::fs::write(&path, xml.as_bytes()) {
        tracing::warn!("ebay messages probe: failed to write dump: {e}");
    }

    let xml_lower = xml.to_lowercase();
    let mut type_counts: HashMap<String, usize> = HashMap::new();
    for cap in MESSAGE_TYPE_RE.captures_iter(&xml) {
        if let Some(m) = cap.get(1) {
            *type_counts.entry(m.as_str().to_string()).or_insert(0) += 1;
        }
    }
    let mut message_types: Vec<(String, usize)> =
        type_counts.into_iter().collect();
    message_types.sort_by(|a, b| b.1.cmp(&a.1));

    let result = MessagesProbeResult {
        dump_path: path.to_string_lossy().into_owned(),
        response_size_bytes: xml.len(),
        message_count: xml.matches("<Message>").count(),
        item_id_count: xml.matches("<ItemID>").count(),
        offer_keyword_count: xml_lower.matches("offer").count(),
        sent_you_keyword_count: xml_lower.matches("sent you").count(),
        message_types,
    };
    tracing::info!(
        "ebay messages probe: {} bytes, messages={}, item_ids={}, offer_keyword={}, sent_you_keyword={}, types={:?}",
        result.response_size_bytes,
        result.message_count,
        result.item_id_count,
        result.offer_keyword_count,
        result.sent_you_keyword_count,
        result.message_types,
    );
    tracing::info!("ebay messages probe: dumped raw response to {}", result.dump_path);
    Ok(result)
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
static MESSAGE_TYPE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<MessageType>([^<]+)</MessageType>").unwrap());

pub fn parse_offers_response(xml: &str) -> AppResult<Vec<ReceivedOffer>> {
    parse_offers_response_with_stats(xml).map(|(o, _)| o)
}

/// Diagnostic counters returned alongside the parsed offers so the
/// caller can log what shape eBay actually sent us.
#[derive(Debug, Default, Clone)]
pub struct OffersStats {
    pub watched_count: usize,
    pub items_with_best_offer_details: usize,
    pub items_with_nonzero_count: usize,
    pub items_with_inline_offer: usize,
    /// XML fragment of the first item's <BestOfferDetails> section, if
    /// any. Used to print a one-off sample so we know whether eBay sent
    /// inline offer data or just a summary.
    pub sample_best_offer_details: Option<String>,
}

pub fn parse_offers_response_with_stats(
    xml: &str,
) -> AppResult<(Vec<ReceivedOffer>, OffersStats)> {
    if FAILURE_RE.is_match(xml) {
        let detail = LONG_MESSAGE_RE
            .captures(xml)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_else(|| "GetMyeBayBuying returned Failure".to_string());
        return Err(AppError::Network(format!("trading api: {detail}")));
    }

    let mut out: Vec<ReceivedOffer> = Vec::new();
    let mut stats = OffersStats::default();
    for cap in ITEM_BLOCK_RE.captures_iter(xml) {
        let item_xml = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let item_id = match extract_text(item_xml, "ItemID") {
            Some(id) => id,
            None => continue, // not a real item block
        };
        stats.watched_count += 1;
        let item_title =
            extract_text(item_xml, "Title").unwrap_or_else(|| "(untitled)".to_string());
        let item_web_url = extract_text(item_xml, "ViewItemURL");
        let item_image_url = extract_text(item_xml, "GalleryURL");
        let item_current_price_cents = extract_text(item_xml, "CurrentPrice")
            .and_then(|s| dollars_string_to_cents(&s));

        let bod = extract_text(item_xml, "BestOfferDetails");
        if let Some(bod_text) = &bod {
            stats.items_with_best_offer_details += 1;
            let count = extract_text(bod_text, "BestOfferCount")
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            if count > 0 {
                stats.items_with_nonzero_count += 1;
            }
            if stats.sample_best_offer_details.is_none() {
                stats.sample_best_offer_details = Some(bod_text.clone());
            }
        }

        let mut produced_for_this_item = false;
        for offer_cap in OFFER_BLOCK_RE.captures_iter(item_xml) {
            let off_xml = offer_cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let offer_id = match extract_text(off_xml, "BestOfferID") {
                Some(id) => id,
                None => continue,
            };
            produced_for_this_item = true;
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
        if produced_for_this_item {
            stats.items_with_inline_offer += 1;
        }
    }
    Ok((out, stats))
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
        let (offers, stats) = parse_offers_response_with_stats(FIXTURE).unwrap();
        assert_eq!(stats.watched_count, 3, "fixture has 3 watched items");
        assert_eq!(
            stats.items_with_best_offer_details, 3,
            "all three items carry a BestOfferDetails block"
        );
        assert_eq!(
            stats.items_with_nonzero_count, 1,
            "only one item has BestOfferCount > 0"
        );
        assert_eq!(
            stats.items_with_inline_offer, 1,
            "and that one carries an inline <BestOffer>"
        );
        assert_eq!(offers.len(), 1);

        let seller_offer = &offers[0];
        assert_eq!(seller_offer.item_id, "123456789012");
        assert!(seller_offer.item_title.contains("Jeff Gordon"));
        assert_eq!(
            seller_offer.item_web_url.as_deref(),
            Some("https://www.ebay.com/itm/123456789012")
        );
        assert!(seller_offer
            .item_image_url
            .as_deref()
            .is_some_and(|u| u.starts_with("https://i.ebayimg")));
        assert_eq!(seller_offer.item_current_price_cents, Some(4995));
        assert_eq!(seller_offer.offer_id, "5550000001");
        assert_eq!(seller_offer.offer_status, "Pending");
        assert_eq!(seller_offer.offer_type.as_deref(), Some("SellerOffer"));
        assert_eq!(seller_offer.offer_price_cents, Some(3995));
        assert_eq!(seller_offer.offer_currency, "USD");
        assert!(seller_offer.expiration_time.is_some());
        assert_eq!(
            seller_offer.seller_message.as_deref(),
            Some("Special offer just for you — 20% off!")
        );
        assert_eq!(seller_offer.buyer_message, None);
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
  </WatchList>
</GetMyeBayBuyingResponse>"#;
        let (offers, stats) = parse_offers_response_with_stats(xml).unwrap();
        assert_eq!(offers.len(), 0);
        assert_eq!(stats.watched_count, 0);
        assert_eq!(stats.items_with_inline_offer, 0);
    }

    #[test]
    fn watchlist_with_no_offers_yields_empty_offers_but_nonzero_watched() {
        // Common real-world case: buyer watches items, no seller has sent
        // them an offer yet. We should report 0 offers but a non-zero
        // watched_count so the diagnostic log can distinguish "auth/scope
        // problem" from "just no offers right now".
        let xml = r#"<?xml version="1.0"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <WatchList>
    <ItemArray>
      <Item>
        <ItemID>111111111111</ItemID>
        <Title>Watched item, no offer</Title>
        <BestOfferDetails><BestOfferCount>0</BestOfferCount></BestOfferDetails>
      </Item>
      <Item>
        <ItemID>222222222222</ItemID>
        <Title>Another watched item, no offer</Title>
      </Item>
    </ItemArray>
  </WatchList>
</GetMyeBayBuyingResponse>"#;
        let (offers, stats) = parse_offers_response_with_stats(xml).unwrap();
        assert_eq!(offers.len(), 0);
        assert_eq!(stats.watched_count, 2);
        assert_eq!(stats.items_with_inline_offer, 0);
        // First item has a BestOfferDetails block (with count 0); second
        // doesn't. Expect exactly one BOD-present and zero non-zero
        // counts.
        assert_eq!(stats.items_with_best_offer_details, 1);
        assert_eq!(stats.items_with_nonzero_count, 0);
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
