//! Seller-initiated Best Offers ("Send Offer to Buyer") that appear in
//! the user's My-Messages inbox. eBay's Trading API doesn't expose a
//! BestOfferID for these, so in-app accept/decline isn't possible —
//! the UI deep-links to the listing page where eBay's web UI handles
//! both actions.
//!
//! Flow:
//!   1. GetMyMessages with DetailLevel=ReturnHeaders, last 30 days
//!      → list of message headers (Subject, ItemID, ReceiveDate, Read, …)
//!   2. Filter to subjects matching a known offer pattern.
//!   3. GetMyMessages with DetailLevel=ReturnMessages + batches of up to
//!      10 MessageIDs → HTML bodies with the offer price and expiration.
//!   4. Parse each body's `id="offer-amount"` / `id="offer-expires"` /
//!      "Buy It Now: $X" cells out of the HTML.
//!   5. Join with the local `listings` table (where the user has
//!      synced their watchlist) to enrich each row with the listing's
//!      image. Items the user hasn't synced just have no image.

use std::collections::HashMap;
use std::error::Error as _;
use std::time::Duration;

use chrono::{DateTime, Datelike, FixedOffset, TimeZone, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::ebay::client::EbayEnvironment;
use crate::ebay::parse::{dollars_string_to_cents, legacy_id_from_v1};
use crate::ebay::trading::trading_endpoint;
use crate::error::{AppError, AppResult};

const COMPATIBILITY_LEVEL: &str = "1193";
const SITE_ID_US: &str = "0";
/// Trading API's GetMyMessages caps `MessageIDs` at 10 per request when
/// pulling full bodies (DetailLevel=ReturnMessages).
const BODY_BATCH_SIZE: usize = 10;
/// How far back we ask for messages. Send-Offer-to-Buyer notifications
/// expire after a few days, so a month is generous coverage.
const LOOKBACK_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize)]
pub struct ReceivedOffer {
    pub message_id: String,
    pub item_id: String,
    pub item_title: String,
    /// Direct deep-link to the listing on eBay. Built from the item id
    /// so we get a clean URL without the message's marketing tracking
    /// params.
    pub item_web_url: String,
    /// Gallery image from the local `listings` table when the user has
    /// synced their watchlist; None otherwise.
    pub item_image_url: Option<String>,
    /// Listing's "Buy It Now" price as quoted in the offer email body.
    pub original_price_cents: Option<i64>,
    /// "Your offer: $X" cell from the body.
    pub offer_price_cents: Option<i64>,
    pub currency: String,
    /// % off, parsed from the subject ("Seller offered a special
    /// discount 10% on …").
    pub discount_percent: Option<f64>,
    /// Raw "Offer expires: May-14 15:58:53 PDT" text from the body, kept
    /// for display when the parsed timestamp is None.
    pub expires_at_text: Option<String>,
    /// Best-effort parsed expiration; None if the timezone or format is
    /// one we don't recognize.
    pub expires_at: Option<i64>,
    pub received_at: i64,
    pub is_read: bool,
}

/// Top-level entry point used by the `list_ebay_offers` Tauri command.
pub async fn fetch_received_offers(
    pool: &SqlitePool,
    env: EbayEnvironment,
    iaf_token: &str,
) -> AppResult<Vec<ReceivedOffer>> {
    let headers = fetch_offer_headers(env, iaf_token).await?;
    if headers.is_empty() {
        return Ok(Vec::new());
    }

    // Pull image URLs for items the user has previously synced into
    // `listings`. Single query keyed by legacy item id.
    let listing_images = load_listing_images(pool).await?;

    // Batch body fetches. eBay caps at 10 IDs per call; the rate
    // limiter on the regular EbayClient is separate from these raw
    // Trading-API posts so we stay well under any rate limits in
    // practice (rarely more than ~20 batches per refresh).
    let mut bodies: HashMap<String, MessageBody> = HashMap::new();
    for chunk in headers.chunks(BODY_BATCH_SIZE) {
        let ids: Vec<&str> = chunk.iter().map(|h| h.message_id.as_str()).collect();
        let map = fetch_message_bodies(env, iaf_token, &ids).await?;
        bodies.extend(map);
    }

    let mut out = Vec::with_capacity(headers.len());
    for h in headers {
        let body = bodies.remove(&h.message_id).unwrap_or_default();
        out.push(ReceivedOffer {
            message_id: h.message_id.clone(),
            item_id: h.item_id.clone(),
            item_title: h.item_title,
            item_web_url: format!("https://www.ebay.com/itm/{}", h.item_id),
            item_image_url: listing_images.get(&h.item_id).cloned(),
            original_price_cents: body.original_price_cents,
            offer_price_cents: body.offer_price_cents,
            currency: body.currency.unwrap_or_else(|| "USD".to_string()),
            discount_percent: h.discount_percent,
            expires_at: body
                .expires_at_text
                .as_deref()
                .and_then(|s| parse_offer_expiration(s, h.received_at)),
            expires_at_text: body.expires_at_text,
            received_at: h.received_at,
            is_read: h.is_read,
        });
    }
    // Most recently received first.
    out.sort_by(|a, b| b.received_at.cmp(&a.received_at));
    Ok(out)
}

