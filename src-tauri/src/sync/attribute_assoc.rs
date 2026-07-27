//! Auto-fill of listing-level attributes (oem / brand / make / finish and
//! the race-win + autograph flags) from the listing's own text: the title,
//! plus the description and eBay item specifics stored in `raw_json`
//! (titles almost never carry finish words; descriptions and item
//! specifics often do). Also home of `backfill_attrs_from_match`, which
//! copies authoritative values from a user-confirmed registry entry with
//! provenance recorded in `listings.attrs_from_entry_id`. The sibling of
//! `driver_assoc`, with one key difference in write policy: instead of a
//! detected-vs-stored reconciliation, this pass only ever fills NULL text
//! columns and flips flags 0→1. A wrong earlier detection is corrected
//! through the attribute editor in the UI (which sets
//! `attributes_user_set = 1` and takes the row out of auto-detection
//! entirely) — never by a later auto pass.
//!
//! The vocabulary for the four text fields comes from the
//! `registry_form_options` cache (DCR's own dropdown values), so detection
//! automatically follows whatever DCR considers canonical. The four
//! windowed-car/bank codes are unioned in as a builtin fallback since they
//! are fixed and titles use them constantly. Matching is
//! consecutive-token phrase matching, most-specific (longest) phrase first,
//! so a "Color Chrome" title never lands on a bare "Chrome" option.

use sqlx::SqlitePool;

use crate::error::AppResult;

#[derive(Debug, Default, Clone)]
pub struct AttrAssocSummary {
    pub considered: u32,
    /// Rows where detection produced at least one value. (The UPDATE still
    /// only fills fields that were NULL/0 — a row that already had every
    /// detected value ends up unchanged but is counted here.)
    pub detected: u32,
}

/// One canonical vocabulary value, pre-tokenized for matching.
#[derive(Debug, Clone)]
struct Phrase {
    tokens: Vec<String>,
    display: String,
}

#[derive(Debug, Default)]
struct Vocab {
    oems: Vec<Phrase>,
    brands: Vec<Phrase>,
    makes: Vec<Phrase>,
    finishes: Vec<Phrase>,
}

#[derive(Debug, Default, PartialEq)]
struct Detected {
    oem: Option<String>,
    brand: Option<String>,
    make: Option<String>,
    finish: Option<String>,
    race_win: bool,
    autographed: bool,
}

/// Detect and fill attributes for a single listing. Skips rows the user has
/// pinned via the attribute editor. Non-fatal at call sites — this is a
/// soft hint, same as driver association.
pub async fn associate_listing_attributes(pool: &SqlitePool, listing_id: i64) -> AppResult<()> {
    let row: Option<(String, Option<String>, i64)> =
        sqlx::query_as("SELECT title, raw_json, attributes_user_set FROM listings WHERE id = ?")
            .bind(listing_id)
            .fetch_optional(pool)
            .await?;
    let Some((title, raw_json, user_set)) = row else {
        return Ok(());
    };
    if user_set != 0 {
        return Ok(());
    }
    let vocab = load_vocab(pool).await?;
    let d = detect(&title, raw_json.as_deref(), &vocab);
    if d != Detected::default() {
        apply(pool, listing_id, &d).await?;
    }
    Ok(())
}

/// Re-scan every non-pinned listing, loading the vocabulary once. Run as a
/// detached startup backfill (mirroring the driver-assoc backfill) so rows
/// saved before this feature — or before the form-options cache was
/// populated — get attributes without a manual pass.
pub async fn associate_all_listing_attributes(pool: &SqlitePool) -> AppResult<AttrAssocSummary> {
    let vocab = load_vocab(pool).await?;
    let rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id, title, raw_json FROM listings WHERE attributes_user_set = 0 ORDER BY id",
    )
    .fetch_all(pool)
    .await?;
    let mut summary = AttrAssocSummary {
        considered: rows.len() as u32,
        ..Default::default()
    };
    for (id, title, raw_json) in rows {
        let d = detect(&title, raw_json.as_deref(), &vocab);
        if d == Detected::default() {
            continue;
        }
        apply(pool, id, &d).await?;
        summary.detected += 1;
    }
    Ok(summary)
}

