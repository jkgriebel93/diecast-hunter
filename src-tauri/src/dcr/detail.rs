use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;
use scraper::{Html, Selector};

use crate::dcr::parse::{dollars_to_cents, normalize_driver_name};
use crate::error::{AppError, AppResult};

#[derive(Debug, Default, Clone)]
pub struct RegistryDetail {
    pub external_id: Option<String>,
    pub registry_int_id: Option<i64>,
    pub registration_number: Option<String>,
    pub driver_name: Option<String>,
    pub driver_normalized: Option<String>,
    pub scheme_text: Option<String>,
    pub year_released: Option<i32>,
    pub year_raced: Option<i32>,
    pub car_number: Option<String>,
    pub diecast_type: Option<String>,
    pub scale: Option<String>,
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub make: Option<String>,
    pub finish: Option<String>,
    pub production_qty: Option<i64>,
    pub retail_value_cents: Option<i64>,
    pub wholesale_value_cents: Option<i64>,
    pub comments: Option<String>,
    pub photos: Vec<String>,
}

pub fn parse_detail_page(html: &str) -> AppResult<RegistryDetail> {
    let doc = Html::parse_document(html);
    let mut out = RegistryDetail::default();

    // External GUID lives in the "Add to My Garage" button href.
    let add_garage_sel = Selector::parse("a.btn-add-mygarage").unwrap();
    if let Some(a) = doc.select(&add_garage_sel).next() {
        if let Some(href) = a.value().attr("href") {
            out.external_id = registry_guid_from_register_url(href);
        }
    }

    // Registration number, e.g. "000-427-374".
    let reg_sel = Selector::parse("div.registration span").unwrap();
    if let Some(span) = doc.select(&reg_sel).next() {
        let s = compact_text(&span);
        if !s.is_empty() {
            out.registration_number = Some(s.clone());
            out.registry_int_id = digits_only(&s).parse().ok();
        }
    }

    // The "diecast-driver" <p> reads "Jeff Gordon\u{a0}#24 Pepsi Daytona ...".
    // Split on the non-breaking space to isolate driver from scheme.
    let header_sel = Selector::parse("p.diecast-driver").unwrap();
    if let Some(p) = doc.select(&header_sel).next() {
        let raw = p.text().collect::<String>();
        let trimmed = raw.trim();
        if let Some((driver, scheme)) = trimmed.split_once('\u{00A0}') {
            let d = collapse_ws(driver);
            if !d.is_empty() {
                out.driver_normalized = Some(normalize_driver_name(&d));
                out.driver_name = Some(d);
            }
            let s = collapse_ws(scheme);
            if !s.is_empty() {
                out.scheme_text = Some(s);
            }
        } else {
            // Fallback: no nbsp present (shouldn't happen, but be defensive).
            let s = collapse_ws(trimmed);
            if !s.is_empty() {
                out.driver_normalized = Some(normalize_driver_name(&s));
                out.driver_name = Some(s);
            }
        }
    }

    // Market values — the .value-group blocks pair a $ value with a label.
    let mv_sel = Selector::parse("div.market-values div.value-group").unwrap();
    let value_sel = Selector::parse("div.value span").unwrap();
    let label_sel = Selector::parse("label.control-label").unwrap();
    for group in doc.select(&mv_sel) {
        let value = group.select(&value_sel).next().map(|n| compact_text(&n));
        let label = group.select(&label_sel).next().map(|n| compact_text(&n));
        if let (Some(v), Some(l)) = (value, label) {
            let cents = dollars_to_cents(&v);
            let l_lower = l.to_lowercase();
            if l_lower.contains("retail") {
                out.retail_value_cents = cents;
            } else if l_lower.contains("wholesale") {
                out.wholesale_value_cents = cents;
            }
        }
    }

    // Quick Facts — each .row-group has a .value div and a <label for="...">
    // identifying the field. The `for` attribute is the stable key.
    let row_sel = Selector::parse("div.quick-facts div.row-group").unwrap();
    let mut facts: HashMap<String, String> = HashMap::new();
    for row in doc.select(&row_sel) {
        let key = row
            .select(&label_sel)
            .next()
            .and_then(|l| l.value().attr("for").map(str::to_owned));
        let v_sel = Selector::parse("div.value").unwrap();
        let value = row.select(&v_sel).next().map(|n| compact_text(&n));
        if let (Some(k), Some(v)) = (key, value) {
            if !v.is_empty() {
                facts.insert(k, v);
            }
        }
    }
    out.diecast_type = facts.remove("DiecastType_DiecastTypeName");
    out.car_number = facts.remove("Number");
    out.year_released = facts
        .remove("DiecastYear_YearNumber")
        .and_then(|s| s.parse().ok());
    out.year_raced = facts.remove("YearRaced").and_then(|s| s.parse().ok());
    out.scale = facts.remove("Scale_ScaleName");
    out.oem = facts.remove("DiecastOem_OemName");
    out.brand = facts.remove("DiecastBrand_BrandName");
    out.make = facts.remove("DiecastMake_MakeName");
    out.finish = facts.remove("Finish_FinishName");
    out.production_qty = facts
        .remove("ProductionQuantity")
        .and_then(|s| digits_only(&s).parse().ok());

    // Free-text race comments.
    let comments_sel = Selector::parse("div.comments").unwrap();
    if let Some(div) = doc.select(&comments_sel).next() {
        let s = collapse_ws(&div.text().collect::<String>());
        if !s.is_empty() {
            out.comments = Some(s);
        }
    }

    // Photos — from the lightbox gallery.
    let photo_sel = Selector::parse("div.lightbox-gallery a.fancybox").unwrap();
    for a in doc.select(&photo_sel) {
        if let Some(href) = a.value().attr("href") {
            out.photos.push(href.to_string());
        }
    }

    // Sanity: a usable detail page must at least give us an external_id OR
    // enough data to be worth caching. Refuse to return a blank shell.
    if out.external_id.is_none() && out.diecast_type.is_none() && out.oem.is_none() {
        return Err(AppError::Parse(
            "detail page yielded no recognizable fields".into(),
        ));
    }

    Ok(out)
}

