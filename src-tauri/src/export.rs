//! Print-friendly HTML exports (registry search results and the wishlist).
//!
//! Turns a set of `ProductionSearchResult`s (whatever the Registry page is
//! currently displaying, post-filter/post-sort) — or the user's wishlist —
//! into a self-contained, print-friendly HTML document. Images are downloaded
//! from DCR and embedded as base64 data URIs so the file works offline; a
//! download failure degrades to a "image unavailable" placeholder rather than
//! failing the export.
//!
//! Search results don't carry discrete car-number / sponsor / finish fields:
//! the car number is parsed off the front of `scheme_text` ("#24 DuPont …"),
//! the remainder of the scheme text stands in for the sponsor, and the finish
//! comes from the caller (the UI passes the selected finish filter, if any).

use base64::Engine;
use serde::Serialize;

use crate::commands::CollectionRow;
use crate::dcr::ProductionSearchResult;
use crate::error::AppResult;
use crate::progress::ProgressEmitter;
use crate::wishlist::WishlistEntry;

const DCR_BASE: &str = "https://www.diecastregistry.com";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Serialize)]
pub struct ExportSummary {
    pub path: String,
    pub entries: usize,
    pub images_embedded: usize,
    pub images_failed: usize,
}

/// Download every result's image, build the document, and write it to `path`.
pub async fn export_registry_results(
    progress: &ProgressEmitter,
    results: &[ProductionSearchResult],
    finish_label: Option<&str>,
    path: &str,
) -> AppResult<ExportSummary> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let total = results.len() as u32;
    let mut images_embedded = 0usize;
    let mut images_failed = 0usize;
    let mut entries: Vec<EntryHtml> = Vec::with_capacity(results.len());

    for (i, r) in results.iter().enumerate() {
        progress.check_cancelled()?;
        progress.step(
            format!("Fetching image {} of {}…", i + 1, total),
            Some(i as u32),
            Some(total),
        );
        let image = match &r.image_url {
            Some(u) => match fetch_image_data_uri(&client, u).await {
                Ok(uri) => {
                    images_embedded += 1;
                    Some(uri)
                }
                Err(e) => {
                    tracing::warn!("export: image fetch failed for {u}: {e}");
                    images_failed += 1;
                    None
                }
            },
            None => None,
        };
        entries.push(EntryHtml {
            header: header_line(r),
            subheader: subheader_line(r, finish_label),
            image_data_uri: image,
            ..Default::default()
        });
    }

    progress.step("Writing file…", Some(total), Some(total));
    let doc = build_document("Registry search export", "result", &entries);
    tokio::fs::write(path, doc).await?;
    progress.done(format!(
        "Exported {} result{} to {path}.",
        entries.len(),
        if entries.len() == 1 { "" } else { "s" },
    ));

    Ok(ExportSummary {
        path: path.to_string(),
        entries: entries.len(),
        images_embedded,
        images_failed,
    })
}

/// Wishlist counterpart of [`export_registry_results`]: same document shape,
/// plus per-entry notes and linked candidate listings.
pub async fn export_wishlist(
    progress: &ProgressEmitter,
    list_name: &str,
    wishes: &[WishlistEntry],
    path: &str,
) -> AppResult<ExportSummary> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let total = wishes.len() as u32;
    let mut images_embedded = 0usize;
    let mut images_failed = 0usize;
    let mut entries: Vec<EntryHtml> = Vec::with_capacity(wishes.len());

    for (i, w) in wishes.iter().enumerate() {
        progress.check_cancelled()?;
        progress.step(
            format!("Fetching image {} of {}…", i + 1, total),
            Some(i as u32),
            Some(total),
        );
        let image = match &w.image_url {
            Some(u) => match fetch_image_data_uri(&client, u).await {
                Ok(uri) => {
                    images_embedded += 1;
                    Some(uri)
                }
                Err(e) => {
                    tracing::warn!("export: image fetch failed for {u}: {e}");
                    images_failed += 1;
                    None
                }
            },
            None => None,
        };
        entries.push(EntryHtml {
            header: wishlist_header_line(w),
            subheader: wishlist_subheader_line(w),
            image_data_uri: image,
            notes: w.notes.clone(),
            candidates: w.listings.iter().map(candidate_line).collect(),
        });
    }

    progress.step("Writing file…", Some(total), Some(total));
    let doc = build_document(list_name, "entry", &entries);
    tokio::fs::write(path, doc).await?;
    progress.done(format!(
        "Exported {} entr{} to {path}.",
        entries.len(),
        if entries.len() == 1 { "y" } else { "ies" },
    ));

    Ok(ExportSummary {
        path: path.to_string(),
        entries: entries.len(),
        images_embedded,
        images_failed,
    })
}