/// Fill-only write: text fields keep any existing value via COALESCE, flags
/// only ever go 0→1 via MAX. The user-set guard is repeated in the WHERE so
/// a pin that lands between detection and write still wins.
async fn apply(pool: &SqlitePool, listing_id: i64, d: &Detected) -> AppResult<()> {
    sqlx::query(
        "UPDATE listings
         SET oem = COALESCE(oem, ?),
             brand = COALESCE(brand, ?),
             make = COALESCE(make, ?),
             finish = COALESCE(finish, ?),
             is_race_win = MAX(is_race_win, ?),
             is_autographed = MAX(is_autographed, ?)
         WHERE id = ? AND attributes_user_set = 0",
    )
    .bind(d.oem.as_deref())
    .bind(d.brand.as_deref())
    .bind(d.make.as_deref())
    .bind(d.finish.as_deref())
    .bind(d.race_win as i64)
    .bind(d.autographed as i64)
    .bind(listing_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Copy authoritative attribute values from a listing's user-confirmed
/// registry match onto the listing, recording provenance in
/// `attrs_from_entry_id`. Entry values win over auto-detected ones (the
/// entry is the truth about the car); pinned rows are never touched.
/// Returns false when the listing has no confirmed match.
pub async fn backfill_attrs_from_match(pool: &SqlitePool, listing_id: i64) -> AppResult<bool> {
    let row: Option<(
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
    )> = sqlx::query_as(
        "SELECT re.id, re.oem, re.brand, re.make, re.finish, re.production_qty
         FROM listing_matches lm
         JOIN registry_entries re ON re.id = lm.registry_entry_id
         WHERE lm.listing_id = ? AND lm.user_confirmed = 1
           AND lm.registry_entry_id IS NOT NULL",
    )
    .bind(listing_id)
    .fetch_optional(pool)
    .await?;
    let Some((entry_id, oem, brand, make, finish, production_qty)) = row else {
        return Ok(false);
    };
    sqlx::query(
        "UPDATE listings
         SET oem = COALESCE(?, oem),
             brand = COALESCE(?, brand),
             make = COALESCE(?, make),
             finish = COALESCE(?, finish),
             production_count = COALESCE(?, production_count),
             attrs_from_entry_id = ?
         WHERE id = ? AND attributes_user_set = 0",
    )
    .bind(oem)
    .bind(brand)
    .bind(make)
    .bind(finish)
    .bind(production_qty)
    .bind(entry_id)
    .bind(listing_id)
    .execute(pool)
    .await?;
    Ok(true)
}

/// Startup pass: backfill every non-pinned listing with a confirmed match.
/// Idempotent — re-running refreshes values from (possibly re-enriched)
/// entries.
pub async fn backfill_all_attrs_from_matches(pool: &SqlitePool) -> AppResult<u32> {
    let ids: Vec<(i64,)> = sqlx::query_as(
        "SELECT l.id
         FROM listings l
         JOIN listing_matches lm ON lm.listing_id = l.id
         WHERE lm.user_confirmed = 1 AND lm.registry_entry_id IS NOT NULL
           AND l.attributes_user_set = 0
         ORDER BY l.id",
    )
    .fetch_all(pool)
    .await?;
    let mut updated = 0u32;
    for (id,) in ids {
        if backfill_attrs_from_match(pool, id).await? {
            updated += 1;
        }
    }
    Ok(updated)
}

/// Undo a backfill when its source match is cleared or rejected: wipe the
/// copied values (pinned rows excepted), drop the provenance marker, and
/// re-run detection so listing-derived values come back.
pub async fn clear_backfilled_attrs(pool: &SqlitePool, listing_id: i64) -> AppResult<()> {
    let res = sqlx::query(
        "UPDATE listings
         SET oem = NULL, brand = NULL, make = NULL, finish = NULL,
             production_count = NULL, attrs_from_entry_id = NULL
         WHERE id = ? AND attrs_from_entry_id IS NOT NULL
           AND attributes_user_set = 0",
    )
    .bind(listing_id)
    .execute(pool)
    .await?;
    if res.rows_affected() > 0 {
        associate_listing_attributes(pool, listing_id).await?;
    }
    Ok(())
}

/// Codes DCR uses for the `make` field; unioned into the vocabulary so make
/// detection works even before the form-options cache is populated.
const BUILTIN_MAKES: &[&str] = &["CWC", "CWB", "BWC", "BWB"];

async fn load_vocab(pool: &SqlitePool) -> AppResult<Vocab> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT field, display FROM registry_form_options
         WHERE field IN ('oem', 'brand', 'make', 'finish')",
    )
    .fetch_all(pool)
    .await?;
    let mut vocab = Vocab::default();
    for (field, display) in rows {
        add_field_value(&mut vocab, &field, &display);
    }
    finalize_vocab(&mut vocab);
    Ok(vocab)
}