// ---------- step 1: header fetch + filter ----------

#[derive(Debug, Clone)]
struct OfferHeader {
    message_id: String,
    item_id: String,
    item_title: String,
    received_at: i64,
    is_read: bool,
    discount_percent: Option<f64>,
}

async fn fetch_offer_headers(env: EbayEnvironment, iaf_token: &str) -> AppResult<Vec<OfferHeader>> {
    let now = Utc::now();
    let start = now - chrono::Duration::days(LOOKBACK_DAYS);
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
    parse_offer_headers(&xml)
}

pub fn parse_offer_headers(xml: &str) -> AppResult<Vec<OfferHeader>> {
    if FAILURE_RE.is_match(xml) {
        let detail = LONG_MESSAGE_RE
            .captures(xml)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_else(|| "GetMyMessages returned Failure".to_string());
        return Err(AppError::Network(format!("trading api: {detail}")));
    }

    let mut out = Vec::new();
    for cap in MESSAGE_BLOCK_RE.captures_iter(xml) {
        let block = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let subject = match extract_text(block, "Subject") {
            Some(s) => s,
            None => continue,
        };
        let discount = parse_discount_pct(&subject);
        if !is_offer_subject(&subject) {
            continue;
        }
        let message_id = match extract_text(block, "MessageID") {
            Some(s) => s,
            None => continue,
        };
        let item_id = match extract_text(block, "ItemID") {
            Some(s) => s,
            None => continue,
        };
        let item_title = extract_text(block, "ItemTitle")
            .or_else(|| Some(subject.clone()))
            .unwrap_or_default();
        let received_at = extract_text(block, "ReceiveDate")
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp())
            .unwrap_or(0);
        let is_read = extract_text(block, "Read").as_deref() == Some("true");
        out.push(OfferHeader {
            message_id,
            item_id,
            item_title,
            received_at,
            is_read,
            discount_percent: discount,
        });
    }
    Ok(out)
}

/// True for the canonical eBay subject patterns we've seen in real
/// "Send Offer to Buyer" messages.
fn is_offer_subject(subject: &str) -> bool {
    let s = subject.to_ascii_lowercase();
    s.starts_with("seller offered a special discount")
        || s.starts_with("special limited-time")
        || s.starts_with("special limited time")
}

fn parse_discount_pct(subject: &str) -> Option<f64> {
    DISCOUNT_RE
        .captures(subject)
        .and_then(|c| c.get(1).and_then(|m| m.as_str().parse::<f64>().ok()))
}

// ---------- step 2: body fetch + parse ----------

#[derive(Debug, Clone, Default)]
struct MessageBody {
    original_price_cents: Option<i64>,
    offer_price_cents: Option<i64>,
    currency: Option<String>,
    expires_at_text: Option<String>,
}

async fn fetch_message_bodies(
    env: EbayEnvironment,
    iaf_token: &str,
    message_ids: &[&str],
) -> AppResult<HashMap<String, MessageBody>> {
    let ids_xml: String = message_ids
        .iter()
        .filter(|id| is_safe_id(id))
        .map(|id| format!("    <MessageID>{id}</MessageID>\n"))
        .collect();
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnMessages</DetailLevel>
  <MessageIDs>
{ids_xml}  </MessageIDs>
</GetMyMessagesRequest>"#
    );
    let xml = trading_post(env, iaf_token, "GetMyMessages", &body).await?;
    parse_message_bodies(&xml)
}