/// My Collection counterpart of [`export_registry_results`]: same document
/// shape, fed by the rows the Collection page is currently displaying
/// (post-filter, post-sort).
pub async fn export_collection(
    progress: &ProgressEmitter,
    rows: &[CollectionRow],
    path: &str,
) -> AppResult<ExportSummary> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let total = rows.len() as u32;
    let mut images_embedded = 0usize;
    let mut images_failed = 0usize;
    let mut entries: Vec<EntryHtml> = Vec::with_capacity(rows.len());

    for (i, r) in rows.iter().enumerate() {
        progress.check_cancelled()?;
        progress.step(
            format!("Fetching image {} of {}…", i + 1, total),
            Some(i as u32),
            Some(total),
        );
        let image = match &r.image_url {
            Some(u) => match fetch_image_data_uri(&client, u).await {
                Ok(uri) => {
                    images_embedded += 1;
                    Some(uri)
                }
                Err(e) => {
                    tracing::warn!("export: image fetch failed for {u}: {e}");
                    images_failed += 1;
                    None
                }
            },
            None => None,
        };
        entries.push(EntryHtml {
            header: collection_header_line(r),
            subheader: collection_subheader_line(r),
            image_data_uri: image,
            ..Default::default()
        });
    }

    progress.step("Writing file…", Some(total), Some(total));
    let doc = build_document("My Collection", "item", &entries);
    tokio::fs::write(path, doc).await?;
    progress.done(format!(
        "Exported {} item{} to {path}.",
        entries.len(),
        if entries.len() == 1 { "" } else { "s" },
    ));

    Ok(ExportSummary {
        path: path.to_string(),
        entries: entries.len(),
        images_embedded,
        images_failed,
    })
}

/// Spreadsheet export of the displayed collection rows. No images, so it's
/// fast and needs no progress plumbing. Money is written as decimal dollars
/// (`55.00`) rather than display strings so spreadsheets can sum the column.
pub async fn export_collection_csv(rows: &[CollectionRow], path: &str) -> AppResult<ExportSummary> {
    let doc = build_collection_csv(rows);
    tokio::fs::write(path, doc).await?;
    Ok(ExportSummary {
        path: path.to_string(),
        entries: rows.len(),
        images_embedded: 0,
        images_failed: 0,
    })
}

fn build_collection_csv(rows: &[CollectionRow]) -> String {
    // Leading BOM so Excel opens the file as UTF-8.
    let mut out = String::from("\u{feff}");
    out.push_str(
        "Driver,Year,Car Number,Scheme,OEM,Brand,Scale,Make,Finish,Type,\
         Production Qty,Retail Value,Wholesale Value,Registration Number,DCR URL\n",
    );
    for r in rows {
        let fields: [String; 15] = [
            r.driver_name.clone().unwrap_or_default(),
            r.year.map(|y| y.to_string()).unwrap_or_default(),
            r.car_number.clone().unwrap_or_default(),
            r.scheme_text.clone().unwrap_or_default(),
            r.oem.clone().unwrap_or_default(),
            r.brand.clone().unwrap_or_default(),
            r.scale.clone().unwrap_or_default(),
            r.make.clone().unwrap_or_default(),
            r.finish.clone().unwrap_or_default(),
            r.diecast_type.clone().unwrap_or_default(),
            r.production_qty.map(|n| n.to_string()).unwrap_or_default(),
            r.retail_value_cents.map(csv_dollars).unwrap_or_default(),
            r.wholesale_value_cents.map(csv_dollars).unwrap_or_default(),
            r.registration_number.clone().unwrap_or_default(),
            r.detail_url
                .as_deref()
                .map(|u| format!("{DCR_BASE}{u}"))
                .unwrap_or_default(),
        ];
        let line: Vec<String> = fields.iter().map(|f| csv_field(f)).collect();
        out.push_str(&line.join(","));
        out.push('\n');
    }
    out
}

