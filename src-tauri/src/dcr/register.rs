//! Add-to-My-Garage flow for diecastregistry.com.
//!
//! Two-step roundtrip mirroring `production_search`:
//!   1. GET /MyGarage/RegisterDiecast/<guid> — returns the modal form fragment
//!      carrying the per-request __RequestVerificationToken. The presence of
//!      an input named `ChassisNumber` tells us whether the diecast is
//!      sequentially numbered (those need a DIN) or NSN.
//!   2. POST /MyGarage/RegisterDiecast/<guid> with the form-encoded body. On
//!      success the server replies with a JSON envelope
//!      `{"success": true, "title": "...", "html": "<...>"}`,
//!      where `html` embeds the freshly-assigned DCR registration number
//!      (e.g. "000-429-522") and a `/MyGarage?id=429522` deep link.

use once_cell::sync::Lazy;
use regex::Regex;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

use crate::dcr::client::extract_form_token;
use crate::dcr::DcrClient;
use crate::error::{AppError, AppResult};

/// Condition options the DCR registration form offers. The GUIDs are the
/// `<option value="…">` values; they are stable across users and diecasts
/// (verified empirically), so we hardcode them here rather than re-fetching.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    Mint,
    Excellent,
    VeryGood,
    Good,
    Average,
    BelowAverage,
    New,
}

