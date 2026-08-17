//! Parses diecastregistry.com's /Production filter form to extract every
//! dropdown choice (drivers, OEMs, brands, makes, scales, finishes, years,
//! diecast types) and persists them to the `registry_form_options` table.
//!
//! The dialog in the desktop app uses these to populate dropdowns for the
//! structured registry search — the site doesn't expose a free-text search
//! endpoint, so the user picks GUIDs from these choices.

use chrono::Utc;
use scraper::{Html, Selector};
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::client::looks_like_login_page;
use crate::dcr::parse::normalize_driver_name;
use crate::dcr::DcrClient;
use crate::error::{AppError, AppResult};

/// Logical name → form field name on the page. The DB stores logical names.
const FIELD_MAP: &[(&str, &str)] = &[
    ("driver", "Drivers"),
    ("scale", "Scales"),
    ("year", "Years"),
    ("oem", "DiecastOems"),
    ("brand", "DiecastBrands"),
    ("make", "DiecastMakes"),
    ("finish", "Finishes"),
];

#[derive(Debug, Default, Serialize, Clone)]
pub struct RefreshOptionsSummary {
    pub fields_seen: u32,
    pub options_upserted: u32,
}

#[derive(Debug, Clone)]
struct ParsedOption {
    field: &'static str,
    value: String,
    display: String,
}

pub async fn refresh_form_options(
    pool: &SqlitePool,
    client: &DcrClient,
) -> AppResult<RefreshOptionsSummary> {
    let html = client.get_html("/Production").await?;
    // On a cached session with a dead cookie this fetch is the login form,
    // which parses as zero options; surface the expiry instead of silently
    // "refreshing" nothing (DCH-57).
    if looks_like_login_page(&html) {
        return Err(AppError::SessionExpired);
    }
    let parsed = parse_form_options(&html);
    let mut summary = RefreshOptionsSummary::default();
    let now = Utc::now().timestamp();

    let mut seen_fields = std::collections::HashSet::new();
    for opt in &parsed {
        seen_fields.insert(opt.field);
        let display = opt.display.trim();
        if display.is_empty() {
            continue;
        }
        sqlx::query(
            "INSERT INTO registry_form_options (field, value, display, normalized, fetched_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(field, value) DO UPDATE SET
                display = excluded.display,
                normalized = excluded.normalized,
                fetched_at = excluded.fetched_at",
        )
        .bind(opt.field)
        .bind(&opt.value)
        .bind(display)
        .bind(normalize_driver_name(display))
        .bind(now)
        .execute(pool)
        .await?;
        summary.options_upserted += 1;
    }
    summary.fields_seen = seen_fields.len() as u32;

    crate::settings::set(
        pool,
        crate::settings::KEY_FORM_OPTIONS_REFRESHED,
        &now.to_string(),
    )
    .await?;
    Ok(summary)
}

/// Pure parser — split out for testability. Walks every `<select name="X">`
/// listed in FIELD_MAP and the `<input name="load">` radios for diecast type.
fn parse_form_options(html: &str) -> Vec<ParsedOption> {
    let doc = Html::parse_document(html);
    let mut out = Vec::new();

    for (logical, form_name) in FIELD_MAP {
        let sel_str = format!(r#"select[name="{form_name}"] option"#);
        let sel = match Selector::parse(&sel_str) {
            Ok(s) => s,
            Err(_) => continue,
        };
        for opt in doc.select(&sel) {
            let value = opt
                .value()
                .attr("value")
                .map(str::to_string)
                .unwrap_or_default();
            let display = opt.text().collect::<String>();
            let display = display.trim().to_string();
            if value.is_empty() && display.is_empty() {
                continue;
            }
            out.push(ParsedOption {
                field: logical,
                value,
                display,
            });
        }
    }

    // Diecast type radios — value attribute is the human label that the form
    // POSTs (e.g. "Stock Car", "All Diecast"). Treat value === display.
    let radio_sel = Selector::parse(r#"input[type="radio"][name="load"]"#).unwrap();
    for radio in doc.select(&radio_sel) {
        let v = radio
            .value()
            .attr("value")
            .map(str::to_string)
            .unwrap_or_default();
        if v.is_empty() {
            continue;
        }
        out.push(ParsedOption {
            field: "diecast_type",
            value: v.clone(),
            display: v,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture: a minimal form covering every kind of field shape we parse.
    const FIXTURE: &str = r##"
<form id="search-form">
  <input id="t1" name="load" type="radio" value="All Diecast">
  <input id="t2" name="load" type="radio" value="Stock Car">
  <select name="Drivers">
    <option value="11111111-1111-1111-1111-111111111111">Jeff Gordon</option>
    <option value="22222222-2222-2222-2222-222222222222">Kevin Harvick</option>
  </select>
  <select name="Scales">
    <option value="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa">1:24</option>
    <option value="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb">1:64</option>
  </select>
  <select name="Years">
    <option value="2002">2002</option>
    <option value="1995">1995</option>
  </select>
  <select name="DiecastOems">
    <option value="oooooooo-oooo-oooo-oooo-oooooooooooo">Action / Lionel</option>
  </select>
  <select name="DiecastBrands">
    <option value="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb">ARC</option>
  </select>
  <select name="DiecastMakes">
    <option value="mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm">CWC</option>
  </select>
  <select name="Finishes">
    <option value="ffffffff-ffff-ffff-ffff-ffffffffffff">(Standard)</option>
  </select>
</form>
"##;

    #[test]
    fn parses_all_field_kinds() {
        let opts = parse_form_options(FIXTURE);
        let by_field = |field: &str| {
            opts.iter()
                .filter(|o| o.field == field)
                .map(|o| (o.value.clone(), o.display.clone()))
                .collect::<Vec<_>>()
        };

        assert_eq!(
            by_field("diecast_type"),
            vec![
                ("All Diecast".to_string(), "All Diecast".to_string()),
                ("Stock Car".to_string(), "Stock Car".to_string()),
            ],
        );
        let drivers = by_field("driver");
        assert_eq!(drivers.len(), 2);
        assert_eq!(drivers[0].1, "Jeff Gordon");
        assert_eq!(by_field("year").len(), 2);
        assert_eq!(by_field("oem").len(), 1);
        assert_eq!(by_field("brand").len(), 1);
        assert_eq!(by_field("make").len(), 1);
        assert_eq!(by_field("scale").len(), 2);
        assert_eq!(by_field("finish").len(), 1);
    }

    #[test]
    fn skips_blank_options() {
        let html = r##"<select name="DiecastBrands"><option value=""></option></select>"##;
        let opts = parse_form_options(html);
        assert!(opts.is_empty());
    }
}