pub fn parse_message_bodies(xml: &str) -> AppResult<HashMap<String, MessageBody>> {
    if FAILURE_RE.is_match(xml) {
        let detail = LONG_MESSAGE_RE
            .captures(xml)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_else(|| "GetMyMessages (bodies) returned Failure".to_string());
        return Err(AppError::Network(format!("trading api: {detail}")));
    }

    let mut out = HashMap::new();
    for cap in MESSAGE_BLOCK_RE.captures_iter(xml) {
        let block = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let message_id = match extract_text(block, "MessageID") {
            Some(s) => s,
            None => continue,
        };
        // eBay returns the body in two forms — `<Text>` (unescaped HTML)
        // and `<Content>` (XML-entity-encoded HTML). We prefer `<Content>`
        // because it's safe to extract via simple `</Content>` boundary.
        let raw = extract_text(block, "Content").or_else(|| extract_text(block, "Text"));
        let decoded = raw.map(|s| decode_html_entities(&s)).unwrap_or_default();
        out.insert(message_id, parse_offer_body_html(&decoded));
    }
    Ok(out)
}

fn parse_offer_body_html(html: &str) -> MessageBody {
    let mut body = MessageBody::default();

    // "Your offer: $XX.XX"
    if let Some(cap) = OFFER_AMOUNT_RE.captures(html) {
        if let Some(snippet) = cap.get(1) {
            let (cents, currency) = first_money(snippet.as_str());
            body.offer_price_cents = cents;
            if body.currency.is_none() {
                body.currency = currency;
            }
        }
    }
    // "Buy It Now: $XX.XX"
    if let Some(cap) = BIN_RE.captures(html) {
        if let Some(amt) = cap.get(1) {
            body.original_price_cents = dollars_string_to_cents(amt.as_str());
        }
    }
    // "Offer expires: May-14 15:58:53 PDT"
    if let Some(cap) = OFFER_EXPIRES_RE.captures(html) {
        if let Some(snippet) = cap.get(1) {
            if let Some(text) = EXPIRES_TEXT_RE
                .captures(snippet.as_str())
                .and_then(|c| c.get(1))
            {
                body.expires_at_text = Some(text.as_str().trim().to_string());
            }
        }
    }
    body
}

/// Pull the first `$XX.XX` (or `12.34`) match out of a snippet, with a
/// best-effort currency tag (always "USD" for the messages we see).
fn first_money(snippet: &str) -> (Option<i64>, Option<String>) {
    let m = MONEY_RE.captures(snippet);
    let cents = m
        .as_ref()
        .and_then(|c| c.get(1))
        .and_then(|m| dollars_string_to_cents(m.as_str()));
    let currency = if m.is_some() {
        Some("USD".to_string())
    } else {
        None
    };
    (cents, currency)
}

/// Decode the minimum set of XML entities we care about. Order matters:
/// `&amp;` last so we don't double-decode (`&amp;lt;` → `&lt;` → `<`
/// would be wrong if we decoded `&amp;` first).
fn decode_html_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

// ---------- step 3: parse the expiration timestamp ----------

/// Convert eBay's `MMM-DD HH:MM:SS TZ` format (e.g. "May-14 15:58:53
/// PDT") to a Unix timestamp using the message's receive year as the
/// anchor. If the parsed date would be more than ~90 days *before* the
/// receive date (year-boundary case), bump to the next year.
pub fn parse_offer_expiration(text: &str, received_at: i64) -> Option<i64> {
    let cap = EXPIRES_DATE_RE.captures(text)?;
    let month = month_num(cap.get(1)?.as_str())?;
    let day: u32 = cap.get(2)?.as_str().parse().ok()?;
    let hour: u32 = cap.get(3)?.as_str().parse().ok()?;
    let minute: u32 = cap.get(4)?.as_str().parse().ok()?;
    let second: u32 = cap.get(5)?.as_str().parse().ok()?;
    let tz_offset = offset_for_tz(cap.get(6)?.as_str())?;

    let received = DateTime::<Utc>::from_timestamp(received_at, 0)?;
    let mut year = received.year();
    let fixed = FixedOffset::east_opt(tz_offset)?;
    let mut dt = build_dt(year, month, day, hour, minute, second, fixed)?;
    if received.timestamp() - dt.timestamp() > 90 * 24 * 3600 {
        year += 1;
        dt = build_dt(year, month, day, hour, minute, second, fixed)?;
    }
    Some(dt.timestamp())
}

fn build_dt(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    offset: FixedOffset,
) -> Option<DateTime<FixedOffset>> {
    let naive =
        chrono::NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, second)?;
    offset.from_local_datetime(&naive).single()
}

fn month_num(m: &str) -> Option<u32> {
    match m {
        "Jan" => Some(1),
        "Feb" => Some(2),
        "Mar" => Some(3),
        "Apr" => Some(4),
        "May" => Some(5),
        "Jun" => Some(6),
        "Jul" => Some(7),
        "Aug" => Some(8),
        "Sep" => Some(9),
        "Oct" => Some(10),
        "Nov" => Some(11),
        "Dec" => Some(12),
        _ => None,
    }
}