fn compact_text(el: &scraper::ElementRef) -> String {
    collapse_ws(&el.text().collect::<String>())
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn digits_only(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

static REGISTER_GUID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"/MyGarage/RegisterDiecast/(?P<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    )
    .unwrap()
});

pub fn registry_guid_from_register_url(href: &str) -> Option<String> {
    REGISTER_GUID_RE
        .captures(href)?
        .name("id")
        .map(|m| m.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixtures/dcr/registry_detail.html");

    #[test]
    fn parses_full_detail() {
        let d = parse_detail_page(FIXTURE).unwrap();
        assert_eq!(
            d.external_id.as_deref(),
            Some("6f961f98-f59e-4c14-b7a3-5573807d9866")
        );
        assert_eq!(d.registration_number.as_deref(), Some("000-427-374"));
        assert_eq!(d.registry_int_id, Some(427374));
        assert_eq!(d.driver_name.as_deref(), Some("Jeff Gordon"));
        assert_eq!(d.driver_normalized.as_deref(), Some("jeff-gordon"));
        assert_eq!(
            d.scheme_text.as_deref(),
            Some("#24 Pepsi Daytona 2002 Chevy Monte Carlo")
        );
        assert_eq!(d.year_released, Some(2002));
        assert_eq!(d.year_raced, Some(2002));
        assert_eq!(d.car_number.as_deref(), Some("24"));
        assert_eq!(d.diecast_type.as_deref(), Some("Stock Car"));
        assert_eq!(d.scale.as_deref(), Some("1:24"));
        assert_eq!(d.oem.as_deref(), Some("Action / Lionel"));
        assert_eq!(d.brand.as_deref(), Some("ARC"));
        assert_eq!(d.make.as_deref(), Some("CWC"));
        assert_eq!(d.finish.as_deref(), Some("(Standard)"));
        assert_eq!(d.production_qty, Some(37836));
        assert_eq!(d.retail_value_cents, Some(8800));
        assert_eq!(d.wholesale_value_cents, Some(2700));
        assert_eq!(d.photos.len(), 2);
        assert!(d.comments.as_deref().unwrap().contains("Pepsi 400"));
    }

    #[test]
    fn rejects_blank_page() {
        let res = parse_detail_page("<html><body></body></html>");
        assert!(res.is_err());
    }

    #[test]
    fn register_guid_extraction() {
        assert_eq!(
            registry_guid_from_register_url(
                "/MyGarage/RegisterDiecast/6f961f98-f59e-4c14-b7a3-5573807d9866"
            )
            .as_deref(),
            Some("6f961f98-f59e-4c14-b7a3-5573807d9866")
        );
    }
}
