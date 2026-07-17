//! Structured search against diecastregistry.com's /Production listing.
//!
//! Two-step flow on the server:
//!   1. POST /Production/UpdateFilter with form-encoded selections + the page's
//!      __RequestVerificationToken. The server saves filter state in the user
//!      session and replies `{"redirect": true, "url": "/Production"}`.
//!   2. GET /Production renders the filtered, paginated results.
//!
//! Each result is a `<div class="svm-diecast-li">` block with structure very
//! similar to the My Garage page (M2), differing only in the absence of the
//! per-user `id="asset…"` wrapper and the detail URL ending in a GUID rather
//! than an integer id.

use once_cell::sync::Lazy;
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};

use crate::dcr::client::extract_form_token;
use crate::dcr::parse::{
    dollars_to_cents, normalize_driver_name, parse_details_line, parse_seq_produced,
    registry_guid_from_feedback_url, SeqProduced,
};
use crate::dcr::DcrClient;
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ProductionSearchFilter {
    /// "All Diecast" / "Stock Car" / "Stock Truck" / etc. Defaults to "All Diecast".
    #[serde(default)]
    pub diecast_type: Option<String>,
    #[serde(default)]
    pub driver_guids: Vec<String>,
    /// "raced" or "released". Defaults to "raced".
    #[serde(default)]
    pub year_opt: Option<String>,
    #[serde(default)]
    pub years: Vec<String>,
    #[serde(default)]
    pub oem_guids: Vec<String>,
    #[serde(default)]
    pub brand_guids: Vec<String>,
    #[serde(default)]
    pub make_guids: Vec<String>,
    #[serde(default)]
    pub scale_guids: Vec<String>,
    #[serde(default)]
    pub finish_guids: Vec<String>,
    #[serde(default)]
    pub autographed: bool,
    #[serde(default)]
    pub raced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductionSearchResult {
    pub registry_guid: String,
    pub detail_url: Option<String>,
    pub image_url: Option<String>,
    pub driver_name: String,
    pub driver_normalized: String,
    pub year: Option<i32>,
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub scale: Option<String>,
    pub make: Option<String>,
    pub scheme_text: Option<String>,
    pub seq_produced_total: Option<i64>,
    pub retail_value_cents: Option<i64>,
    pub wholesale_value_cents: Option<i64>,
}

#[derive(Deserialize)]
struct UpdateFilterResponse {
    #[serde(default)]
    redirect: bool,
    #[serde(default)]
    url: String,
}

/// Run a /Production search, walking every page of results (capped at 200
/// pages as a safety net) and emitting per-page progress events via the
/// supplied emitter. `subject` is interpolated into progress labels — pass
/// `Some("Jeff Gordon")` for driver-scoped searches, `None` for generic
/// searches.
pub async fn search_all_pages_with_progress(
    client: &DcrClient,
    filter: &ProductionSearchFilter,
    progress: &ProgressEmitter,
    subject: Option<&str>,
) -> AppResult<(Vec<ProductionSearchResult>, u32)> {
    progress.check_cancelled()?;
    progress.step("Applying filter…", None, None);

    // 1. GET /Production for the form anti-forgery token.
    let initial = client.get_html("/Production").await?;
    let token = extract_form_token(&initial).ok_or_else(|| {
        AppError::Parse("could not find anti-forgery token on /Production".into())
    })?;

    // 2. POST /Production/UpdateFilter — sets server-side filter state.
    let form = build_form(&token, filter);
    let body = client
        .post_form("/Production/UpdateFilter", &form)
        .await?;

    // 3. Follow the JSON redirect envelope, or refetch /Production directly.
    let first_page_html = match serde_json::from_str::<UpdateFilterResponse>(&body) {
        Ok(envelope) if envelope.redirect && !envelope.url.is_empty() => {
            client.get_html(&envelope.url).await?
        }
        _ => client.get_html("/Production").await?,
    };

    // scraper::Html isn't Send; scope the doc to a block so it drops before
    // the .await calls below.
    let (current, total) = {
        let first_doc = scraper::Html::parse_document(&first_page_html);
        crate::dcr::parse::parse_pagination(&first_doc)
    };

    let suffix = subject
        .map(|s| format!(" for {s}"))
        .unwrap_or_default();
    progress.step(
        format!("Fetching page 1 of {total}{suffix}…"),
        Some(1),
        Some(total),
    );

    let mut all_results = parse_results(&first_page_html);
    let mut pages_fetched = 1u32;

    let stop_at = total.min(200);
    for page in (current + 1)..=stop_at {
        progress.check_cancelled()?;
        progress.step(
            format!("Fetching page {page} of {total}{suffix}…"),
            Some(page),
            Some(total),
        );
        let html = client.get_html(&format!("/Production/{page}")).await?;
        let mut more = parse_results(&html);
        all_results.append(&mut more);
        pages_fetched += 1;
    }

    Ok((all_results, pages_fetched))
}

pub(crate) fn build_form(token: &str, f: &ProductionSearchFilter) -> Vec<(String, String)> {
    let mut form = Vec::new();
    form.push(("__RequestVerificationToken".into(), token.to_string()));
    form.push(("ForSale".into(), String::new()));
    form.push((
        "load".into(),
        f.diecast_type
            .clone()
            .unwrap_or_else(|| "All Diecast".into()),
    ));
    form.push(("TypesExpanded".into(), "False".into()));
    for d in &f.driver_guids {
        form.push(("Drivers".into(), d.clone()));
    }
    form.push(("IsDriverExclusive".into(), "False".into()));
    form.push((
        "yearOpt".into(),
        f.year_opt.clone().unwrap_or_else(|| "raced".into()),
    ));
    for y in &f.years {
        form.push(("Years".into(), y.clone()));
    }
    for v in &f.oem_guids {
        form.push(("DiecastOems".into(), v.clone()));
    }
    for v in &f.brand_guids {
        form.push(("DiecastBrands".into(), v.clone()));
    }
    for v in &f.make_guids {
        form.push(("DiecastMakes".into(), v.clone()));
    }
    for v in &f.scale_guids {
        form.push(("Scales".into(), v.clone()));
    }
    for v in &f.finish_guids {
        form.push(("Finishes".into(), v.clone()));
    }
    form.push((
        "Autographed".into(),
        if f.autographed { "true" } else { "false" }.into(),
    ));
    form.push((
        "Raced".into(),
        if f.raced { "true" } else { "false" }.into(),
    ));
    form.push(("dnp".into(), "False".into()));
    form.push(("preorder".into(), "False".into()));
    form.push(("expanded".into(), "False".into()));
    form.push(("filterPrefix".into(), String::new()));
    form.push(("sort".into(), "1".into()));
    form.push(("v".into(), "l".into()));
    form
}

static DETAIL_URL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^/diecast/[^/]+/[^/]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    )
    .unwrap()
});

