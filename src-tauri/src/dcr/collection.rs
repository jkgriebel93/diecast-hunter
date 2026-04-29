use scraper::{ElementRef, Html, Selector};

use crate::dcr::parse::{
    asset_guid_from_id_attr, dollars_to_cents, normalize_driver_name, parse_details_line,
    parse_seq_produced, registry_guid_from_feedback_url, registry_int_id_from_url,
    SeqProduced,
};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct CollectionItem {
    pub asset_guid: String,
    pub registry_guid: Option<String>,
    pub registry_int_id: Option<i64>,
    pub detail_url: Option<String>,
    pub image_url: Option<String>,
    pub driver_name: String,
    pub driver_normalized: String,
    pub year: Option<i32>,
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub scale: Option<String>,
    pub make: Option<String>,
    /// Free-text scheme line, e.g. "#24 Pepsi Daytona 2002 Chevy Monte Carlo".
    pub scheme_text: Option<String>,
    pub seq_produced: SeqProduced,
    pub retail_value_cents: Option<i64>,
    pub wholesale_value_cents: Option<i64>,
}

#[derive(Debug, Default, Clone)]
pub struct CollectionPage {
    pub items: Vec<CollectionItem>,
    pub current_page: u32,
    pub total_pages: u32,
}

pub fn parse_collection_page(html: &str) -> AppResult<CollectionPage> {
    let doc = Html::parse_document(html);

    let item_sel = Selector::parse("div.svm-diecast-li").unwrap();
    let mut items = Vec::new();
    for el in doc.select(&item_sel) {
        match parse_item(el) {
            Ok(item) => items.push(item),
            Err(e) => tracing::warn!("skipping malformed collection item: {e}"),
        }
    }

    let (current_page, total_pages) = parse_pagination(&doc);

    Ok(CollectionPage {
        items,
        current_page,
        total_pages,
    })
}

fn parse_item(el: ElementRef) -> AppResult<CollectionItem> {
    let id_attr = el
        .value()
        .attr("id")
        .ok_or_else(|| AppError::Parse("svm-diecast-li missing id".into()))?;
    let asset_guid = asset_guid_from_id_attr(id_attr)
        .ok_or_else(|| AppError::Parse(format!("bad asset id attr: {id_attr}")))?;

    // The "info" link with class "diecast-value-feedback" carries the
    // registry-entry GUID in its href.
    let feedback_sel =
        Selector::parse("a.diecast-value-feedback").unwrap();
    let registry_guid = el
        .select(&feedback_sel)
        .next()
        .and_then(|a| a.value().attr("href"))
        .and_then(registry_guid_from_feedback_url);

    // The "additional information" link points to the public detail page,
    // which carries the registry's integer id at the end.
    let detail_link_sel =
        Selector::parse("a[href*='/diecast/']").unwrap();
    let detail_href = el
        .select(&detail_link_sel)
        .next()
        .and_then(|a| a.value().attr("href").map(str::to_owned));
    let registry_int_id = detail_href
        .as_deref()
        .and_then(registry_int_id_from_url);

    let image_sel = Selector::parse("img.img-thumbnail").unwrap();
    let image_url = el
        .select(&image_sel)
        .next()
        .and_then(|img| img.value().attr("src").map(str::to_owned));

    let driver_sel = Selector::parse("div.diecast-driver").unwrap();
    let driver_name = el
        .select(&driver_sel)
        .next()
        .map(|d| text(d))
        .ok_or_else(|| AppError::Parse("missing driver name".into()))?;
    let driver_normalized = normalize_driver_name(&driver_name);

    // .diecast-details has children div elements; the first contains the
    // year/OEM/brand/scale/make line, the second wraps an <a> with the scheme.
    let details_div_sel = Selector::parse("div.diecast-details").unwrap();
    let details_div = el
        .select(&details_div_sel)
        .next()
        .ok_or_else(|| AppError::Parse("missing diecast-details".into()))?;
    let inner_div_sel = Selector::parse(":scope > div").unwrap();
    let inner_divs: Vec<ElementRef> =
        details_div.select(&inner_div_sel).collect();

    let mut year = None;
    let mut oem = None;
    let mut brand = None;
    let mut scale = None;
    let mut make = None;

    if let Some(first) = inner_divs.first() {
        // Use raw text (whitespace preserved) so the parser can detect a
        // double-space "no brand" marker.
        let line = raw_text(*first);
        if let Some(parsed) = parse_details_line(&line) {
            year = Some(parsed.year);
            oem = Some(parsed.oem);
            brand = parsed.brand;
            scale = Some(parsed.scale);
            make = Some(parsed.make);
        }
    }

    // The scheme text is the anchor's text inside the second inner div, but
    // we want it WITHOUT the seq-produced span suffix.
    let scheme_anchor_sel = Selector::parse("a").unwrap();
    let mut scheme_text: Option<String> = None;
    let mut seq_produced = SeqProduced::default();
    if let Some(second) = inner_divs.get(1) {
        if let Some(a) = second.select(&scheme_anchor_sel).next() {
            // Take direct text nodes only, exclude the <span>.
            let mut buf = String::new();
            for node in a.children() {
                if let Some(t) = node.value().as_text() {
                    buf.push_str(t);
                }
            }
            let s = buf.trim().to_string();
            if !s.is_empty() {
                scheme_text = Some(s);
            }
        }
        let seq_sel = Selector::parse("span.seq-produced").unwrap();
        if let Some(seq_el) = second.select(&seq_sel).next() {
            seq_produced = parse_seq_produced(&text(seq_el));
        }
    }

    let value_sel = |class: &str| -> Selector {
        Selector::parse(&format!("div.{class} span")).unwrap()
    };
    let retail_value_cents = el
        .select(&value_sel("retail-value"))
        .next()
        .and_then(|s| dollars_to_cents(&text(s)));
    let wholesale_value_cents = el
        .select(&value_sel("wholesale-value"))
        .next()
        .and_then(|s| dollars_to_cents(&text(s)));

    Ok(CollectionItem {
        asset_guid,
        registry_guid,
        registry_int_id,
        detail_url: detail_href,
        image_url,
        driver_name,
        driver_normalized,
        year,
        oem,
        brand,
        scale,
        make,
        scheme_text,
        seq_produced,
        retail_value_cents,
        wholesale_value_cents,
    })
}