impl Condition {
    pub fn as_guid(self) -> &'static str {
        match self {
            Self::Mint => "c84378d8-1ee5-4c24-a432-fe54397cb7d1",
            Self::Excellent => "65f9215a-7d09-48f4-b603-3f11f337d823",
            Self::VeryGood => "d10edcc7-6bab-476f-be81-74384e5ce9ab",
            Self::Good => "184f0a77-9608-42e0-9209-6f3cbe5b5803",
            Self::Average => "a27aaf01-c0c3-44b0-a67d-5879942c0e2e",
            Self::BelowAverage => "05030c2c-4d3e-494a-a586-57cd96ef7af6",
            Self::New => "03ca91c4-3fd2-4eee-9800-37ceffd8d268",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RegisterDiecastInput {
    /// The registry GUID from /MyGarage/RegisterDiecast/<guid>.
    pub registry_guid: String,
    pub condition: Condition,
    #[serde(default)]
    pub autographed: bool,
    #[serde(default)]
    pub prototype: bool,
    /// Required for sequentially-numbered diecasts unless `prototype` is true.
    /// Ignored for NSN items.
    #[serde(default)]
    pub chassis_number: Option<u32>,
    #[serde(default)]
    pub comments: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegisterDiecastResult {
    /// e.g. "000-429-522".
    pub registration_number: String,
    /// Integer derived from `registration_number` — matches DCR's
    /// `/MyGarage?id=…` deep link param and our `registry_int_id` column.
    pub registry_int_id: i64,
}

pub async fn register_diecast(
    client: &DcrClient,
    input: &RegisterDiecastInput,
) -> AppResult<RegisterDiecastResult> {
    if !is_registry_guid(&input.registry_guid) {
        return Err(AppError::Parse(format!(
            "not a valid registry GUID: {}",
            input.registry_guid
        )));
    }

    let path = format!("/MyGarage/RegisterDiecast/{}", input.registry_guid);

    let form_html = client.get_html_xhr(&path).await.map_err(|e| match e {
        AppError::Network(msg) => {
            AppError::Network(format!("GET register-diecast form failed ({path}): {msg}"))
        }
        other => other,
    })?;

    if !looks_like_register_form(&form_html) {
        // Most likely cause: GET silently redirected to a login or error page
        // because of session/cookie state. Surface that explicitly so we don't
        // POST a stale token.
        let excerpt = form_html
            .chars()
            .take(300)
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return Err(AppError::Parse(format!(
            "GET {path} did not return a register-diecast form. \
             First 300 chars: {excerpt}"
        )));
    }

    let token = extract_form_token(&form_html).ok_or_else(|| {
        AppError::Parse("no anti-forgery token on register-diecast form (not logged in?)".into())
    })?;
    let is_sequentially_numbered = form_has_chassis_input(&form_html);
    tracing::debug!(
        "register_diecast: token len={}, sequentially_numbered={}",
        token.len(),
        is_sequentially_numbered
    );

    if is_sequentially_numbered && !input.prototype && input.chassis_number.is_none() {
        return Err(AppError::Parse(
            "chassis_number is required for sequentially-numbered diecasts \
             unless marked as a prototype"
                .into(),
        ));
    }

    let form = build_form(&token, input, is_sequentially_numbered);
    let body = client.post_form(&path, &form).await.map_err(|e| match e {
        AppError::Network(msg) => {
            AppError::Network(format!("POST register-diecast failed ({path}): {msg}"))
        }
        other => other,
    })?;
    parse_register_response(&body)
}

/// Verifies the GET response actually contained the register-diecast form
/// (and not, say, a redirected login page or an error fragment). Catches
/// session-expiry and "this diecast isn't registerable for you" edge cases
/// before we POST a token that won't match.
fn looks_like_register_form(html: &str) -> bool {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(r#"form#register-diecast-form"#).unwrap();
    doc.select(&sel).next().is_some()
}

static REGISTRY_GUID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});

fn is_registry_guid(s: &str) -> bool {
    REGISTRY_GUID_RE.is_match(s)
}

pub(crate) fn form_has_chassis_input(html: &str) -> bool {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(r#"input[name="ChassisNumber"]"#).unwrap();
    doc.select(&sel).next().is_some()
}

pub(crate) fn build_form(
    token: &str,
    input: &RegisterDiecastInput,
    is_sequentially_numbered: bool,
) -> Vec<(String, String)> {
    let mut form = Vec::with_capacity(9);
    form.push(("__RequestVerificationToken".into(), token.to_string()));
    form.push(("ConditionId".into(), input.condition.as_guid().into()));
    form.push((
        "IsAutographed".into(),
        bool_to_pascal(input.autographed).into(),
    ));
    form.push(("IsPrototype".into(), bool_to_pascal(input.prototype).into()));
    if is_sequentially_numbered {
        // Browser submits empty `ChassisNumber` when prototype=True, so
        // mirror that rather than omitting the field entirely.
        let chassis = match input.chassis_number {
            Some(n) if !input.prototype => n.to_string(),
            _ => String::new(),
        };
        form.push(("ChassisNumber".into(), chassis));
        form.push(("_chassis".into(), String::new()));
    }
    // For-sale flow is gated server-side on having a complete profile, and
    // we don't surface it in the UI yet — send empty strings to match what
    // the browser posts when IsForSale is disabled.
    form.push(("AskingPrice".into(), String::new()));
    form.push(("Shipping".into(), String::new()));
    form.push(("Details".into(), input.comments.clone().unwrap_or_default()));
    form
}

fn bool_to_pascal(b: bool) -> &'static str {
    if b {
        "True"
    } else {
        "False"
    }
}

#[derive(Deserialize)]
struct RegisterResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    title: String,
    #[serde(default)]
    html: String,
}

static REG_NUMBER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(\d{3}-\d{3}-\d{3})\b").unwrap());

pub(crate) fn parse_register_response(body: &str) -> AppResult<RegisterDiecastResult> {
    let envelope: RegisterResponse = serde_json::from_str(body).map_err(|e| {
        AppError::Parse(format!(
            "register-diecast response was not JSON ({e}); body starts with: {}",
            body.chars().take(120).collect::<String>()
        ))
    })?;

    if !envelope.success {
        // Best-effort message extraction. The server typically returns the
        // failure reason in `title` or as plain text inside `html`.
        let msg = if !envelope.title.is_empty() {
            envelope.title
        } else if !envelope.html.is_empty() {
            strip_tags(&envelope.html)
        } else {
            "diecastregistry.com rejected the registration".to_string()
        };
        return Err(AppError::Parse(format!("register failed: {msg}")));
    }

    let registration_number = REG_NUMBER_RE
        .captures(&envelope.html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| {
            AppError::Parse(
                "register-diecast success response did not contain a registration number".into(),
            )
        })?;

    let registry_int_id = registration_number
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse::<i64>()
        .map_err(|e| {
            AppError::Parse(format!(
                "registration number {registration_number} failed to parse as int: {e}"
            ))
        })?;

    Ok(RegisterDiecastResult {
        registration_number,
        registry_int_id,
    })
}

/// Crude HTML→text fallback used only for surfacing server error messages.
/// Drops tags, collapses whitespace.
fn strip_tags(html: &str) -> String {
    let doc = Html::parse_fragment(html);
    let text: String = doc.root_element().text().collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FORM_SEQ: &str = include_str!("../../fixtures/dcr/register_diecast_form_seq.html");
    const FORM_NSN: &str = include_str!("../../fixtures/dcr/register_diecast_form_nsn.html");
    const RESPONSE_SUCCESS: &str = include_str!("../../fixtures/dcr/register_diecast_success.json");

    #[test]
    fn detects_sequentially_numbered_form() {
        assert!(form_has_chassis_input(FORM_SEQ));
    }

    #[test]
    fn detects_nsn_form() {
        assert!(!form_has_chassis_input(FORM_NSN));
    }

    #[test]
    fn extracts_token_from_seq_form() {
        let token = extract_form_token(FORM_SEQ).expect("token present");
        assert!(token.starts_with("Ru3LyIbwt2bk"));
    }

    #[test]
    fn extracts_token_from_nsn_form() {
        let token = extract_form_token(FORM_NSN).expect("token present");
        assert!(token.starts_with("j_k5lIevhJ7"));
    }

    #[test]
    fn build_form_matches_captured_request() {
        // Matches the field order and values from the captured POST body:
        // __RequestVerificationToken=…&ConditionId=…&IsAutographed=False&IsPrototype=False
        //   &ChassisNumber=1292&_chassis=&AskingPrice=&Shipping=&Details=…
        let input = RegisterDiecastInput {
            registry_guid: "e528333c-9f35-4f80-b6f5-ccc5ce101f7e".into(),
            condition: Condition::Mint,
            autographed: false,
            prototype: false,
            chassis_number: Some(1292),
            comments: Some("This is a comment for Claude".into()),
        };
        let form = build_form("TOKEN", &input, true);
        let expected = vec![
            ("__RequestVerificationToken", "TOKEN"),
            ("ConditionId", "c84378d8-1ee5-4c24-a432-fe54397cb7d1"),
            ("IsAutographed", "False"),
            ("IsPrototype", "False"),
            ("ChassisNumber", "1292"),
            ("_chassis", ""),
            ("AskingPrice", ""),
            ("Shipping", ""),
            ("Details", "This is a comment for Claude"),
        ];
        let got: Vec<(&str, &str)> = form.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(got, expected);
    }

    #[test]
    fn build_form_omits_chassis_for_nsn() {
        let input = RegisterDiecastInput {
            registry_guid: "6286b1ca-8884-466e-943a-ddd531d992cc".into(),
            condition: Condition::Excellent,
            autographed: false,
            prototype: false,
            chassis_number: None,
            comments: None,
        };
        let form = build_form("TOKEN", &input, false);
        let names: Vec<&str> = form.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "__RequestVerificationToken",
                "ConditionId",
                "IsAutographed",
                "IsPrototype",
                "AskingPrice",
                "Shipping",
                "Details",
            ]
        );
    }

    #[test]
    fn build_form_prototype_blanks_chassis_for_seq() {
        // Even with a chassis number supplied, marking prototype=true should
        // submit it blank — the server's requiredif rule treats prototypes
        // as exempt, and the browser blanks the field when the radio flips.
        let input = RegisterDiecastInput {
            registry_guid: "e528333c-9f35-4f80-b6f5-ccc5ce101f7e".into(),
            condition: Condition::Mint,
            autographed: false,
            prototype: true,
            chassis_number: Some(99),
            comments: None,
        };
        let form = build_form("TOKEN", &input, true);
        let chassis = form
            .iter()
            .find(|(k, _)| k == "ChassisNumber")
            .map(|(_, v)| v.as_str())
            .unwrap();
        assert_eq!(chassis, "");
        let proto = form
            .iter()
            .find(|(k, _)| k == "IsPrototype")
            .map(|(_, v)| v.as_str())
            .unwrap();
        assert_eq!(proto, "True");
    }

    #[test]
    fn condition_guid_round_trip() {
        // Spot-check the seven mappings against the GUIDs we saw in the form.
        assert_eq!(
            Condition::Mint.as_guid(),
            "c84378d8-1ee5-4c24-a432-fe54397cb7d1"
        );
        assert_eq!(
            Condition::New.as_guid(),
            "03ca91c4-3fd2-4eee-9800-37ceffd8d268"
        );
        assert_eq!(
            Condition::BelowAverage.as_guid(),
            "05030c2c-4d3e-494a-a586-57cd96ef7af6"
        );
    }

    #[test]
    fn parses_success_response() {
        let result = parse_register_response(RESPONSE_SUCCESS).expect("success");
        assert_eq!(result.registration_number, "000-429-522");
        assert_eq!(result.registry_int_id, 429522);
    }

    #[test]
    fn rejects_failure_response() {
        let body = r#"{"success":false,"title":"Already registered","html":""}"#;
        let err = parse_register_response(body).unwrap_err();
        assert!(err.to_string().contains("Already registered"));
    }

    #[test]
    fn rejects_non_json_response() {
        let err = parse_register_response("<html>not json</html>").unwrap_err();
        assert!(err.to_string().contains("not JSON"));
    }

    #[test]
    fn rejects_success_without_registration_number() {
        let body = r#"{"success":true,"title":"OK","html":"<div>no number here</div>"}"#;
        let err = parse_register_response(body).unwrap_err();
        assert!(err
            .to_string()
            .contains("did not contain a registration number"));
    }

    #[test]
    fn guid_validation() {
        assert!(is_registry_guid("e528333c-9f35-4f80-b6f5-ccc5ce101f7e"));
        assert!(!is_registry_guid("not-a-guid"));
        assert!(!is_registry_guid("E528333C-9F35-4F80-B6F5-CCC5CE101F7E")); // uppercase
        assert!(!is_registry_guid(""));
    }
}