pub(crate) fn parse_results(html: &str) -> Vec<ProductionSearchResult> {
    let doc = Html::parse_document(html);
    let item_sel = Selector::parse("div.svm-diecast-li").unwrap();
    let mut out = Vec::new();
    for el in doc.select(&item_sel) {
        match parse_one(el) {
            Some(r) => out.push(r),
            None => tracing::debug!("skipping malformed production search result"),
        }
    }
    out
}

fn parse_one(el: ElementRef) -> Option<ProductionSearchResult> {
    // Detail URL: prefer the "additional information" link (the one with
    // class "fa-info-circle"), otherwise the first /diecast/... link.
    let a_sel = Selector::parse("a[href]").unwrap();
    let detail_url = el
        .select(&a_sel)
        .filter_map(|a| a.value().attr("href"))
        .find(|h| DETAIL_URL_RE.is_match(h))
        .map(str::to_string);

    // Registry GUID: prefer the feedback link (stable extractor we wrote in M2).
    let feedback_sel = Selector::parse("a.diecast-value-feedback").unwrap();
    let registry_guid = el
        .select(&feedback_sel)
        .next()
        .and_then(|a| a.value().attr("href"))
        .and_then(registry_guid_from_feedback_url)
        .or_else(|| {
            // Fallback: pull the trailing GUID off the detail URL.
            detail_url.as_deref().and_then(|u| {
                u.rsplit('/')
                    .next()
                    .filter(|s| s.len() == 36)
                    .map(str::to_string)
            })
        })?;

    // Driver name.
    let driver_sel = Selector::parse("div.diecast-driver").unwrap();
    let driver_name = el
        .select(&driver_sel)
        .next()
        .map(|n| compact(n.text().collect::<String>().as_str()))
        .filter(|s| !s.is_empty())?;
    let driver_normalized = normalize_driver_name(&driver_name);

    // .diecast-details holds the year/OEM/brand/scale/make line as a direct
    // text node (mixed with anchors and labels). Extract direct-text only.
    let details_sel = Selector::parse("div.diecast-details").unwrap();
    let details_div = el.select(&details_sel).next();
    let mut year = None;
    let mut oem = None;
    let mut brand = None;
    let mut scale = None;
    let mut make = None;
    let mut scheme_text: Option<String> = None;
    let mut seq_produced = SeqProduced::default();
    if let Some(d) = details_div {
        let raw_line = direct_text_only(d);
        if let Some(parsed) = parse_details_line(&raw_line) {
            year = Some(parsed.year);
            oem = Some(parsed.oem);
            brand = parsed.brand;
            scale = Some(parsed.scale);
            make = Some(parsed.make);
        }
        // Scheme is in the anchor's direct text; <span class="seq-produced">
        // sits inside the same anchor with the production count.
        let inner_a_sel = Selector::parse("a").unwrap();
        if let Some(a) = d.select(&inner_a_sel).next() {
            let mut buf = String::new();
            for node in a.children() {
                if let Some(t) = node.value().as_text() {
                    buf.push_str(t);
                }
            }
            let s = compact(&buf);
            if !s.is_empty() {
                scheme_text = Some(s);
            }
            let seq_sel = Selector::parse("span.seq-produced").unwrap();
            if let Some(seq) = a.select(&seq_sel).next() {
                seq_produced = parse_seq_produced(&seq.text().collect::<String>());
            }
        }
    }

    let img_sel = Selector::parse("img.img-thumbnail").unwrap();
    let image_url = el
        .select(&img_sel)
        .next()
        .and_then(|n| n.value().attr("src"))
        .map(str::to_string);

    let value_span_sel = |class: &str| -> Selector {
        Selector::parse(&format!("div.{class} span")).unwrap()
    };
    let retail_value_cents = el
        .select(&value_span_sel("retail-value"))
        .next()
        .and_then(|n| dollars_to_cents(&n.text().collect::<String>()));
    let wholesale_value_cents = el
        .select(&value_span_sel("wholesale-value"))
        .next()
        .and_then(|n| dollars_to_cents(&n.text().collect::<String>()));

    Some(ProductionSearchResult {
        registry_guid,
        detail_url,
        image_url,
        driver_name,
        driver_normalized,
        year,
        oem,
        brand,
        scale,
        make,
        scheme_text,
        seq_produced_total: seq_produced.total,
        retail_value_cents,
        wholesale_value_cents,
    })
}

