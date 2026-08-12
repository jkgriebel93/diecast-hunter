//! On-demand item detail for the Seller Feed (DCH-52): the full image set,
//! the seller-filled item specifics (`localizedAspects`), and a plain-text
//! description, parsed out of a Browse `getItem` payload. Pure string/JSON
//! work — the payload arrives either from a watched listing's stored
//! `listings.raw_json` (the same `getItem` shape, no network needed) or
//! from a fresh fetch the command layer performs.

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct ItemAspect {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeedItemDetail {
    pub item_id: String,
    /// Primary image first, then `additionalImages`, deduped preserving
    /// order — eBay sometimes repeats the primary in the additional list.
    pub image_urls: Vec<String>,
    pub aspects: Vec<ItemAspect>,
    /// Plain text: eBay descriptions are seller HTML, which is stripped
    /// here so the frontend never has to render markup it didn't write.
    /// `None` when the listing has no usable description text.
    pub description: Option<String>,
}

pub fn detail_from_raw(item_id: &str, raw: &str) -> AppResult<FeedItemDetail> {
    let v: Value = serde_json::from_str(raw)
        .map_err(|e| AppError::Parse(format!("ebay item payload unparseable: {e}")))?;
    Ok(detail_from_value(item_id, &v))
}

pub fn detail_from_value(item_id: &str, v: &Value) -> FeedItemDetail {
    let mut image_urls: Vec<String> = Vec::new();
    let mut push_image = |url: Option<&str>| {
        if let Some(u) = url {
            if !u.is_empty() && !image_urls.iter().any(|x| x == u) {
                image_urls.push(u.to_string());
            }
        }
    };
    push_image(v.pointer("/image/imageUrl").and_then(Value::as_str));
    if let Some(extra) = v.get("additionalImages").and_then(Value::as_array) {
        for img in extra {
            push_image(img.get("imageUrl").and_then(Value::as_str));
        }
    }

    let aspects = v
        .get("localizedAspects")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let name = a.get("name").and_then(Value::as_str)?;
                    let value = a.get("value").and_then(Value::as_str)?;
                    if name.is_empty() || value.is_empty() {
                        return None;
                    }
                    Some(ItemAspect {
                        name: name.to_string(),
                        value: value.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // `description` is the seller's full HTML block; `shortDescription` is
    // eBay's plain-text digest. Prefer the full one, but only when it still
    // says something after the markup comes off.
    let description = ["description", "shortDescription"]
        .iter()
        .filter_map(|k| v.get(*k).and_then(Value::as_str))
        .map(strip_html)
        .find(|s| !s.is_empty());

    FeedItemDetail {
        item_id: item_id.to_string(),
        image_urls,
        aspects,
        description,
    }
}

/// Reduce seller HTML to readable plain text: tags dropped, block-ish tags
/// turned into line breaks, the handful of entities sellers actually use
/// decoded, runs of whitespace collapsed. Not a general HTML parser — the
/// output is only ever displayed as text, so under-stripping cannot become
/// markup and the worst failure is an ugly description.
fn strip_html(input: &str) -> String {
    let mut text = String::with_capacity(input.len());
    let mut chars = input.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '<' {
            let rest = &input[i + 1..];
            let lower = rest
                .chars()
                .take_while(|ch| ch.is_ascii_alphabetic() || *ch == '/')
                .collect::<String>()
                .to_ascii_lowercase();
            if matches!(
                lower.trim_start_matches('/'),
                "p" | "br" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4"
            ) {
                text.push('\n');
            }
            // Skip to the closing '>' (or the end for unterminated tags).
            for (_, tc) in chars.by_ref() {
                if tc == '>' {
                    break;
                }
            }
        } else {
            text.push(c);
        }
    }
    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    // Collapse horizontal whitespace, keep at most single blank-line breaks.
    let mut out = String::with_capacity(decoded.len());
    let mut pending_newline = false;
    let mut pending_space = false;
    for c in decoded.chars() {
        if c == '\n' {
            pending_newline = !out.is_empty();
            pending_space = false;
        } else if c.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_newline {
                out.push('\n');
            } else if pending_space {
                out.push(' ');
            }
            pending_newline = false;
            pending_space = false;
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixtures/ebay/item_response.json");

    #[test]
    fn parses_the_fixture_images() {
        let d = detail_from_raw("v1|123456789012|0", FIXTURE).unwrap();
        assert_eq!(d.item_id, "v1|123456789012|0");
        // Primary image plus the fixture's one additional image.
        assert_eq!(d.image_urls.len(), 2);
        // The fixture has no localizedAspects; that reads as empty, not an error.
        assert!(d.aspects.is_empty());
        // shortDescription is present and becomes the description.
        assert!(d.description.is_some());
    }

    #[test]
    fn parses_aspects_and_prefers_full_description() {
        let raw = serde_json::json!({
            "image": { "imageUrl": "https://img/1.jpg" },
            "additionalImages": [
                { "imageUrl": "https://img/1.jpg" },
                { "imageUrl": "https://img/2.jpg" }
            ],
            "localizedAspects": [
                { "type": "STRING", "name": "Scale", "value": "1:24" },
                { "type": "STRING", "name": "Driver", "value": "Jeff Gordon" }
            ],
            "description": "<div><p>Mint &amp; boxed.</p><p>1 of 5,004</p></div>",
            "shortDescription": "short version"
        })
        .to_string();
        let d = detail_from_raw("v1|1|0", &raw).unwrap();
        // Duplicate of the primary image is dropped, order kept.
        assert_eq!(d.image_urls, vec!["https://img/1.jpg", "https://img/2.jpg"]);
        assert_eq!(d.aspects.len(), 2);
        assert_eq!(d.aspects[0].name, "Scale");
        assert_eq!(d.aspects[0].value, "1:24");
        assert_eq!(d.description.as_deref(), Some("Mint & boxed.\n1 of 5,004"));
    }

    #[test]
    fn empty_and_missing_fields_read_as_absent_not_errors() {
        let d = detail_from_raw("v1|1|0", "{}").unwrap();
        assert!(d.image_urls.is_empty());
        assert!(d.aspects.is_empty());
        assert!(d.description.is_none());

        // A description that is nothing but markup reads as no description.
        let raw = serde_json::json!({ "description": "<div><br/></div>" }).to_string();
        let d = detail_from_raw("v1|1|0", &raw).unwrap();
        assert!(d.description.is_none());
    }

    #[test]
    fn garbage_json_is_a_parse_error() {
        assert!(detail_from_raw("v1|1|0", "not json").is_err());
    }
}
