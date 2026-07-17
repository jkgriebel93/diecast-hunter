//! Registry-search HTML export.
//!
//! Turns a set of `ProductionSearchResult`s (whatever the Registry page is
//! currently displaying, post-filter/post-sort) into a self-contained,
//! print-friendly HTML document. Images are downloaded from DCR and embedded
//! as base64 data URIs so the file works offline; a download failure degrades
//! to a "image unavailable" placeholder rather than failing the export.
//!
//! Search results don't carry discrete car-number / sponsor / finish fields:
//! the car number is parsed off the front of `scheme_text` ("#24 DuPont …"),
//! the remainder of the scheme text stands in for the sponsor, and the finish
//! comes from the caller (the UI passes the selected finish filter, if any).

use base64::Engine;
use serde::Serialize;

use crate::dcr::ProductionSearchResult;
use crate::error::AppResult;
use crate::progress::ProgressEmitter;

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
        });
    }

    progress.step("Writing file…", Some(total), Some(total));
    let doc = build_document(&entries);
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

struct EntryHtml {
    header: String,
    subheader: String,
    image_data_uri: Option<String>,
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
        if DIECAST_TYPES
            .iter()
            .any(|t| t.eq_ignore_ascii_case(last))
        {
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
            return (
                Some(number.to_string()),
                remainder.map(str::to_string),
            );
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
    format!("${}.{:02}", format_thousands(cents / 100), (cents % 100).abs())
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
/// sans-serif subheaders, one full-size image per entry.
fn build_document(entries: &[EntryHtml]) -> String {
    let generated = chrono::Local::now().format("%B %-d, %Y %-I:%M %p");
    let count = entries.len();
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
        match &e.image_data_uri {
            Some(uri) => body.push_str(&format!("<img src=\"{uri}\" alt=\"\">\n")),
            None => body.push_str("<div class=\"noimg\">image unavailable</div>\n"),
        }
        body.push_str("</section>\n");
    }
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Registry search export</title>
<style>
  body {{ background: #fff; color: #1c1c1a; font-family: Georgia, 'Times New Roman', serif;
         max-width: 800px; margin: 0 auto; padding: 32px 24px; }}
  .meta {{ font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #8a877e;
           border-bottom: 2px solid #1c1c1a; padding-bottom: 8px; margin-bottom: 28px; }}
  .entry {{ margin-bottom: 40px; page-break-inside: avoid; }}
  .entry h2 {{ font-size: 22px; font-weight: 600; margin: 0 0 4px; }}
  .entry .sub {{ font-family: Arial, Helvetica, sans-serif; font-size: 14px;
                 color: #5f5c54; margin-bottom: 12px; }}
  .entry img {{ max-width: 100%; height: auto; display: block;
                border: 1px solid #d9d5cc; }}
  .noimg {{ font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #8a877e;
            border: 1px dashed #d9d5cc; padding: 40px; text-align: center; }}
</style>
</head>
<body>
<div class="meta">Registry search export — {count} result{plural} — {generated}</div>
{body}</body>
</html>
"#,
        plural = if count == 1 { "" } else { "s" },
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
        r.scheme_text =
            Some("#22 AAA Insurance 2021 Ford Mustang - Diecast Chassis".into());
        assert_eq!(header_line(&r), "#22 - AAA Insurance 2021 Ford Mustang");
    }

    #[test]
    fn header_keeps_variant_qualifiers() {
        let mut r = sample();
        r.scheme_text =
            Some("#24 DuPont 1995 Chevy Monte Carlo - Signature Series".into());
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
        let doc = build_document(&[EntryHtml {
            header: "#24 - DuPont".into(),
            subheader: String::new(),
            image_data_uri: None,
        }]);
        assert!(!doc.contains("class=\"sub\""));
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
        let doc = build_document(&[EntryHtml {
            header: header_line(&r),
            subheader: subheader_line(&r, None),
            image_data_uri: Some(uri),
        }]);
        let path = std::env::temp_dir().join("diecast-hunter-export-smoke.html");
        tokio::fs::write(&path, &doc).await.unwrap();
        assert!(doc.contains("data:image/jpeg;base64,"));
        assert!(doc.contains("#24 - 1957 Chevy 2007 Chevy Monte Carlo"));
    }

    #[test]
    fn document_escapes_and_embeds() {
        let doc = build_document(&[EntryHtml {
            header: "#3 - <Goodwrench> & Co".into(),
            subheader: "Action - 1:24 - production qty 504 - Retail Value $55.00".into(),
            image_data_uri: Some("data:image/jpeg;base64,abc".into()),
        }]);
        assert!(doc.contains("#3 - &lt;Goodwrench&gt; &amp; Co"));
        assert!(doc.contains("data:image/jpeg;base64,abc"));
        assert!(doc.contains("1 result —"));
    }
}
