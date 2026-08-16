//! Shared merge handling for the `registry_entries.raw_json` blob.
//!
//! Three flows write that column, and each one knows a different slice of the
//! entry:
//!
//! - [`crate::sync::dcr_collection`] parses My Garage and knows the list
//!   thumbnail (`image_url`), not the lightbox.
//! - [`crate::sync::registry_prewarm`] parses the production search and knows
//!   the same thumbnail.
//! - [`crate::sync::dcr_registry`] parses the detail page and knows the
//!   lightbox array (`photos`), not the thumbnail.
//!
//! They all used to rebuild the blob from scratch and assign it wholesale, so
//! whichever ran last decided which keys existed at all. Enriching an entry
//! deleted its `image_url`; a later garage sync deleted its `photos`. Readers
//! that only looked at one of the two keys — the wishlist did — showed a
//! thumbnail that came and went with no user action.
//!
//! The fix is that a writer contributes what it knows and leaves the rest
//! alone: [`payload`] drops the keys it has nothing to say about, and the SQL
//! fragments below merge rather than assign. Callers only need to name the
//! keys they actually parsed.

use serde_json::Value;

/// `SET` fragment for an `ON CONFLICT DO UPDATE` on `registry_entries`, where
/// the new payload arrives as `excluded.raw_json`.
///
/// The `CASE` is for rows written before this column was always valid JSON:
/// `json_patch` raises on malformed input, and `json_valid` is NULL — so also
/// falsy — for a NULL column, which covers the stub rows too.
pub const MERGE_ON_CONFLICT: &str = "raw_json = json_patch(
            CASE WHEN json_valid(registry_entries.raw_json)
                 THEN registry_entries.raw_json ELSE '{}' END,
            excluded.raw_json)";

/// `SET` fragment for a plain `UPDATE registry_entries`, with the new payload
/// bound as the next parameter.
pub const MERGE_UPDATE: &str = "raw_json = json_patch(
            CASE WHEN json_valid(raw_json) THEN raw_json ELSE '{}' END,
            ?)";

/// Serialize a writer's contribution to `raw_json`, dropping keys whose value
/// is null.
///
/// Both fragments above are RFC 7396 merge patches, where an explicit null
/// *removes* the key. That is the opposite of what a partial writer wants:
/// `json!` renders a `None` field as null, so a garage row that happens to
/// have no thumbnail would delete a good `image_url` parsed from the search
/// page. Absence has to mean "no opinion", so nulls never reach the patch.
///
/// Only the top level is stripped. Every payload here is flat — nested values
/// are leaves, like the `photos` array — and recursing would take away a
/// writer's ability to null out one field of a nested object later.
///
/// A non-object (which no caller passes) serializes unchanged; `json_patch`
/// would then replace the blob wholesale, matching the old behaviour.
pub fn payload(value: Value) -> String {
    let value = match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .collect::<serde_json::Map<_, _>>(),
        ),
        other => other,
    };
    serde_json::to_string(&value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn payload_drops_null_keys() {
        let s = payload(json!({
            "detail_url": "/diecast/123",
            "image_url": Value::Null,
            "source": "collection_page",
        }));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["detail_url"], "/diecast/123");
        assert_eq!(v["source"], "collection_page");
        assert!(
            v.get("image_url").is_none(),
            "a null must be absent, not present-and-null: as a merge patch it \
             would delete the existing value"
        );
    }

    #[test]
    fn payload_keeps_empty_collections() {
        // A detail page that genuinely has no photos is information, and
        // should replace a stale array rather than be treated as silence.
        let s = payload(json!({ "photos": [] }));
        assert_eq!(s, r#"{"photos":[]}"#);
    }

    #[test]
    fn payload_leaves_nested_nulls_alone() {
        let s = payload(json!({ "seq": { "sequence": Value::Null } }));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert!(v["seq"].get("sequence").is_some());
    }
}
