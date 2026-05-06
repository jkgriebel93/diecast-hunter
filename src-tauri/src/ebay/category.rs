//! Heuristics for deciding whether an eBay listing is a diecast.
//!
//! Most NASCAR diecast listings live under "Toys & Hobbies > Diecast & Toy
//! Vehicles > ...". A simple substring check on the categoryPath catches
//! the bulk of them; the rare false negatives can be saved manually with
//! the filter setting turned off.

pub fn is_diecast(category_path: Option<&str>) -> bool {
    let p = match category_path {
        Some(s) if !s.trim().is_empty() => s.to_lowercase(),
        _ => return false, // no category data → conservative: reject
    };
    // Positive signals — any one of these is enough.
    p.contains("diecast")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nascar_diecast_path_passes() {
        assert!(is_diecast(Some(
            "Toys & Hobbies|Diecast & Toy Vehicles|Cars: Racing, NASCAR|Sport & Touring Cars"
        )));
    }

    #[test]
    fn lowercase_input_passes() {
        assert!(is_diecast(Some("diecast vehicles")));
    }

    #[test]
    fn unrelated_category_rejected() {
        assert!(!is_diecast(Some(
            "Sports Mem, Cards & Fan Shop|Autographs-Original|Racing-NASCAR"
        )));
    }

    #[test]
    fn empty_or_missing_rejected() {
        assert!(!is_diecast(None));
        assert!(!is_diecast(Some("")));
        assert!(!is_diecast(Some("   ")));
    }
}
