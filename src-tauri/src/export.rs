//! File exports of registry search results, a wishlist, and the collection.
//!
//! Each source exports in three formats, chosen by [`ExportFormat`]:
//!
//! - **HTML** — a self-contained, print-friendly document. Images are
//!   downloaded from DCR and embedded as base64 data URIs so the file works
//!   offline; a download failure degrades to an "image unavailable"
//!   placeholder rather than failing the export.
//! - **CSV** and **JSON** — data exports built from one record struct per
//!   source, so the two formats always carry the same fields. Images are not
//!   fetched: the image field is the absolute URL of the picture.
//!
//! Search results don't carry discrete car-number / sponsor / finish fields:
//! the car number is parsed off the front of `scheme_text` ("#24 DuPont …"),
//! the remainder of the scheme text stands in for the sponsor, and the finish
//! comes from the caller (the UI passes the selected finish filter, if any).

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::commands::CollectionRow;
use crate::dcr::ProductionSearchResult;
use crate::error::{AppError, AppResult};
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

/// Which file an export writes. Comes over the wire from the frontend as
/// `"html"` / `"csv"` / `"json"`.
///
/// HTML embeds images and is the slow, progress-reporting path. CSV and JSON
/// are built from the same records and carry each image's absolute URL in
/// place of its bytes, so they write instantly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Html,
    Csv,
    Json,
}

impl ExportFormat {
    /// The record-based formats, or `None` for HTML. Lets each export
    /// function branch once and hand the rest to [`write_data_export`]
    /// without that helper needing an unreachable HTML arm.
    fn data_format(self) -> Option<DataFormat> {
        match self {
            Self::Html => None,
            Self::Csv => Some(DataFormat::Csv),
            Self::Json => Some(DataFormat::Json),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataFormat {
    Csv,
    Json,
}

/// A flat row for the CSV export. Every record type also derives
/// `Serialize` for JSON, so the CSV columns and the JSON keys come from one
/// struct and can't drift apart.
trait CsvRecord {
    const COLUMNS: &'static [&'static str];
    fn fields(&self) -> Vec<String>;
}

/// Write a CSV or JSON export. Shared by the three sources: no images, so
/// no per-entry steps — build the text, write it, report.
async fn write_data_export<R: CsvRecord + Serialize>(
    progress: &ProgressEmitter,
    records: &[R],
    format: DataFormat,
    noun: &str,
    path: &str,
) -> AppResult<ExportSummary> {
    let total = records.len() as u32;
    progress.step("Writing file…", Some(total), Some(total));
    let doc = match format {
        DataFormat::Csv => build_csv(records),
        DataFormat::Json => build_json(records)?,
    };
    tokio::fs::write(path, doc).await?;
    progress.done(format!(
        "Exported {} to {path}.",
        count_label(records.len(), noun)
    ));
    Ok(ExportSummary {
        path: path.to_string(),
        entries: records.len(),
        images_embedded: 0,
        images_failed: 0,
    })
}

/// Export the results to `path` in `format`. For HTML, download every
/// result's image and build the document; for CSV/JSON, write the records.
pub async fn export_registry_results(
    progress: &ProgressEmitter,
    results: &[ProductionSearchResult],
    finish_label: Option<&str>,
    path: &str,
    format: ExportFormat,
) -> AppResult<ExportSummary> {
    if let Some(data) = format.data_format() {
        let records: Vec<RegistryRecord> = results
            .iter()
            .map(|r| RegistryRecord::new(r, finish_label))
            .collect();
        return write_data_export(progress, &records, data, "result", path).await;
    }
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
        "Exported {} to {path}.",
        count_label(entries.len(), "result")
    ));

    Ok(ExportSummary {
        path: path.to_string(),
        entries: entries.len(),
        images_embedded,
        images_failed,
    })
}

/// What a rendered wishlist is allowed to contain.
///
/// A file on the user's own disk gets everything. A share is public to
/// anyone holding the link, so the default is the opposite: notes are
/// free-form and can say anything, and the candidate lines carry prices and
/// seller names — what the user is paying attention to and what they expect
/// to pay. Neither is inferable from the wish itself, which is the test for
/// whether omitting it actually protects something.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WishlistRenderOptions {
    pub include_notes: bool,
    pub include_candidates: bool,
}

impl WishlistRenderOptions {
    /// Everything — the local file export.
    pub const FULL: Self = Self {
        include_notes: true,
        include_candidates: true,
    };
    /// The cars and nothing else — the default for a public link.
    pub const PUBLIC: Self = Self {
        include_notes: false,
        include_candidates: false,
    };
}