fn compact(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Returns just the direct text-node children of `el`, joined and trimmed.
/// Preserves runs of whitespace so the details-line parser can still see a
/// double space when brand is empty.
fn direct_text_only(el: ElementRef) -> String {
    let mut buf = String::new();
    for node in el.children() {
        if let Some(t) = node.value().as_text() {
            buf.push_str(t);
        }
    }
    buf.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str =
        include_str!("../../fixtures/dcr/production_search_one_result.html");

    #[test]
    fn parses_a_result_block() {
        let results = parse_results(FIXTURE);
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert_eq!(r.registry_guid, "68acf030-a051-4e24-907f-abf2475e5315");
        assert_eq!(
            r.detail_url.as_deref(),
            Some(
                "/diecast/jeff-gordon/action-lionel-elite-24-1957-chevy-2007-chevy-monte-carlo-stock-car/68acf030-a051-4e24-907f-abf2475e5315"
            )
        );
        assert_eq!(r.driver_name, "Jeff Gordon");
        assert_eq!(r.driver_normalized, "jeff-gordon");
        assert_eq!(r.year, Some(2007));
        assert_eq!(r.oem.as_deref(), Some("Action / Lionel"));
        assert_eq!(r.brand.as_deref(), Some("Elite"));
        assert_eq!(r.scale.as_deref(), Some("1:24"));
        assert_eq!(r.make.as_deref(), Some("CWC"));
        assert_eq!(
            r.scheme_text.as_deref(),
            Some("#24 1957 Chevy 2007 Chevy Monte Carlo")
        );
        assert_eq!(r.seq_produced_total, Some(504));
        assert_eq!(r.retail_value_cents, Some(5500));
        assert_eq!(r.wholesale_value_cents, Some(1900));
    }
}