fn add_field_value(vocab: &mut Vocab, field: &str, display: &str) {
    // "Other" is a real dropdown value on DCR but a catastrophic title
    // token — never let it into the vocabulary.
    if display.trim().eq_ignore_ascii_case("other") {
        return;
    }
    let target = match field {
        "oem" => &mut vocab.oems,
        "brand" => &mut vocab.brands,
        "make" => &mut vocab.makes,
        "finish" => &mut vocab.finishes,
        _ => return,
    };
    push_phrase(target, display);
    // Combined-company OEM displays ("Action / Lionel", "Matchbox /
    // Mattel") almost never appear verbatim in titles — sellers write one
    // of the parts. Register each part as an alias that still stores the
    // canonical display, so a title saying just "Action" (or "Lionel")
    // fills oem = "Action / Lionel", matching what the registry entries
    // themselves use. OEM only: slashes in make and finish displays
    // ("Truck / SUV / Van", "Color/Mesma Chrome") are category unions
    // whose parts are far too generic to match alone.
    if field == "oem" && display.contains('/') {
        for part in display.split('/') {
            push_phrase_as(target, part, display);
        }
    }
}

/// Builtin fallbacks + longest-phrase-first ordering, so the most specific
/// value wins per field. Call once after every value has been added.
fn finalize_vocab(vocab: &mut Vocab) {
    for code in BUILTIN_MAKES {
        push_phrase(&mut vocab.makes, code);
    }
    for list in [
        &mut vocab.oems,
        &mut vocab.brands,
        &mut vocab.makes,
        &mut vocab.finishes,
    ] {
        list.sort_by(|a, b| b.tokens.len().cmp(&a.tokens.len()));
    }
}

fn push_phrase(list: &mut Vec<Phrase>, display: &str) {
    push_phrase_as(list, display, display);
}

/// Register `phrase_text` as something to look for in titles, storing
/// `display` when it hits. First registration of a token sequence wins.
fn push_phrase_as(list: &mut Vec<Phrase>, phrase_text: &str, display: &str) {
    let tokens = tokenize(phrase_text);
    if tokens.is_empty() {
        return;
    }
    if list.iter().any(|p| p.tokens == tokens) {
        return;
    }
    list.push(Phrase {
        tokens,
        display: display.trim().to_string(),
    });
}