/// Wishlist counterpart of [`export_registry_results`]: same document shape,
/// plus per-entry notes and linked candidate listings. The data formats
/// include both too — this is the user's own file, so nothing is held back
/// the way a public share holds back notes and candidates.
pub async fn export_wishlist(
    progress: &ProgressEmitter,
    list_name: &str,
    wishes: &[WishlistEntry],
    path: &str,
    format: ExportFormat,
) -> AppResult<ExportSummary> {
    if let Some(data) = format.data_format() {
        let records: Vec<WishlistRecord> = wishes.iter().map(WishlistRecord::new).collect();
        return write_data_export(progress, &records, data, "entry", path).await;
    }
    let rendered =
        render_wishlist(progress, list_name, wishes, WishlistRenderOptions::FULL).await?;
    progress.step(
        "Writing file…",
        Some(wishes.len() as u32),
        Some(wishes.len() as u32),
    );
    tokio::fs::write(path, rendered.html).await?;
    progress.done(format!(
        "Exported {} to {path}.",
        count_label(rendered.entries, "entry")
    ));
    Ok(ExportSummary {
        path: path.to_string(),
        entries: rendered.entries,
        images_embedded: rendered.images_embedded,
        images_failed: rendered.images_failed,
    })
}

/// A rendered document plus what went into it. Separate from
/// [`ExportSummary`] because a share has no path.
pub struct RenderedDocument {
    pub html: String,
    pub entries: usize,
    pub images_embedded: usize,
    pub images_failed: usize,
}

/// Build the wishlist document in memory. Split out of `export_wishlist` so
/// sharing (DCH-46) uploads exactly the document the file export writes,
/// rather than a second renderer that would drift from it.
pub async fn render_wishlist(
    progress: &ProgressEmitter,
    list_name: &str,
    wishes: &[WishlistEntry],
    options: WishlistRenderOptions,
) -> AppResult<RenderedDocument> {
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
            notes: options.include_notes.then(|| w.notes.clone()).flatten(),
            bullets_label: Some("Candidate listings".into()),
            bullets: if options.include_candidates {
                w.listings.iter().map(candidate_line).collect()
            } else {
                Vec::new()
            },
            ..Default::default()
        });
    }

    Ok(RenderedDocument {
        html: build_document(list_name, "entry", &entries),
        entries: entries.len(),
        images_embedded,
        images_failed,
    })
}

/// What a rendered set of saved listings is allowed to contain (DCH-48).
///
/// Unlike the wishlist's options, prices and sellers are *not* toggleable:
/// they are the content. "Here are the five auctions I'm watching" with the
/// prices removed is not a smaller share, it is a pointless one.
///
/// What is toggleable is the part that isn't eBay's data. Deal score and
/// comps are our own valuation of someone else's listing, derived from the
/// registry and from an archive of sales only this user has. Publishing them
/// tells the recipient — and the seller, if the link travels — what we think
/// the car is worth, which is a different disclosure from what eBay already
/// shows on the item page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListingRenderOptions {
    pub include_valuations: bool,
}

impl ListingRenderOptions {
    /// eBay's own facts and nothing we inferred — the default for a link.
    pub const PUBLIC: Self = Self {
        include_valuations: false,
    };
}

/// Saved-listings counterpart of [`render_wishlist`] (DCH-48).
///
/// Every selected listing renders, matched or not: the selection is the
/// user's statement of what they want to show, and silently dropping the
/// unmatched ones is the failure mode that made routing this through
/// wishlists the wrong answer.
pub async fn render_listings(
    progress: &ProgressEmitter,
    title: &str,
    rows: &[crate::commands::ListingRow],
    options: ListingRenderOptions,
) -> AppResult<RenderedDocument> {
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
        let mut bullets = Vec::new();
        if let Some(line) = listing_match_line(r) {
            bullets.push(line);
        }
        if options.include_valuations {
            bullets.extend(listing_valuation_lines(r));
        }
        entries.push(EntryHtml {
            header: r.title.clone(),
            link: Some(r.url.clone()),
            subheader: listing_subheader_line(r),
            image_data_uri: image,
            bullets_label: (!bullets.is_empty()).then(|| "Details".to_string()),
            bullets,
            ..Default::default()
        });
    }

    Ok(RenderedDocument {
        html: build_document(title, "listing", &entries),
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
    format: ExportFormat,
) -> AppResult<ExportSummary> {
    if let Some(data) = format.data_format() {
        let records: Vec<CollectionRecord> = rows.iter().map(CollectionRecord::new).collect();
        return write_data_export(progress, &records, data, "item", path).await;
    }
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
        // The user's own photo wins over the catalog image: they attached it
        // because it shows the copy they own. Read from disk rather than
        // fetched — `fetch_image_data_uri` would treat the path as a DCR-
        // relative URL and produce a 404 and a placeholder.
        let image = match (&r.local_image_path, &r.image_url) {
            (Some(p), _) => match read_image_data_uri(std::path::Path::new(p)).await {
                Ok(uri) => {
                    images_embedded += 1;
                    Some(uri)
                }
                Err(e) => {
                    tracing::warn!("export: could not read local photo {p}: {e}");
                    images_failed += 1;
                    None
                }
            },
            (None, Some(u)) => match fetch_image_data_uri(&client, u).await {
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
            (None, None) => None,
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
        "Exported {} to {path}.",
        count_label(entries.len(), "item")
    ));

    Ok(ExportSummary {
        path: path.to_string(),
        entries: entries.len(),
        images_embedded,
        images_failed,
    })
}

// ---------------------------------------------------------------------------
// CSV / JSON records
//
// One struct per source. `Serialize` gives the JSON shape; `CsvRecord` gives
// the CSV columns in the same order, from the same fields. Money is
// `*_cents` integers in JSON (the app's own convention) and decimal dollars
// in CSV so a spreadsheet can sum the column. Absent values are `null` in
// JSON and an empty cell in CSV — never the string "null".
// ---------------------------------------------------------------------------

/// One registry search result. `finish` is the caller's — search results
/// don't carry it, so it is only known when the search was pinned to one.
#[derive(Debug, Serialize)]
struct RegistryRecord {
    driver: String,
    year: Option<i32>,
    car_number: Option<String>,
    scheme: Option<String>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    make: Option<String>,
    finish: Option<String>,
    production_qty: Option<i64>,
    retail_value_cents: Option<i64>,
    wholesale_value_cents: Option<i64>,
    image_url: Option<String>,
    dcr_url: Option<String>,
}

impl RegistryRecord {
    fn new(r: &ProductionSearchResult, finish_label: Option<&str>) -> Self {
        let (car_number, _) = split_scheme(r.scheme_text.as_deref());
        Self {
            driver: r.driver_name.clone(),
            year: r.year,
            car_number,
            scheme: r.scheme_text.clone(),
            oem: r.oem.clone(),
            brand: r.brand.clone(),
            scale: r.scale.clone(),
            make: r.make.clone(),
            finish: finish_label.map(str::to_string),
            production_qty: r.seq_produced_total,
            retail_value_cents: r.retail_value_cents,
            wholesale_value_cents: r.wholesale_value_cents,
            image_url: r.image_url.as_deref().map(absolute_dcr_url),
            dcr_url: r.detail_url.as_deref().map(absolute_dcr_url),
        }
    }
}

impl CsvRecord for RegistryRecord {
    const COLUMNS: &'static [&'static str] = &[
        "Driver",
        "Year",
        "Car Number",
        "Scheme",
        "OEM",
        "Brand",
        "Scale",
        "Make",
        "Finish",
        "Production Qty",
        "Retail Value",
        "Wholesale Value",
        "Image URL",
        "DCR URL",
    ];

    fn fields(&self) -> Vec<String> {
        vec![
            self.driver.clone(),
            cell(&self.year),
            cell(&self.car_number),
            cell(&self.scheme),
            cell(&self.oem),
            cell(&self.brand),
            cell(&self.scale),
            cell(&self.make),
            cell(&self.finish),
            cell(&self.production_qty),
            dollars_cell(self.retail_value_cents),
            dollars_cell(self.wholesale_value_cents),
            cell(&self.image_url),
            cell(&self.dcr_url),
        ]
    }
}