fn offset_for_tz(tz: &str) -> Option<i32> {
    let hours = match tz {
        "UTC" | "GMT" => 0,
        "EDT" => -4,
        "EST" => -5,
        "CDT" => -5,
        "CST" => -6,
        "MDT" => -6,
        "MST" => -7,
        "PDT" => -7,
        "PST" => -8,
        "AKDT" => -8,
        "AKST" => -9,
        "HST" => -10,
        _ => return None,
    };
    Some(hours * 3600)
}

// ---------- step 4: local listings join ----------

async fn load_listing_images(pool: &SqlitePool) -> AppResult<HashMap<String, String>> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT l.external_id, l.image_url
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay' AND l.image_url IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let mut map = HashMap::new();
    for (ext_id, img) in rows {
        let Some(img) = img else { continue };
        let legacy = legacy_id_from_v1(&ext_id).unwrap_or(ext_id);
        map.insert(legacy, img);
    }
    Ok(map)
}

// ---------- shared helpers ----------

async fn trading_post(
    env: EbayEnvironment,
    iaf_token: &str,
    call_name: &str,
    body: &str,
) -> AppResult<String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
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

fn is_safe_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) && s.len() <= 20
}

/// Extract the text between the first `<tag ...>` ... `</tag>`. Handles
/// open tags with attributes. Picks the closest opening tag before the
/// matching close so it tolerates the rare nesting we don't expect.
fn extract_text(xml: &str, tag: &str) -> Option<String> {
    let close = format!("</{tag}>");
    let close_pos = xml.find(&close)?;
    let before = &xml[..close_pos];
    let pat_with_space = format!("<{tag} ");
    let pat_no_space = format!("<{tag}>");
    let open_idx = before
        .rfind(&pat_with_space)
        .or_else(|| before.rfind(&pat_no_space))?;
    let after_open = &before[open_idx..];
    let gt = after_open.find('>')? + 1;
    Some(after_open[gt..].to_string())
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

// ---------- statics ----------

static FAILURE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<Ack>Failure</Ack>").unwrap());
static LONG_MESSAGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<LongMessage>([^<]+)</LongMessage>").unwrap());
static MESSAGE_BLOCK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)<Message>(.*?)</Message>").unwrap());
static DISCOUNT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)([\d.]+)\s*%").unwrap());
static MONEY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\$([\d,]+\.\d{2})").unwrap());
static OFFER_AMOUNT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?s)<td[^>]*id="offer-amount"[^>]*>(.*?)</td>"#).unwrap());
static OFFER_EXPIRES_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?s)<td[^>]*id="offer-expires"[^>]*>(.*?)</td>"#).unwrap());
static BIN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"Buy It Now:\s*\$([\d,]+\.\d{2})").unwrap());
static EXPIRES_TEXT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)offer expires?:\s*([^<\n]+)").unwrap());
static EXPIRES_DATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"([A-Za-z]{3})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Z]{2,4})").unwrap()
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_offer_subjects() {
        assert!(is_offer_subject(
            "Seller offered a special discount 10% on RARE! Carl Edwards…"
        ));
        assert!(is_offer_subject(
            "Special limited-time 12% discount on 2002…"
        ));
        assert!(!is_offer_subject("A new device is using your account"));
        assert!(!is_offer_subject(
            "John, share feedback on your recent purchase"
        ));
    }

    #[test]
    fn parses_discount_pct_from_subject() {
        assert_eq!(
            parse_discount_pct("Seller offered a special discount 10% on …"),
            Some(10.0)
        );
        assert_eq!(
            parse_discount_pct("Seller offered a special discount 6.3% on …"),
            Some(6.3)
        );
        assert_eq!(parse_discount_pct("no percent here"), None);
    }

    #[test]
    fn extracts_offer_fields_from_body_html() {
        let html = r#"
<table>
  <tr>
    <td id="bin-amount" valign="top"><font>Buy It Now: $54.99</font></td>
  </tr>
  <tr>
    <td id="offer-amount" valign="top"><font>Your offer: $49.49</font></td>
  </tr>
  <tr>
    <td id="offer-expires" valign="top"><font>Offer expires: May-14 15:58:53 PDT</font></td>
  </tr>
</table>"#;
        let body = parse_offer_body_html(html);
        assert_eq!(body.offer_price_cents, Some(4949));
        assert_eq!(body.original_price_cents, Some(5499));
        assert_eq!(body.currency.as_deref(), Some("USD"));
        assert_eq!(body.expires_at_text.as_deref(), Some("May-14 15:58:53 PDT"));
    }

    #[test]
    fn parses_expiration_with_pdt_offset() {
        // Received 2026-05-10T22:58:55Z; expires "May-14 15:58:53 PDT"
        // → 2026-05-14T22:58:53Z.
        let received = DateTime::parse_from_rfc3339("2026-05-10T22:58:55Z")
            .unwrap()
            .timestamp();
        let ts = parse_offer_expiration("May-14 15:58:53 PDT", received).unwrap();
        let dt = DateTime::<Utc>::from_timestamp(ts, 0).unwrap();
        assert_eq!(dt.to_rfc3339(), "2026-05-14T22:58:53+00:00");
    }

    #[test]
    fn parses_expiration_wraps_year() {
        // Received 2026-12-30; expires "Jan-03 12:00:00 EST"
        // → 2027-01-03 17:00:00 UTC (EST = -05:00).
        let received = DateTime::parse_from_rfc3339("2026-12-30T22:00:00Z")
            .unwrap()
            .timestamp();
        let ts = parse_offer_expiration("Jan-03 12:00:00 EST", received).unwrap();
        let dt = DateTime::<Utc>::from_timestamp(ts, 0).unwrap();
        assert_eq!(dt.to_rfc3339(), "2027-01-03T17:00:00+00:00");
    }

    #[test]
    fn parses_headers_fixture_filters_to_offers() {
        let xml = r#"<?xml version="1.0"?>
<GetMyMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Messages>
    <Message>
      <Sender>eBay</Sender>
      <Subject>Seller offered a special discount 10% on RARE Carl Edwards Diecast</Subject>
      <MessageID>208284128583</MessageID>
      <Read>false</Read>
      <ReceiveDate>2026-05-10T22:58:55.000Z</ReceiveDate>
      <ItemID>277960002467</ItemID>
      <ItemTitle>RARE Carl Edwards 1/24 Diecast</ItemTitle>
    </Message>
    <Message>
      <Sender>eBay</Sender>
      <Subject>A new device is using your account</Subject>
      <MessageID>999999999999</MessageID>
      <Read>true</Read>
      <ReceiveDate>2026-05-09T12:00:00.000Z</ReceiveDate>
    </Message>
    <Message>
      <Sender>eBay</Sender>
      <Subject>Special limited-time 15% discount on 2002 Jeff Gordon</Subject>
      <MessageID>208284128584</MessageID>
      <Read>true</Read>
      <ReceiveDate>2026-05-08T15:00:00.000Z</ReceiveDate>
      <ItemID>123456789012</ItemID>
      <ItemTitle>2002 Jeff Gordon</ItemTitle>
    </Message>
  </Messages>
</GetMyMessagesResponse>"#;
        let headers = parse_offer_headers(xml).unwrap();
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[0].message_id, "208284128583");
        assert_eq!(headers[0].discount_percent, Some(10.0));
        assert!(!headers[0].is_read);
        assert_eq!(headers[1].discount_percent, Some(15.0));
        assert!(headers[1].is_read);
    }

    #[test]
    fn parses_bodies_with_encoded_content() {
        let xml = r#"<?xml version="1.0"?>
<GetMyMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Messages>
    <Message>
      <MessageID>208284128583</MessageID>
      <Content>&lt;table&gt;&lt;tr&gt;&lt;td id=&quot;offer-amount&quot;&gt;&lt;font&gt;Your offer: $49.49&lt;/font&gt;&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td id=&quot;offer-expires&quot;&gt;&lt;font&gt;Offer expires: May-14 15:58:53 PDT&lt;/font&gt;&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;&lt;font&gt;Buy It Now: $54.99&lt;/font&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</Content>
    </Message>
  </Messages>
</GetMyMessagesResponse>"#;
        let bodies = parse_message_bodies(xml).unwrap();
        let body = bodies.get("208284128583").unwrap();
        assert_eq!(body.offer_price_cents, Some(4949));
        assert_eq!(body.original_price_cents, Some(5499));
        assert_eq!(body.expires_at_text.as_deref(), Some("May-14 15:58:53 PDT"));
    }

    #[test]
    fn failure_ack_propagates() {
        let xml = r#"<?xml version="1.0"?>
<GetMyMessagesResponse>
  <Ack>Failure</Ack>
  <Errors><LongMessage>Auth token is invalid.</LongMessage></Errors>
</GetMyMessagesResponse>"#;
        let err = parse_offer_headers(xml).unwrap_err();
        assert!(err.to_string().contains("Auth token is invalid"));
    }
}