/// Plain decimal dollars for CSV (no `$`, no thousands separators).
fn csv_dollars(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, (cents % 100).abs())
}

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[derive(Default)]
struct EntryHtml {
    header: String,
    subheader: String,
    image_data_uri: Option<String>,
    /// Free-form user notes (wishlist only), rendered italic under the
    /// subheader.
    notes: Option<String>,
    /// Pre-formatted linked-listing lines (wishlist only), one bullet each.
    candidates: Vec<String>,
}

/// DCR's diecast-type vocabulary. Search-result scheme text sometimes ends
/// with " - <type>" ("… Ford Mustang - Diecast Chassis"); we strip that
/// suffix from the header, but only when it exactly matches a known type —
/// the same position also carries scheme variant qualifiers ("Signature
/// Series", "Test Car LTS 6/8") that must survive.
const DIECAST_TYPES: &[&str] = &[
    "Airplane / Helicopter",
    "Boat",
    "Diecast Chassis",
    "Dirt Car",
    "Engine",
    "Figurine",
    "Gas Pump",
    "Golf Cart",
    "Hauler",
    "Helmet",
    "Motorcycle",
    "Open Wheel Car",
    "Other",
    "Pedal Car",
    "Pit Wagon",
    "Stock Car",
    "Stock Truck",
    "Train",
    "Truck",
    "Truck & Trailer",
];

/// `#<car number> - <sponsor/scheme>`, with any trailing diecast-type
/// segment removed from the scheme text.
fn header_line(r: &ProductionSearchResult) -> String {
    let (number, scheme_rest) = split_scheme(r.scheme_text.as_deref());
    let mut parts: Vec<String> = Vec::new();
    if let Some(n) = number {
        parts.push(format!("#{n}"));
    }
    if let Some(s) = scheme_rest {
        parts.push(strip_diecast_type(&s));
    }
    if parts.is_empty() {
        parts.push(r.driver_name.clone());
    }
    parts.join(" - ")
}

/// Drop a trailing " - <diecast type>" segment (exact, case-insensitive
/// match against the known type list) from the scheme text.
fn strip_diecast_type(scheme: &str) -> String {
    if let Some((rest, last)) = scheme.rsplit_once(" - ") {
        let last = last.trim();
        if DIECAST_TYPES.iter().any(|t| t.eq_ignore_ascii_case(last)) {
            return rest.trim_end().to_string();
        }
    }
    scheme.to_string()
}