/// One wishlist entry with its notes and linked candidate listings. JSON
/// nests the candidates as objects; CSV flattens them into one cell, one
/// candidate per `" | "`-separated segment, in the same words the HTML
/// export uses.
#[derive(Debug, Serialize)]
struct WishlistRecord {
    driver: Option<String>,
    year: Option<i64>,
    car_number: Option<String>,
    scheme: Option<String>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    make: Option<String>,
    production_qty: Option<i64>,
    retail_value_cents: Option<i64>,
    wholesale_value_cents: Option<i64>,
    notes: Option<String>,
    listings: Vec<WishlistListingRecord>,
    image_url: Option<String>,
    dcr_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct WishlistListingRecord {
    title: String,
    url: String,
    seller: String,
    price_cents: Option<i64>,
    shipping_cents: Option<i64>,
    currency: String,
    status: String,
}

impl WishlistListingRecord {
    fn new(l: &crate::wishlist::WishlistListing) -> Self {
        Self {
            title: l.title.clone(),
            url: l.url.clone(),
            seller: l.seller_code.clone(),
            price_cents: l.price_cents,
            shipping_cents: l.shipping_cents,
            currency: l.currency.clone(),
            status: l.status.clone(),
        }
    }

    /// `<title> — <total> (<seller>, <status>)` — the one-line form shared
    /// by the HTML bullet and the CSV cell.
    fn summary(&self) -> String {
        let mut line = self.title.clone();
        if let Some(p) = self.price_cents {
            line.push_str(&format!(
                " — {}",
                format_dollars(p + self.shipping_cents.unwrap_or(0))
            ));
        }
        line.push_str(&format!(" ({}, {})", self.seller, self.status));
        line
    }
}

impl WishlistRecord {
    fn new(w: &WishlistEntry) -> Self {
        let (car_number, _) = split_scheme(w.scheme_text.as_deref());
        Self {
            driver: w.driver_name.clone(),
            year: w.year,
            car_number,
            scheme: w.scheme_text.clone(),
            oem: w.oem.clone(),
            brand: w.brand.clone(),
            scale: w.scale.clone(),
            make: w.make.clone(),
            production_qty: w.production_qty,
            retail_value_cents: w.retail_value_cents,
            wholesale_value_cents: w.wholesale_value_cents,
            notes: w.notes.clone(),
            listings: w.listings.iter().map(WishlistListingRecord::new).collect(),
            image_url: w.image_url.as_deref().map(absolute_dcr_url),
            dcr_url: w.detail_url.as_deref().map(absolute_dcr_url),
        }
    }
}

impl CsvRecord for WishlistRecord {
    const COLUMNS: &'static [&'static str] = &[
        "Driver",
        "Year",
        "Car Number",
        "Scheme",
        "OEM",
        "Brand",
        "Scale",
        "Make",
        "Production Qty",
        "Retail Value",
        "Wholesale Value",
        "Notes",
        "Candidate Listings",
        "Image URL",
        "DCR URL",
    ];