fn text(el: ElementRef) -> String {
    el.text()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Like `text` but preserves internal whitespace (only trims edges). Needed
/// for parsers that distinguish single vs double spaces (e.g. the
/// year/OEM/brand/scale line where a double space marks an empty brand).
fn raw_text(el: ElementRef) -> String {
    el.text().collect::<String>().trim().to_string()
}

fn parse_pagination(doc: &Html) -> (u32, u32) {
    // Pagination: <ul class="pagination"><li class="active"><a>1</a></li> ... </ul>
    // The largest numeric link tells us the total page count.
    let pagination_sel = Selector::parse("ul.pagination").unwrap();
    let li_sel = Selector::parse("li").unwrap();
    let a_sel = Selector::parse("a").unwrap();

    let mut current = 1u32;
    let mut max = 1u32;

    if let Some(ul) = doc.select(&pagination_sel).next() {
        for li in ul.select(&li_sel) {
            let is_active = li.value().classes().any(|c| c == "active");
            if let Some(a) = li.select(&a_sel).next() {
                if let Ok(n) = text(a).parse::<u32>() {
                    if is_active {
                        current = n;
                    }
                    if n > max {
                        max = n;
                    }
                }
            }
        }
    }

    (current, max.max(current))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixtures/dcr/mygarage_two_items.html");

    #[test]
    fn parses_two_items() {
        let page = parse_collection_page(FIXTURE).unwrap();
        assert_eq!(page.items.len(), 2);

        let first = &page.items[0];
        assert_eq!(first.asset_guid, "1bc0d137-617a-4153-9615-b43100f2bbdf");
        assert_eq!(
            first.registry_guid.as_deref(),
            Some("6f961f98-f59e-4c14-b7a3-5573807d9866")
        );
        assert_eq!(first.registry_int_id, Some(427374));
        assert_eq!(first.driver_name, "Jeff Gordon");
        assert_eq!(first.driver_normalized, "jeff-gordon");
        assert_eq!(first.year, Some(2002));
        assert_eq!(first.oem.as_deref(), Some("Action / Lionel"));
        assert_eq!(first.brand.as_deref(), Some("ARC"));
        assert_eq!(first.scale.as_deref(), Some("1:24"));
        assert_eq!(first.make.as_deref(), Some("CWC"));
        assert_eq!(
            first.scheme_text.as_deref(),
            Some("#24 Pepsi Daytona 2002 Chevy Monte Carlo")
        );
        assert_eq!(first.seq_produced.total, Some(37836));
        assert_eq!(first.retail_value_cents, Some(8800));
        assert_eq!(first.wholesale_value_cents, Some(2700));

        let second = &page.items[1];
        assert_eq!(second.driver_name, "Terry Labonte");
        assert_eq!(second.year, Some(1998));
        assert_eq!(second.make.as_deref(), Some("CWC"));
    }

    #[test]
    fn pagination_single_page() {
        let page = parse_collection_page(FIXTURE).unwrap();
        assert_eq!(page.current_page, 1);
        assert_eq!(page.total_pages, 1);
    }
}