/// `<OEM> - <Brand> - <Scale> - <Finish> - production qty <n> -
/// Retail Value <$>`, silently omitting any field DCR didn't provide
/// (finish in particular is often absent, e.g. on 1:64 scales).
fn subheader_line(r: &ProductionSearchResult, finish_label: Option<&str>) -> String {
    [
        r.oem.clone(),
        r.brand.clone(),
        r.scale.clone(),
        finish_label.map(str::to_string),
        r.seq_produced_total
            .map(|n| format!("production qty {}", format_thousands(n))),
        r.retail_value_cents
            .map(|c| format!("Retail Value {}", format_dollars(c))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" - ")
}

/// Wishlist header: same `#<number> - <scheme>` shape as the registry
/// export, falling back to the driver name when there's no scheme text.
fn wishlist_header_line(w: &WishlistEntry) -> String {
    let (number, scheme_rest) = split_scheme(w.scheme_text.as_deref());
    let mut parts: Vec<String> = Vec::new();
    if let Some(n) = number {
        parts.push(format!("#{n}"));
    }
    if let Some(s) = scheme_rest {
        parts.push(strip_diecast_type(&s));
    }
    if parts.is_empty() {
        parts.push(
            w.driver_name
                .clone()
                .unwrap_or_else(|| "(unknown)".to_string()),
        );
    }
    parts.join(" - ")
}

/// `<Driver> - <Year> - <OEM> - <Brand> - <Scale> - production qty <n> -
/// Retail Value <$>`. Driver leads because a wishlist mixes drivers, unlike
/// a registry search that is usually pinned to one.
fn wishlist_subheader_line(w: &WishlistEntry) -> String {
    [
        w.driver_name.clone(),
        w.year.map(|y| y.to_string()),
        w.oem.clone(),
        w.brand.clone(),
        w.scale.clone(),
        w.production_qty
            .map(|n| format!("production qty {}", format_thousands(n))),
        w.retail_value_cents
            .map(|c| format!("Retail Value {}", format_dollars(c))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" - ")
}

/// Collection header: `#<number> - <scheme>` like the other exports. The
/// number is parsed off the scheme text when present, else taken from the
/// row's discrete `car_number`; falls back to the driver name.
fn collection_header_line(r: &CollectionRow) -> String {
    let (number, scheme_rest) = split_scheme(r.scheme_text.as_deref());
    let number = number.or_else(|| {
        r.car_number
            .as_deref()
            .map(|n| n.trim_start_matches('#').to_string())
            .filter(|n| !n.is_empty())
    });
    let mut parts: Vec<String> = Vec::new();
    if let Some(n) = number {
        parts.push(format!("#{n}"));
    }
    if let Some(s) = scheme_rest {
        parts.push(strip_diecast_type(&s));
    }
    if parts.is_empty() {
        parts.push(
            r.driver_name
                .clone()
                .unwrap_or_else(|| "(unknown)".to_string()),
        );
    }
    parts.join(" - ")
}

/// `<Driver> - <Year> - <OEM> - <Brand> - <Scale> - <Finish> -
/// production qty <n> - Retail Value <$>`. Driver leads because the
/// collection mixes drivers; finish is a discrete field here, unlike search
/// results.
fn collection_subheader_line(r: &CollectionRow) -> String {
    [
        r.driver_name.clone(),
        r.year.map(|y| y.to_string()),
        r.oem.clone(),
        r.brand.clone(),
        r.scale.clone(),
        r.finish.clone(),
        r.production_qty
            .map(|n| format!("production qty {}", format_thousands(n))),
        r.retail_value_cents
            .map(|c| format!("Retail Value {}", format_dollars(c))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" - ")
}

/// One linked candidate listing as a plain text line:
/// `<title> — <total> (<seller>, <status>)`.
fn candidate_line(l: &crate::wishlist::WishlistListing) -> String {
    let price = l
        .price_cents
        .map(|p| format_dollars(p + l.shipping_cents.unwrap_or(0)));
    let mut line = l.title.clone();
    if let Some(p) = price {
        line.push_str(&format!(" — {p}"));
    }
    line.push_str(&format!(" ({}, {})", l.seller_code, l.status));
    line
}

/// Split "#24 DuPont Monte Carlo" into ("24", "DuPont Monte Carlo").
/// Without a leading #number, the whole string is the scheme remainder.
fn split_scheme(scheme: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(s) = scheme.map(str::trim).filter(|s| !s.is_empty()) else {
        return (None, None);
    };
    if let Some(rest) = s.strip_prefix('#') {
        let mut it = rest.splitn(2, char::is_whitespace);
        let number = it.next().unwrap_or("").trim();
        let remainder = it.next().map(str::trim).filter(|r| !r.is_empty());
        if !number.is_empty() {
            return (Some(number.to_string()), remainder.map(str::to_string));
        }
    }
    (None, Some(s.to_string()))
}

fn format_thousands(n: i64) -> String {
    let raw = n.abs().to_string();
    let mut out = String::with_capacity(raw.len() + raw.len() / 3);
    for (i, c) in raw.chars().enumerate() {
        if i > 0 && (raw.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

fn format_dollars(cents: i64) -> String {
    format!(
        "${}.{:02}",
        format_thousands(cents / 100),
        (cents % 100).abs()
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn fetch_image_data_uri(client: &reqwest::Client, url: &str) -> AppResult<String> {
    let abs = if url.starts_with("http") {
        url.to_string()
    } else {
        format!("{DCR_BASE}{url}")
    };
    let bytes = client
        .get(&abs)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let mime = sniff_mime(&bytes, &abs);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn sniff_mime(bytes: &[u8], url: &str) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if url.to_ascii_lowercase().ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    }
}

/// Assemble the print-friendly document: serif headers on white paper,
/// sans-serif subheaders, one full-size image per entry. `noun` is the
/// singular item word for the meta line ("result", "entry").
fn build_document(title: &str, noun: &str, entries: &[EntryHtml]) -> String {
    let generated = chrono::Local::now().format("%B %-d, %Y %-I:%M %p");
    let count = entries.len();
    let count_label = if count == 1 {
        format!("1 {noun}")
    } else if noun == "entry" {
        format!("{count} entries")
    } else {
        format!("{count} {noun}s")
    };
    let mut body = String::new();
    for e in entries {
        body.push_str("<section class=\"entry\">\n");
        body.push_str(&format!("<h2>{}</h2>\n", html_escape(&e.header)));
        if !e.subheader.is_empty() {
            body.push_str(&format!(
                "<div class=\"sub\">{}</div>\n",
                html_escape(&e.subheader)
            ));
        }
        if let Some(notes) = e.notes.as_deref().filter(|n| !n.trim().is_empty()) {
            body.push_str(&format!(
                "<div class=\"notes\">{}</div>\n",
                html_escape(notes)
            ));
        }
        match &e.image_data_uri {
            Some(uri) => body.push_str(&format!("<img src=\"{uri}\" alt=\"\">\n")),
            None => body.push_str("<div class=\"noimg\">image unavailable</div>\n"),
        }
        if !e.candidates.is_empty() {
            body.push_str(
                "<div class=\"cands-label\">Candidate listings</div>\n<ul class=\"cands\">\n",
            );
            for c in &e.candidates {
                body.push_str(&format!("<li>{}</li>\n", html_escape(c)));
            }
            body.push_str("</ul>\n");
        }
        body.push_str("</section>\n");
    }
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title_esc}</title>
<style>
  body {{ background: #fff; color: #1c1c1a; font-family: Georgia, 'Times New Roman', serif;
         max-width: 800px; margin: 0 auto; padding: 32px 24px; }}
  .meta {{ font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #8a877e;
           border-bottom: 2px solid #1c1c1a; padding-bottom: 8px; margin-bottom: 28px; }}
  .entry {{ margin-bottom: 40px; page-break-inside: avoid; }}
  .entry h2 {{ font-size: 22px; font-weight: 600; margin: 0 0 4px; }}
  .entry .sub {{ font-family: Arial, Helvetica, sans-serif; font-size: 14px;
                 color: #5f5c54; margin-bottom: 12px; }}
  .entry .notes {{ font-style: italic; font-size: 15px; color: #3f3d37;
                   margin: -6px 0 12px; }}
  .entry img {{ max-width: 100%; height: auto; display: block;
                border: 1px solid #d9d5cc; }}
  .noimg {{ font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #8a877e;
            border: 1px dashed #d9d5cc; padding: 40px; text-align: center; }}
  .cands-label {{ font-family: Arial, Helvetica, sans-serif; font-size: 12px;
                  font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
                  color: #8a877e; margin: 12px 0 4px; }}
  .cands {{ font-family: Arial, Helvetica, sans-serif; font-size: 13px;
            color: #3f3d37; margin: 0; padding-left: 20px; }}
  .cands li {{ margin-bottom: 2px; }}
</style>
</head>
<body>
<div class="meta">{title_esc} — {count_label} — {generated}</div>
{body}</body>
</html>
"#,
        title_esc = html_escape(title),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ProductionSearchResult {
        ProductionSearchResult {
            registry_guid: "68acf030".into(),
            detail_url: None,
            image_url: None,
            driver_name: "Jeff Gordon".into(),
            driver_normalized: "jeff gordon".into(),
            year: Some(2007),
            oem: Some("Action / Lionel".into()),
            brand: Some("Elite".into()),
            scale: Some("1:24".into()),
            make: Some("CWC".into()),
            scheme_text: Some("#24 1957 Chevy 2007 Chevy Monte Carlo".into()),
            seq_produced_total: Some(504),
            retail_value_cents: Some(5500),
            wholesale_value_cents: Some(1900),
        }
    }

    #[test]
    fn split_scheme_with_number() {
        assert_eq!(
            split_scheme(Some("#24 DuPont Monte Carlo")),
            (Some("24".into()), Some("DuPont Monte Carlo".into()))
        );
    }

    #[test]
    fn split_scheme_without_number() {
        assert_eq!(
            split_scheme(Some("Test Scheme")),
            (None, Some("Test Scheme".into()))
        );
        assert_eq!(split_scheme(None), (None, None));
        assert_eq!(split_scheme(Some("  ")), (None, None));
    }

    #[test]
    fn header_uses_number_and_scheme_only() {
        assert_eq!(
            header_line(&sample()),
            "#24 - 1957 Chevy 2007 Chevy Monte Carlo"
        );
    }

    #[test]
    fn header_strips_trailing_diecast_type() {
        let mut r = sample();
        r.scheme_text = Some("#22 AAA Insurance 2021 Ford Mustang - Diecast Chassis".into());
        assert_eq!(header_line(&r), "#22 - AAA Insurance 2021 Ford Mustang");
    }

    #[test]
    fn header_keeps_variant_qualifiers() {
        let mut r = sample();
        r.scheme_text = Some("#24 DuPont 1995 Chevy Monte Carlo - Signature Series".into());
        assert_eq!(
            header_line(&r),
            "#24 - DuPont 1995 Chevy Monte Carlo - Signature Series"
        );
        r.scheme_text =
            Some("#24 DuPont 1999 Chevy Monte Carlo - Test Car LTS 6/8 - Stock Car".into());
        assert_eq!(
            header_line(&r),
            "#24 - DuPont 1999 Chevy Monte Carlo - Test Car LTS 6/8"
        );
    }

    #[test]
    fn header_falls_back_to_driver_when_empty() {
        let mut r = sample();
        r.scheme_text = None;
        r.year = None;
        r.make = None;
        assert_eq!(header_line(&r), "Jeff Gordon");
    }

    #[test]
    fn subheader_full_and_with_gaps() {
        assert_eq!(
            subheader_line(&sample(), Some("Color Chrome")),
            "Action / Lionel - Elite - 1:24 - Color Chrome - production qty 504 - Retail Value $55.00"
        );
        let mut r = sample();
        r.brand = None;
        r.retail_value_cents = None;
        assert_eq!(
            subheader_line(&r, None),
            "Action / Lionel - 1:24 - production qty 504"
        );
    }

    #[test]
    fn subheader_empty_when_nothing_known() {
        let mut r = sample();
        r.oem = None;
        r.brand = None;
        r.scale = None;
        r.seq_produced_total = None;
        r.retail_value_cents = None;
        assert_eq!(subheader_line(&r, None), "");
        let doc = build_document(
            "Registry search export",
            "result",
            &[EntryHtml {
                header: "#24 - DuPont".into(),
                ..Default::default()
            }],
        );
        assert!(!doc.contains("class=\"sub\""));
        assert!(!doc.contains("class=\"notes\""));
        assert!(!doc.contains("class=\"cands\""));
    }

    #[test]
    fn money_and_thousands_formatting() {
        assert_eq!(format_dollars(5500), "$55.00");
        assert_eq!(format_dollars(123456789), "$1,234,567.89");
        assert_eq!(format_thousands(2508), "2,508");
        assert_eq!(format_thousands(504), "504");
    }

    /// Network smoke test: downloads a real DCR image, embeds it, and writes
    /// a full document to the temp dir. Run with
    /// `cargo test smoke_export -- --ignored`.
    ///
    /// Deliberately exercises `fetch_image_data_uri` + `build_document`
    /// directly instead of `export_registry_results`: the latter takes a
    /// `ProgressEmitter`, and linking tauri's emit path into the test binary
    /// drags in `comctl32!TaskDialogIndirect` (via rfd), which needs the
    /// comctl32-v6 manifest that only the real app exe gets — the whole test
    /// binary then dies at load with STATUS_ENTRYPOINT_NOT_FOUND.
    #[tokio::test]
    #[ignore = "hits diecastregistry.com"]
    async fn smoke_export_writes_file() {
        let r = sample();
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .unwrap();
        let uri = fetch_image_data_uri(
            &client,
            "/Uploads/Collectibles/2004-Jeff-Gordon-NASCAR-Diecast-24-Racing-Stripes-Zebra-CWC-124-Action-ARC-1.jpg",
        )
        .await
        .unwrap();
        assert!(uri.starts_with("data:image/jpeg;base64,"));
        let doc = build_document(
            "Registry search export",
            "result",
            &[EntryHtml {
                header: header_line(&r),
                subheader: subheader_line(&r, None),
                image_data_uri: Some(uri),
                ..Default::default()
            }],
        );
        let path = std::env::temp_dir().join("diecast-hunter-export-smoke.html");
        tokio::fs::write(&path, &doc).await.unwrap();
        assert!(doc.contains("data:image/jpeg;base64,"));
        assert!(doc.contains("#24 - 1957 Chevy 2007 Chevy Monte Carlo"));
    }

    #[test]
    fn document_escapes_and_embeds() {
        let doc = build_document(
            "Registry search export",
            "result",
            &[EntryHtml {
                header: "#3 - <Goodwrench> & Co".into(),
                subheader: "Action - 1:24 - production qty 504 - Retail Value $55.00".into(),
                image_data_uri: Some("data:image/jpeg;base64,abc".into()),
                ..Default::default()
            }],
        );
        assert!(doc.contains("#3 - &lt;Goodwrench&gt; &amp; Co"));
        assert!(doc.contains("data:image/jpeg;base64,abc"));
        assert!(doc.contains("1 result —"));
    }

    fn sample_wish() -> WishlistEntry {
        WishlistEntry {
            entry_id: 1,
            wishlist_id: 1,
            registry_entry_id: 10,
            registry_guid: "68acf030".into(),
            driver_name: Some("Jeff Gordon".into()),
            year: Some(2007),
            oem: Some("Action / Lionel".into()),
            brand: Some("Elite".into()),
            scale: Some("1:24".into()),
            make: Some("CWC".into()),
            scheme_text: Some("#24 DuPont Monte Carlo - Stock Car".into()),
            production_qty: Some(504),
            retail_value_cents: Some(5500),
            wholesale_value_cents: Some(1900),
            image_url: None,
            detail_url: None,
            notes: Some("max $60, chrome only".into()),
            added_at: 0,
            sort_rank: 0,
            listings: vec![crate::wishlist::WishlistListing {
                listing_id: 7,
                seller_code: "ebay".into(),
                title: "Jeff Gordon 1:24 DuPont <NIB>".into(),
                url: "https://ebay.com/itm/1".into(),
                price_cents: Some(4999),
                shipping_cents: Some(501),
                currency: "USD".into(),
                status: "active".into(),
                end_time: None,
                image_url: None,
                linked_at: 0,
            }],
        }
    }

    #[test]
    fn wishlist_header_and_subheader() {
        let w = sample_wish();
        assert_eq!(wishlist_header_line(&w), "#24 - DuPont Monte Carlo");
        assert_eq!(
            wishlist_subheader_line(&w),
            "Jeff Gordon - 2007 - Action / Lionel - Elite - 1:24 - production qty 504 - Retail Value $55.00"
        );
        let mut bare = sample_wish();
        bare.scheme_text = None;
        assert_eq!(wishlist_header_line(&bare), "Jeff Gordon");
        bare.driver_name = None;
        assert_eq!(wishlist_header_line(&bare), "(unknown)");
    }

    fn sample_collection_row() -> CollectionRow {
        CollectionRow {
            collection_id: 1,
            asset_guid: "abc123".into(),
            driver_id: Some(4),
            driver_name: Some("Jeff Gordon".into()),
            year: Some(2004),
            year_raced: None,
            car_number: Some("24".into()),
            diecast_type: Some("Stock Car".into()),
            registration_number: Some("R-1".into()),
            oem: Some("Action".into()),
            brand: Some("ARC".into()),
            scale: Some("1:24".into()),
            make: Some("CWC".into()),
            finish: Some("Standard".into()),
            production_qty: Some(2508),
            scheme_text: Some("#24 DuPont Monte Carlo - Stock Car".into()),
            image_url: None,
            detail_url: Some("/NASCAR/jeff-gordon/dupont".into()),
            retail_value_cents: Some(5500),
            wholesale_value_cents: Some(1900),
            registry_int_id: Some(99),
            enriched: true,
        }
    }

    #[test]
    fn collection_header_and_subheader() {
        let r = sample_collection_row();
        assert_eq!(collection_header_line(&r), "#24 - DuPont Monte Carlo");
        assert_eq!(
            collection_subheader_line(&r),
            "Jeff Gordon - 2004 - Action - ARC - 1:24 - Standard - production qty 2,508 - Retail Value $55.00"
        );

        // No "#" in scheme text — number comes from the discrete car_number.
        let mut r2 = sample_collection_row();
        r2.scheme_text = Some("DuPont Monte Carlo".into());
        assert_eq!(collection_header_line(&r2), "#24 - DuPont Monte Carlo");

        // Bare stub row falls back to the driver name.
        let mut bare = sample_collection_row();
        bare.scheme_text = None;
        bare.car_number = None;
        assert_eq!(collection_header_line(&bare), "Jeff Gordon");
        bare.driver_name = None;
        assert_eq!(collection_header_line(&bare), "(unknown)");
    }

    #[test]
    fn collection_csv_escapes_and_formats() {
        let mut r = sample_collection_row();
        r.scheme_text = Some("DuPont \"Flames\" Monte, Carlo".into());
        let csv = build_collection_csv(&[r]);
        let mut lines = csv.trim_start_matches('\u{feff}').lines();
        assert!(lines.next().unwrap().starts_with("Driver,Year,Car Number,"));
        let row = lines.next().unwrap();
        assert!(row.contains("\"DuPont \"\"Flames\"\" Monte, Carlo\""));
        assert!(row.contains("55.00"));
        assert!(row.contains("19.00"));
        assert!(row.contains("https://www.diecastregistry.com/NASCAR/jeff-gordon/dupont"));
        assert!(lines.next().is_none());

        // Empty optionals become empty fields, not "null".
        let mut bare = sample_collection_row();
        bare.retail_value_cents = None;
        bare.detail_url = None;
        let csv = build_collection_csv(&[bare]);
        assert!(!csv.contains("null"));
    }

    #[test]
    fn wishlist_document_has_notes_and_candidates() {
        let w = sample_wish();
        assert_eq!(
            candidate_line(&w.listings[0]),
            "Jeff Gordon 1:24 DuPont <NIB> — $55.00 (ebay, active)"
        );
        let doc = build_document(
            "Wishlist",
            "entry",
            &[EntryHtml {
                header: wishlist_header_line(&w),
                subheader: wishlist_subheader_line(&w),
                image_data_uri: None,
                notes: w.notes.clone(),
                candidates: w.listings.iter().map(candidate_line).collect(),
            }],
        );
        assert!(doc.contains("1 entry —"));
        assert!(doc.contains("max $60, chrome only"));
        assert!(doc.contains("Jeff Gordon 1:24 DuPont &lt;NIB&gt; — $55.00 (ebay, active)"));
        let two = build_document(
            "Wishlist",
            "entry",
            &[EntryHtml::default(), EntryHtml::default()],
        );
        assert!(two.contains("2 entries —"));
    }
}