    fn fields(&self) -> Vec<String> {
        vec![
            cell(&self.driver),
            cell(&self.year),
            cell(&self.car_number),
            cell(&self.scheme),
            cell(&self.oem),
            cell(&self.brand),
            cell(&self.scale),
            cell(&self.make),
            cell(&self.production_qty),
            dollars_cell(self.retail_value_cents),
            dollars_cell(self.wholesale_value_cents),
            cell(&self.notes),
            self.listings
                .iter()
                .map(WishlistListingRecord::summary)
                .collect::<Vec<_>>()
                .join(" | "),
            cell(&self.image_url),
            cell(&self.dcr_url),
        ]
    }
}

/// One collection row. Two picture fields, because the HTML export prefers
/// the user's own photo over the catalog image and a data export shouldn't
/// silently lose either: `image_url` is DCR's picture, `photo_path` the
/// attached file on this machine.
#[derive(Debug, Serialize)]
struct CollectionRecord {
    driver: Option<String>,
    year: Option<i32>,
    car_number: Option<String>,
    scheme: Option<String>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    make: Option<String>,
    finish: Option<String>,
    diecast_type: Option<String>,
    production_qty: Option<i64>,
    din: Option<i64>,
    retail_value_cents: Option<i64>,
    wholesale_value_cents: Option<i64>,
    registration_number: Option<String>,
    image_url: Option<String>,
    photo_path: Option<String>,
    dcr_url: Option<String>,
}

impl CollectionRecord {
    fn new(r: &CollectionRow) -> Self {
        // The discrete field wins; a stub row that only has scheme text
        // still gets a number parsed off its front.
        let car_number = r
            .car_number
            .clone()
            .filter(|n| !n.trim().is_empty())
            .or_else(|| split_scheme(r.scheme_text.as_deref()).0);
        Self {
            driver: r.driver_name.clone(),
            year: r.year,
            car_number,
            scheme: r.scheme_text.clone(),
            oem: r.oem.clone(),
            brand: r.brand.clone(),
            scale: r.scale.clone(),
            make: r.make.clone(),
            finish: r.finish.clone(),
            diecast_type: r.diecast_type.clone(),
            production_qty: r.production_qty,
            din: r.din,
            retail_value_cents: r.retail_value_cents,
            wholesale_value_cents: r.wholesale_value_cents,
            registration_number: r.registration_number.clone(),
            image_url: r.image_url.as_deref().map(absolute_dcr_url),
            photo_path: r.local_image_path.clone(),
            dcr_url: r.detail_url.as_deref().map(absolute_dcr_url),
        }
    }
}

impl CsvRecord for CollectionRecord {
    const COLUMNS: &'static [&'static str] = &[
        "Driver",
        "Year",
        "Car Number",
        "Scheme",
        "OEM",
        "Brand",
        "Scale",
        "Make",
        "Finish",
        "Type",
        "Production Qty",
        "DIN",
        "Retail Value",
        "Wholesale Value",
        "Registration Number",
        "Image URL",
        "Photo Path",
        "DCR URL",
    ];

    fn fields(&self) -> Vec<String> {
        vec![
            cell(&self.driver),
            cell(&self.year),
            cell(&self.car_number),
            cell(&self.scheme),
            cell(&self.oem),
            cell(&self.brand),
            cell(&self.scale),
            cell(&self.make),
            cell(&self.finish),
            cell(&self.diecast_type),
            cell(&self.production_qty),
            cell(&self.din),
            dollars_cell(self.retail_value_cents),
            dollars_cell(self.wholesale_value_cents),
            cell(&self.registration_number),
            cell(&self.image_url),
            cell(&self.photo_path),
            cell(&self.dcr_url),
        ]
    }
}

fn build_csv<R: CsvRecord>(records: &[R]) -> String {
    // Leading BOM so Excel opens the file as UTF-8.
    let mut out = String::from("\u{feff}");
    out.push_str(&R::COLUMNS.join(","));
    out.push('\n');
    for r in records {
        let fields = r.fields();
        debug_assert_eq!(fields.len(), R::COLUMNS.len());
        let line: Vec<String> = fields.iter().map(|f| csv_field(f)).collect();
        out.push_str(&line.join(","));
        out.push('\n');
    }
    out
}

/// A top-level array of records, pretty-printed. Serializing plain structs
/// can't realistically fail, but the signature stays honest about it.
fn build_json<R: Serialize>(records: &[R]) -> AppResult<String> {
    serde_json::to_string_pretty(records).map_err(|e| AppError::Parse(e.to_string()))
}

/// An optional value as a CSV cell: absent is empty, never "null".
fn cell<T: ToString>(v: &Option<T>) -> String {
    v.as_ref().map(ToString::to_string).unwrap_or_default()
}

fn dollars_cell(cents: Option<i64>) -> String {
    cents.map(csv_dollars).unwrap_or_default()
}