fn detect(title: &str, raw_json: Option<&str>, vocab: &Vocab) -> Detected {
    let tokens = tokenize(title);
    let extra = ExtraText::from_raw_json(raw_json);
    Detected {
        oem: find_phrase(&tokens, &vocab.oems)
            .or_else(|| extra.field_match(&["brand", "manufacturer"], &vocab.oems))
            .or_else(|| extra.description_match(&vocab.oems)),
        brand: find_phrase(&tokens, &vocab.brands)
            .or_else(|| extra.field_match(&["brand", "series"], &vocab.brands))
            .or_else(|| extra.description_match(&vocab.brands)),
        make: find_phrase(&tokens, &vocab.makes)
            .or_else(|| extra.field_match(&["make", "type"], &vocab.makes))
            .or_else(|| extra.description_match(&vocab.makes)),
        finish: find_phrase(&tokens, &vocab.finishes)
            .or_else(|| extra.field_match(&["finish", "color"], &vocab.finishes))
            .or_else(|| extra.description_match(&vocab.finishes)),
        // Bare "win"/"winner" is deliberate: titles say "2023 Bristol Win"
        // or "Daytona 500 Winner", not "race win". Tokenization keeps this
        // safe — "Winners Circle" tokenizes to ["winners", "circle"] (no
        // singular "winner"), "twin" stays "twin".
        race_win: tokens
            .iter()
            .any(|t| t == "win" || t == "wins" || t == "winner"),
        autographed: tokens
            .iter()
            .any(|t| t == "autographed" || t == "autograph" || t == "signed"),
    }
}

/// Text mined from the stored source payload: eBay `localizedAspects`
/// (structured seller-filled fields) and the free-text description.
#[derive(Debug, Default)]
struct ExtraText {
    /// (lowercased aspect name, tokenized value)
    aspects: Vec<(String, Vec<String>)>,
    description_tokens: Vec<String>,
}

impl ExtraText {
    fn from_raw_json(raw_json: Option<&str>) -> Self {
        let mut out = ExtraText::default();
        let Some(raw) = raw_json else { return out };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            return out;
        };
        if let Some(aspects) = v.get("localizedAspects").and_then(|a| a.as_array()) {
            for a in aspects {
                if let (Some(name), Some(value)) = (
                    a.get("name").and_then(|n| n.as_str()),
                    a.get("value").and_then(|n| n.as_str()),
                ) {
                    out.aspects.push((name.to_lowercase(), tokenize(value)));
                }
            }
        }
        for key in ["shortDescription", "description"] {
            if let Some(text) = v.get(key).and_then(|t| t.as_str()) {
                out.description_tokens.extend(tokenize(text));
            }
        }
        out
    }

    /// Match a vocabulary against item-specifics values whose *name*
    /// contains one of the given keywords. Structured fields are
    /// high-precision, so any phrase length may match.
    fn field_match(&self, name_keys: &[&str], phrases: &[Phrase]) -> Option<String> {
        for (name, tokens) in &self.aspects {
            if name_keys.iter().any(|k| name.contains(k)) {
                if let Some(hit) = find_phrase(tokens, phrases) {
                    return Some(hit);
                }
            }
        }
        None
    }

    /// Match a vocabulary against free description text — but only
    /// multi-token phrases ("Color Chrome", "Winners Circle"). Single
    /// words like "Chrome" or "Elite" are far too common in descriptions
    /// to trust outside a structured field.
    fn description_match(&self, phrases: &[Phrase]) -> Option<String> {
        if self.description_tokens.is_empty() {
            return None;
        }
        phrases
            .iter()
            .filter(|p| p.tokens.len() >= 2)
            .find(|p| {
                self.description_tokens
                    .windows(p.tokens.len())
                    .any(|w| w == p.tokens.as_slice())
            })
            .map(|p| p.display.clone())
    }
}

/// First phrase (lists are pre-sorted longest-first) whose tokens appear
/// consecutively in the title.
fn find_phrase(tokens: &[String], phrases: &[Phrase]) -> Option<String> {
    phrases
        .iter()
        .find(|p| {
            tokens
                .windows(p.tokens.len())
                .any(|w| w == p.tokens.as_slice())
        })
        .map(|p| p.display.clone())
}

fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built the same way `load_vocab` builds from the DB, with a subset of
    /// the real DCR dropdown values.
    fn vocab() -> Vocab {
        let mut v = Vocab::default();
        for oem in [
            "Action / Lionel",
            "Winners Circle",
            "Racing Champions",
            "Team Caliber",
            "Other",
        ] {
            add_field_value(&mut v, "oem", oem);
        }
        for brand in ["ARC", "Elite"] {
            add_field_value(&mut v, "brand", brand);
        }
        for finish in ["Chrome", "Color Chrome", "Liquid Color"] {
            add_field_value(&mut v, "finish", finish);
        }
        for make in ["Truck / SUV / Van", "Other"] {
            add_field_value(&mut v, "make", make);
        }
        finalize_vocab(&mut v);
        v
    }

    #[test]
    fn oem_alias_part_stores_canonical_display() {
        // Titles say "Action" or "Lionel", never "Action / Lionel" — either
        // part must land on the canonical combined display.
        let d = detect("2004 Action Kasey Kahne #9 Mopar 1/24", None, &vocab());
        assert_eq!(d.oem.as_deref(), Some("Action / Lionel"));
        let d = detect("2013 Lionel 1/24 Dale Earnhardt Jr #88", None, &vocab());
        assert_eq!(d.oem.as_deref(), Some("Action / Lionel"));
    }

    #[test]
    fn other_option_and_generic_slash_parts_never_match() {
        // "Other" is excluded from every field, and make/finish slash
        // displays don't get alias parts — a bare "truck" title token must
        // not set make.
        let d = detect("some other 1/24 truck diecast", None, &vocab());
        assert_eq!(d.oem, None);
        assert_eq!(d.make, None);
    }

    #[test]
    fn detects_all_fields_from_typical_title() {
        let d = detect(
            "2002 Jeff Gordon #24 Pepsi Daytona 1:24 Action ARC Color Chrome CWC",
            None,
            &vocab(),
        );
        assert_eq!(d.oem.as_deref(), Some("Action / Lionel"));
        assert_eq!(d.brand.as_deref(), Some("ARC"));
        assert_eq!(d.finish.as_deref(), Some("Color Chrome"));
        assert_eq!(d.make.as_deref(), Some("CWC"));
        assert!(!d.race_win);
        assert!(!d.autographed);
    }

    #[test]
    fn longest_phrase_wins_over_substring_option() {
        // "Color Chrome" must not land on the bare "Chrome" option.
        let d = detect("Elite 1:24 Color Chrome bank", None, &vocab());
        assert_eq!(d.finish.as_deref(), Some("Color Chrome"));
        // But a plain chrome title still hits "Chrome".
        let d = detect("1:24 chrome elite", None, &vocab());
        assert_eq!(d.finish.as_deref(), Some("Chrome"));
    }

    #[test]
    fn win_token_sets_race_win_but_winners_circle_does_not() {
        let d = detect("1998 Jeff Gordon Brickyard Win 1:24 Elite", None, &vocab());
        assert!(d.race_win);
        let d = detect(
            "Dale Earnhardt DAYTONA 500 WINNER 1998 1/18",
            None,
            &vocab(),
        );
        assert!(d.race_win);
        let d = detect("1998 Winners Circle 1:24 Jeff Gordon", None, &vocab());
        assert!(!d.race_win);
        assert_eq!(d.oem.as_deref(), Some("Winners Circle"));
    }

    #[test]
    fn autograph_variants_and_word_boundaries() {
        assert!(detect("Autographed 1:24 CWB", None, &vocab()).autographed);
        assert!(detect("signed by Jeff Gordon", None, &vocab()).autographed);
        // "designed" must not trigger via substring.
        assert!(!detect("newly designed body", None, &vocab()).autographed);
    }

    #[test]
    fn make_codes_are_case_insensitive() {
        let d = detect("1:24 bwb liquid color", None, &vocab());
        assert_eq!(d.make.as_deref(), Some("BWB"));
        assert_eq!(d.finish.as_deref(), Some("Liquid Color"));
    }

    #[test]
    fn phrase_tokens_must_be_consecutive() {
        // "Color ... Chrome" split apart is not a "Color Chrome" hit; the
        // bare "Chrome" option still matches its own token.
        let d = detect("red color paint with Chrome wheels", None, &vocab());
        assert_eq!(d.finish.as_deref(), Some("Chrome"));
    }

    #[test]
    fn empty_title_detects_nothing() {
        assert_eq!(detect("", None, &vocab()), Detected::default());
    }
}