/// Turn a stored DCR reference (`/Uploads/…`) into an absolute URL, leaving
/// anything that already carries a scheme alone. Mirrors `resolveDcrUrl` in
/// `src/lib/dcr.ts`, including its two edge cases: a protocol-relative
/// `//host/…` gets `https:`, and a path that lost its leading slash gets one
/// back rather than concatenating onto the origin.
fn absolute_dcr_url(path: &str) -> String {
    let t = path.trim();
    if t.starts_with("//") {
        return format!("https:{t}");
    }
    let has_scheme = t.split_once(':').is_some_and(|(scheme, _)| {
        scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if has_scheme {
        t.to_string()
    } else if t.starts_with('/') {
        format!("{DCR_BASE}{t}")
    } else {
        format!("{DCR_BASE}/{t}")
    }
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
    /// Absolute http(s) URL the header links to, for documents whose entries
    /// point somewhere (a shared listing links to its eBay item). `None`
    /// renders the header as plain text. Always run through
    /// [`safe_http_url`] first — this string lands in an `href` on a page
    /// served to the public.
    link: Option<String>,
    subheader: String,
    image_data_uri: Option<String>,
    /// Free-form user notes (wishlist only), rendered italic under the
    /// subheader.
    notes: Option<String>,
    /// Heading above [`EntryHtml::bullets`]. The two travel together; a
    /// caller that sets one and not the other gets a list with no label or a
    /// label with no list, which is why they are read as a pair below.
    bullets_label: Option<String>,
    /// Pre-formatted extra lines, one bullet each: candidate listings on a
    /// wishlist entry, the registry match and opt-in valuations on a shared
    /// listing.
    bullets: Vec<String>,
}

/// A URL safe to put in an `href` on a public page, or `None`.
///
/// These documents are uploaded to a Worker and served to anyone holding the
/// link, so a `javascript:` or `data:` URL reaching an `href` would be stored
/// XSS. The URLs in play come from our own database and are eBay item links,
/// so this rejects nothing in practice — which is exactly why it has to be
/// enforced here rather than trusted at each call site, where the next kind
/// of share will be written by someone who never read this comment.
fn safe_http_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(trimmed.to_string())
    } else {
        None
    }
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
        r.din.map(|n| format!("DIN #{}", format_thousands(n))),
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
    WishlistListingRecord::new(l).summary()
}

/// The facts line under a shared listing: what it costs, what it is, where
/// it stands, and who's selling (DCH-48).
///
/// Everything here is on the eBay page the header links to, which is the
/// test for whether it belongs on a public share at all. Missing pieces are
/// dropped rather than rendered as blanks — a listing synced before eBay
/// returned a shipping quote should read as "no shipping quote", which is
/// what saying nothing means, not "$0.00".
fn listing_subheader_line(r: &crate::commands::ListingRow) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(price) = r.price_cents {
        let mut money = format_dollars(price);
        match r.shipping_cents {
            Some(0) => money.push_str(" + free shipping"),
            Some(s) => money.push_str(&format!(" + {} shipping", format_dollars(s))),
            None => {}
        }
        parts.push(money);
    }
    if let Some(c) = r.condition.as_deref().filter(|c| !c.trim().is_empty()) {
        parts.push(c.to_string());
    }

    let kind = match r.listing_type.as_deref() {
        Some("auction") => Some("auction"),
        Some("fixed") => Some("Buy It Now"),
        _ => None,
    };
    match (kind, r.accepts_offers) {
        (Some(k), true) => parts.push(format!("{k} + offers")),
        (Some(k), false) => parts.push(k.to_string()),
        (None, true) => parts.push("accepts offers".into()),
        (None, false) => {}
    }

    parts.push(listing_state_phrase(r));

    if let Some(seller) = r
        .seller_username
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        parts.push(format!("seller {seller}"));
    }

    parts.join(" · ")
}

/// Where a listing stands, in words a recipient can act on.
///
/// An end *time* is only meaningful while the listing is live; once it has
/// ended, why it ended is the useful fact and the timestamp is history. A
/// share is a snapshot, so this deliberately says "ends" with a date rather
/// than a countdown — "ends in 2 days" is wrong the moment the page is
/// opened tomorrow, and the whole point of a link is that it is read later.
fn listing_state_phrase(r: &crate::commands::ListingRow) -> String {
    if r.is_archived || r.status != "active" {
        return match r.end_reason.as_deref() {
            Some("sold") => "sold".to_string(),
            Some("removed") => "no longer listed".to_string(),
            _ => "ended".to_string(),
        };
    }
    match r.end_time {
        Some(t) => match chrono::DateTime::from_timestamp(t, 0) {
            Some(dt) => format!(
                "ends {}",
                dt.with_timezone(&chrono::Local).format("%b %-d, %Y")
            ),
            None => "active".to_string(),
        },
        None => "active".to_string(),
    }
}

/// The registry match as one bullet, or `None` for an unmatched listing.
/// Unmatched is not an error state here — it just has nothing to say.
fn listing_match_line(r: &crate::commands::ListingRow) -> Option<String> {
    r.registry_entry_id?;
    let mut head = match (
        r.matched_driver_name.as_deref(),
        r.matched_scheme_text.as_deref(),
    ) {
        (Some(d), Some(s)) if !s.trim().is_empty() => format!("{d} — {s}"),
        (Some(d), _) => d.to_string(),
        (None, Some(s)) if !s.trim().is_empty() => s.to_string(),
        (None, _) => "registry entry".to_string(),
    };
    let specs: Vec<String> = [
        r.matched_year.map(|y| y.to_string()),
        r.matched_oem.clone(),
        r.matched_brand.clone(),
        r.matched_scale.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.trim().is_empty())
    .collect();
    if !specs.is_empty() {
        head.push_str(&format!(" ({})", specs.join(" · ")));
    }
    Some(format!("Registry match: {head}"))
}

/// Our own valuation of someone else's listing — off by default, and only
/// ever reached through [`ListingRenderOptions::include_valuations`].
fn listing_valuation_lines(r: &crate::commands::ListingRow) -> Vec<String> {
    let mut out = Vec::new();
    if let (Some(score), Some(retail)) = (r.deal_score, r.matched_retail_cents) {
        out.push(format!(
            "{:.0}% of registry retail ({})",
            score,
            format_dollars(retail)
        ));
    }
    if let Some(c) = &r.comps {
        out.push(format!(
            "{} recent sale{}: {} – {} (median {})",
            c.count,
            if c.count == 1 { "" } else { "s" },
            format_dollars(c.low_cents),
            format_dollars(c.high_cents),
            format_dollars(c.median_cents),
        ));
    }
    out
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
        if i > 0 && (raw.len() - i).is_multiple_of(3) {
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

/// "1 result" / "3 results" / "2 entries": the count and its noun, for the
/// document's meta line and the progress toast. Plurals are regular except
/// for "entry".
fn count_label(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else if noun == "entry" {
        format!("{count} entries")
    } else {
        format!("{count} {noun}s")
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn fetch_image_data_uri(client: &reqwest::Client, url: &str) -> AppResult<String> {
    let abs = absolute_dcr_url(url);
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

/// Same data URI, but for a photo the user attached from their own disk
/// (`collection_photo`). Shares `sniff_mime` so an export embeds a local
/// photo exactly as it embeds a downloaded one.
async fn read_image_data_uri(path: &std::path::Path) -> AppResult<String> {
    let bytes = tokio::fs::read(path).await?;
    let mime = sniff_mime(&bytes, &path.to_string_lossy());
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
    let count_label = count_label(entries.len(), noun);
    let mut body = String::new();
    for e in entries {
        body.push_str("<section class=\"entry\">\n");
        let header = html_escape(&e.header);
        match e.link.as_deref().and_then(safe_http_url) {
            // `noopener` because these open in someone else's browser, and
            // `nofollow` to match the page's own noindex posture.
            Some(href) => body.push_str(&format!(
                "<h2><a href=\"{}\" rel=\"noopener nofollow\">{header}</a></h2>\n",
                html_escape(&href)
            )),
            None => body.push_str(&format!("<h2>{header}</h2>\n")),
        }
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
        if !e.bullets.is_empty() {
            if let Some(label) = e.bullets_label.as_deref() {
                body.push_str(&format!(
                    "<div class=\"cands-label\">{}</div>\n",
                    html_escape(label)
                ));
            }
            body.push_str("<ul class=\"cands\">\n");
            for c in &e.bullets {
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
            is_local: false,
            paid_cents: None,
            condition: None,
            notes: None,
            din: None,
            local_image_path: None,
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
        r.image_url = Some("/Uploads/Collectibles/dupont.jpg".into());
        let csv = build_csv(&[CollectionRecord::new(&r)]);
        let mut lines = csv.trim_start_matches('\u{feff}').lines();
        let header = lines.next().unwrap();
        assert!(header.starts_with("Driver,Year,Car Number,"));
        assert!(header.ends_with(",Image URL,Photo Path,DCR URL"));
        let row = lines.next().unwrap();
        assert!(row.contains("\"DuPont \"\"Flames\"\" Monte, Carlo\""));
        assert!(row.contains("55.00"));
        assert!(row.contains("19.00"));
        assert!(row.contains("https://www.diecastregistry.com/Uploads/Collectibles/dupont.jpg"));
        assert!(row.contains("https://www.diecastregistry.com/NASCAR/jeff-gordon/dupont"));
        assert!(lines.next().is_none());

        // Empty optionals become empty fields, not "null".
        let mut bare = sample_collection_row();
        bare.retail_value_cents = None;
        bare.detail_url = None;
        let csv = build_csv(&[CollectionRecord::new(&bare)]);
        assert!(!csv.contains("null"));
    }

    #[test]
    fn collection_json_carries_cents_and_both_pictures() {
        let mut r = sample_collection_row();
        r.image_url = Some("/Uploads/Collectibles/dupont.jpg".into());
        r.local_image_path = Some("C:\\photos\\dupont.jpg".into());
        let json = build_json(&[CollectionRecord::new(&r)]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 1);
        let row = &v[0];
        assert_eq!(row["driver"], "Jeff Gordon");
        assert_eq!(row["car_number"], "24");
        assert_eq!(row["retail_value_cents"], 5500);
        assert_eq!(
            row["image_url"],
            "https://www.diecastregistry.com/Uploads/Collectibles/dupont.jpg"
        );
        assert_eq!(row["photo_path"], "C:\\photos\\dupont.jpg");
        assert_eq!(row["din"], serde_json::Value::Null);
    }

    #[test]
    fn registry_records_resolve_image_and_detail_urls() {
        let mut r = sample();
        r.image_url = Some("/Uploads/Collectibles/monte-carlo.jpg".into());
        r.detail_url = Some("/NASCAR/jeff-gordon/1957-chevy".into());
        let rec = RegistryRecord::new(&r, Some("Color Chrome"));
        assert_eq!(rec.car_number.as_deref(), Some("24"));
        assert_eq!(rec.finish.as_deref(), Some("Color Chrome"));
        assert_eq!(
            rec.image_url.as_deref(),
            Some("https://www.diecastregistry.com/Uploads/Collectibles/monte-carlo.jpg")
        );

        let csv = build_csv(&[RegistryRecord::new(&r, None)]);
        let mut lines = csv.trim_start_matches('\u{feff}').lines();
        assert_eq!(lines.next().unwrap(), RegistryRecord::COLUMNS.join(","));
        let row = lines.next().unwrap();
        assert!(row.starts_with("Jeff Gordon,2007,24,"), "{row}");
        assert!(row.contains(",55.00,19.00,"), "{row}");
        assert!(
            row.ends_with(
                "https://www.diecastregistry.com/Uploads/Collectibles/monte-carlo.jpg,\
                 https://www.diecastregistry.com/NASCAR/jeff-gordon/1957-chevy"
            ),
            "{row}"
        );

        let json = build_json(&[RegistryRecord::new(&r, None)]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v[0]["production_qty"], 504);
        assert_eq!(v[0]["finish"], serde_json::Value::Null);
        assert_eq!(
            v[0]["dcr_url"],
            "https://www.diecastregistry.com/NASCAR/jeff-gordon/1957-chevy"
        );
    }

    #[test]
    fn wishlist_records_flatten_candidates_for_csv_and_nest_them_for_json() {
        let w = sample_wish();
        let csv = build_csv(&[WishlistRecord::new(&w)]);
        let row = csv.trim_start_matches('\u{feff}').lines().nth(1).unwrap();
        // Notes and the candidate line ride along, in the same words the
        // HTML export's bullet uses.
        assert!(row.contains("\"max $60, chrome only\""), "{row}");
        assert!(
            row.contains("Jeff Gordon 1:24 DuPont <NIB> — $55.00 (ebay, active)"),
            "{row}"
        );

        let json = build_json(&[WishlistRecord::new(&w)]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v[0]["notes"], "max $60, chrome only");
        assert_eq!(v[0]["listings"][0]["price_cents"], 4999);
        assert_eq!(v[0]["listings"][0]["seller"], "ebay");
        assert_eq!(v[0]["listings"][0]["url"], "https://ebay.com/itm/1");
    }

    #[test]
    fn absolute_dcr_url_handles_every_stored_shape() {
        assert_eq!(
            absolute_dcr_url("/Uploads/x.jpg"),
            "https://www.diecastregistry.com/Uploads/x.jpg"
        );
        assert_eq!(
            absolute_dcr_url("Uploads/x.jpg"),
            "https://www.diecastregistry.com/Uploads/x.jpg"
        );
        assert_eq!(
            absolute_dcr_url("//cdn.example.com/x.jpg"),
            "https://cdn.example.com/x.jpg"
        );
        assert_eq!(
            absolute_dcr_url("https://i.ebayimg.com/x.jpg"),
            "https://i.ebayimg.com/x.jpg"
        );
        assert_eq!(
            absolute_dcr_url(" /Uploads/x.jpg "),
            "https://www.diecastregistry.com/Uploads/x.jpg"
        );
    }

    #[test]
    fn count_label_pluralizes() {
        assert_eq!(count_label(1, "result"), "1 result");
        assert_eq!(count_label(3, "result"), "3 results");
        assert_eq!(count_label(1, "entry"), "1 entry");
        assert_eq!(count_label(2, "entry"), "2 entries");
        assert_eq!(count_label(0, "item"), "0 items");
    }

    fn sample_listing() -> crate::commands::ListingRow {
        crate::commands::ListingRow {
            title: "1998 Action 1:24 Dale Earnhardt #3 GM Goodwrench".into(),
            url: "https://www.ebay.com/itm/123".into(),
            price_cents: Some(3499),
            shipping_cents: Some(850),
            condition: Some("Used".into()),
            listing_type: Some("auction".into()),
            status: "active".into(),
            end_time: Some(1_754_000_000),
            seller_username: Some("dixie_diecast".into()),
            ..Default::default()
        }
    }

    #[test]
    fn listing_subheader_reads_as_the_ebay_page_does() {
        let line = listing_subheader_line(&sample_listing());
        assert!(line.starts_with("$34.99 + $8.50 shipping · Used · auction · "));
        assert!(line.ends_with("· seller dixie_diecast"), "{line}");
    }

    #[test]
    fn free_shipping_says_so_and_an_unknown_quote_says_nothing() {
        // Rendering a missing quote as "$0.00" would advertise free shipping
        // the seller never offered.
        let mut free = sample_listing();
        free.shipping_cents = Some(0);
        assert!(listing_subheader_line(&free).contains("+ free shipping"));

        let mut unknown = sample_listing();
        unknown.shipping_cents = None;
        let line = listing_subheader_line(&unknown);
        assert!(line.contains("$34.99"), "{line}");
        assert!(!line.contains("shipping"), "{line}");
    }

    #[test]
    fn an_ended_listing_reports_why_rather_than_when() {
        // A share is read later, so "ends in 2 days" would be a lie by
        // tomorrow; once ended, the outcome is the useful fact.
        let mut sold = sample_listing();
        sold.status = "ended".into();
        sold.is_archived = true;
        sold.end_reason = Some("sold".into());
        assert!(listing_subheader_line(&sold).contains("· sold ·"));

        let mut removed = sample_listing();
        removed.status = "ended".into();
        removed.end_reason = Some("removed".into());
        assert!(listing_subheader_line(&removed).contains("no longer listed"));

        let mut ended = sample_listing();
        ended.status = "ended".into();
        assert!(listing_subheader_line(&ended).contains("· ended ·"));
    }

    #[test]
    fn buy_it_now_and_offers_are_folded_into_one_phrase() {
        let mut bin = sample_listing();
        bin.listing_type = Some("fixed".into());
        bin.accepts_offers = true;
        assert!(listing_subheader_line(&bin).contains("Buy It Now + offers"));
    }

    #[test]
    fn an_unmatched_listing_still_renders_and_simply_says_less() {
        // The failure that made wishlists the wrong vehicle for this: an
        // unmatched listing must not silently drop out of the share.
        let row = sample_listing();
        assert_eq!(listing_match_line(&row), None);
        assert!(!listing_subheader_line(&row).is_empty());
    }

    #[test]
    fn a_matched_listing_names_the_car_and_its_specs() {
        let mut row = sample_listing();
        row.registry_entry_id = Some(9);
        row.matched_driver_name = Some("Dale Earnhardt".into());
        row.matched_scheme_text = Some("GM Goodwrench Plus".into());
        row.matched_year = Some(1998);
        row.matched_brand = Some("Action".into());
        row.matched_scale = Some("1/24".into());
        assert_eq!(
            listing_match_line(&row).unwrap(),
            "Registry match: Dale Earnhardt — GM Goodwrench Plus (1998 · Action · 1/24)"
        );
    }

    #[test]
    fn valuations_are_absent_unless_asked_for() {
        // The AC: deal score and comps are our inference about someone
        // else's listing, not eBay's data, so a link doesn't carry them.
        let mut row = sample_listing();
        row.registry_entry_id = Some(9);
        row.deal_score = Some(61.4);
        row.matched_retail_cents = Some(9999);
        let lines = listing_valuation_lines(&row);
        assert_eq!(lines, vec!["61% of registry retail ($99.99)".to_string()]);
        assert_eq!(
            ListingRenderOptions::PUBLIC,
            ListingRenderOptions {
                include_valuations: false
            }
        );
    }

    #[test]
    fn a_header_link_is_rendered_and_a_hostile_one_is_not() {
        // These documents are served to the public from the user's own
        // domain, so an href is the one place a bad URL becomes stored XSS.
        assert_eq!(
            safe_http_url("https://www.ebay.com/itm/1"),
            Some("https://www.ebay.com/itm/1".to_string())
        );
        assert!(safe_http_url("HTTP://EBAY.COM/x").is_some());
        assert_eq!(safe_http_url("javascript:alert(1)"), None);
        assert_eq!(safe_http_url("data:text/html,<script>"), None);
        assert_eq!(safe_http_url("/relative/path"), None);

        let doc = build_document(
            "Shared",
            "listing",
            &[
                EntryHtml {
                    header: "Linked".into(),
                    link: Some("https://www.ebay.com/itm/1?a=1&b=2".into()),
                    ..Default::default()
                },
                EntryHtml {
                    header: "Hostile".into(),
                    link: Some("javascript:alert(1)".into()),
                    ..Default::default()
                },
            ],
        );
        assert!(doc.contains(r#"<a href="https://www.ebay.com/itm/1?a=1&amp;b=2""#));
        assert!(!doc.contains("javascript:"));
        assert!(doc.contains("<h2>Hostile</h2>"));
        assert!(doc.contains("2 listings —"));
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
                bullets_label: Some("Candidate listings".into()),
                bullets: w.listings.iter().map(candidate_line).collect(),
                ..Default::default()
            }],
        );
        assert!(doc.contains("1 entry —"));
        assert!(doc.contains("max $60, chrome only"));
        assert!(doc.contains("Candidate listings"));
        assert!(doc.contains("Jeff Gordon 1:24 DuPont &lt;NIB&gt; — $55.00 (ebay, active)"));
        let two = build_document(
            "Wishlist",
            "entry",
            &[EntryHtml::default(), EntryHtml::default()],
        );
        assert!(two.contains("2 entries —"));
    }
}
