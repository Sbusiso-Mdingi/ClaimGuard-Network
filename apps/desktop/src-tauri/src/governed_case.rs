use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::{
    error::{DesktopError, DesktopResult},
    http_client::GovernedActionEnrollment,
    secure_store::SESSION_COOKIE,
};

use super::{command_result, DesktopState};

const MAX_STATE_VERSION: u32 = 2_147_483_647;
const CASE_ACTIONS: &[&str] = &[
    "begin-triage",
    "dismiss",
    "begin-monitoring",
    "open-investigation",
    "record-notice",
    "record-response-pending",
    "begin-evidence-review",
    "complete-investigation-report",
    "submit-outcome-review",
    "approve-outcome",
    "close-unsubstantiated",
    "open-appeal-or-review",
    "return-for-further-evidence",
];

fn validate_path_segment(value: &str, maximum: usize) -> DesktopResult<&str> {
    if value.is_empty()
        || value.len() > maximum
        || value.trim() != value
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
        || value.chars().any(|character| character.is_control())
    {
        return Err(DesktopError::InvalidResponse);
    }
    Ok(value)
}

fn validate_action(value: &str) -> DesktopResult<&str> {
    validate_path_segment(value, 64)?;
    if CASE_ACTIONS.contains(&value) {
        Ok(value)
    } else {
        Err(DesktopError::InvalidResponse)
    }
}

fn validate_stable_code(value: &str, maximum: usize) -> DesktopResult<()> {
    let mut characters = value.chars();
    let first = characters.next().ok_or(DesktopError::InvalidResponse)?;
    if value.len() > maximum
        || !first.is_ascii_alphanumeric()
        || characters.any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-'))
        })
    {
        return Err(DesktopError::InvalidResponse);
    }
    Ok(())
}

fn validate_text(value: &str, maximum: usize) -> DesktopResult<()> {
    if value.trim().is_empty() || value.len() > maximum || value.chars().any(|value| value == '\0') {
        return Err(DesktopError::InvalidResponse);
    }
    Ok(())
}

fn validate_optional_text(value: Option<&String>, maximum: usize) -> DesktopResult<()> {
    if let Some(value) = value {
        validate_text(value, maximum)?;
    }
    Ok(())
}

fn validate_references(values: Option<&Vec<String>>, maximum_count: usize) -> DesktopResult<()> {
    if let Some(values) = values {
        if values.len() > maximum_count {
            return Err(DesktopError::InvalidResponse);
        }
        for value in values {
            validate_text(value, 255)?;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IdentityMatchReviewInput {
    reviewed: bool,
    result_code: String,
    review_reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GovernedCaseActionRequest {
    expected_state_version: u32,
    reason_code: String,
    reason_summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence_references: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_check_references: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assigned_investigator_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report_reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    no_evidence_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completion_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recorded_reasons: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity_match_review_result: Option<IdentityMatchReviewInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supporting_report_reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence_set_reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_check_complete: Option<bool>,
}

impl GovernedCaseActionRequest {
    fn validate(&self) -> DesktopResult<()> {
        if self.expected_state_version == 0 || self.expected_state_version > MAX_STATE_VERSION {
            return Err(DesktopError::InvalidResponse);
        }
        validate_stable_code(&self.reason_code, 128)?;
        validate_text(&self.reason_summary, 1024)?;
        validate_references(self.evidence_references.as_ref(), 100)?;
        validate_references(self.process_check_references.as_ref(), 100)?;
        validate_optional_text(self.assigned_investigator_id.as_ref(), 255)?;
        validate_optional_text(self.report_reference.as_ref(), 255)?;
        validate_optional_text(self.report_digest.as_ref(), 255)?;
        validate_optional_text(self.no_evidence_reason.as_ref(), 1024)?;
        if let Some(value) = self.completion_reason.as_ref() {
            validate_stable_code(value, 128)?;
        }
        if let Some(value) = self.outcome_code.as_ref() {
            validate_stable_code(value, 64)?;
        }
        if let Some(values) = self.recorded_reasons.as_ref() {
            if values.is_empty() || values.len() > 20 {
                return Err(DesktopError::InvalidResponse);
            }
            for value in values {
                validate_text(value, 1024)?;
            }
        }
        if let Some(value) = self.identity_match_review_result.as_ref() {
            if !value.reviewed {
                return Err(DesktopError::InvalidResponse);
            }
            validate_stable_code(&value.result_code, 64)?;
            validate_text(&value.review_reference, 255)?;
            validate_optional_text(value.summary.as_ref(), 1024)?;
        }
        validate_optional_text(self.supporting_report_reference.as_ref(), 255)?;
        validate_optional_text(self.evidence_set_reference.as_ref(), 255)?;
        if self.process_check_complete == Some(false) {
            return Err(DesktopError::InvalidResponse);
        }
        Ok(())
    }
}

fn validate_case_detail_response(body: &Value) -> DesktopResult<()> {
    let allowed_actions = body
        .get("allowedActions")
        .and_then(Value::as_array)
        .ok_or(DesktopError::InvalidResponse)?;
    if body.get("available").and_then(Value::as_bool) != Some(true)
        || !body.get("case").is_some_and(Value::is_object)
        || allowed_actions.len() > CASE_ACTIONS.len()
        || !allowed_actions.iter().all(|value| {
            value
                .as_str()
                .is_some_and(|action| CASE_ACTIONS.contains(&action))
        })
        || !body.get("correlationId").is_some_and(Value::is_string)
    {
        return Err(DesktopError::InvalidResponse);
    }
    Ok(())
}

fn validate_action_response(body: &Value) -> DesktopResult<()> {
    if !body.get("caseId").is_some_and(Value::is_string)
        || !body.get("state").is_some_and(Value::is_string)
        || !body.get("stateVersion").is_some_and(Value::is_u64)
        || !body.get("transitionEventId").is_some_and(Value::is_string)
        || !body.get("operationId").is_some_and(Value::is_string)
        || !body.get("correlationId").is_some_and(Value::is_string)
        || !body.get("replayed").is_some_and(Value::is_boolean)
    {
        return Err(DesktopError::InvalidResponse);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn desktop_governed_case_details(
    investigation_id: String,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    command_result(
        async {
            state.require_unlocked()?;
            state.require_capability("investigations.view")?;
            let investigation_id = validate_path_segment(&investigation_id, 64)?;
            let encoded: String =
                url::form_urlencoded::byte_serialize(investigation_id.as_bytes()).collect();
            let (enrollment, signing_key, _) = state.load_enrollment()?;
            let cookie = state
                .secure_store
                .get(SESSION_COOKIE)?
                .ok_or(DesktopError::AuthenticationRequired)?;
            let cookie = std::str::from_utf8(&cookie).map_err(|_| DesktopError::CredentialStore)?;
            let response = match state
                .http
                .enrolled(
                    Method::GET,
                    &format!("/api/v1/cases/by-legacy-investigation/{encoded}"),
                    Vec::new(),
                    &enrollment,
                    &signing_key,
                    Some(cookie),
                )
                .await
            {
                Ok(response) => response,
                Err(DesktopError::NetworkUnavailable) => {
                    state.offline.store(true, std::sync::atomic::Ordering::SeqCst);
                    return Err(DesktopError::NetworkUnavailable);
                }
                Err(error) => return Err(error),
            };
            validate_case_detail_response(&response.body)?;
            state.offline.store(false, std::sync::atomic::Ordering::SeqCst);
            Ok(response.body)
        }
        .await,
    )
}

#[tauri::command]
pub(crate) async fn desktop_perform_case_action(
    case_id: String,
    action: String,
    idempotency_key: String,
    payload: GovernedCaseActionRequest,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    command_result(
        async {
            state.require_unlocked()?;
            let case_id = validate_path_segment(&case_id, 255)?;
            let action = validate_action(&action)?;
            if idempotency_key.is_empty()
                || idempotency_key.len() > 128
                || idempotency_key.chars().any(|character| character.is_control())
            {
                return Err(DesktopError::InvalidResponse);
            }
            payload.validate()?;
            let body = serde_json::to_vec(&payload).map_err(|_| DesktopError::InvalidResponse)?;
            let encoded_case: String =
                url::form_urlencoded::byte_serialize(case_id.as_bytes()).collect();
            let encoded_action: String =
                url::form_urlencoded::byte_serialize(action.as_bytes()).collect();
            let (enrollment, signing_key, _) = state.load_enrollment()?;
            let cookie = state
                .secure_store
                .get(SESSION_COOKIE)?
                .ok_or(DesktopError::AuthenticationRequired)?;
            let cookie = std::str::from_utf8(&cookie).map_err(|_| DesktopError::CredentialStore)?;
            let response = match state
                .http
                .enrolled_governed_action(
                    Method::POST,
                    &format!("/api/v1/cases/{encoded_case}/actions/{encoded_action}"),
                    body,
                    GovernedActionEnrollment {
                        enrollment: &enrollment,
                        signing_key: &signing_key,
                        session_cookie: Some(cookie),
                        idempotency_key: &idempotency_key,
                    },
                )
                .await
            {
                Ok(response) => response,
                Err(DesktopError::NetworkUnavailable) => {
                    state.offline.store(true, std::sync::atomic::Ordering::SeqCst);
                    return Err(DesktopError::NetworkUnavailable);
                }
                Err(error) => return Err(error),
            };
            validate_action_response(&response.body)?;
            state.offline.store(false, std::sync::atomic::Ordering::SeqCst);
            Ok(response.body)
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> GovernedCaseActionRequest {
        serde_json::from_value(json!({
            "expectedStateVersion": 2,
            "reasonCode": "REVIEWED_ACTION",
            "reasonSummary": "Reviewed through the governed desktop workflow."
        }))
        .unwrap()
    }

    #[test]
    fn path_segments_reject_traversal_separators_and_controls() {
        assert_eq!(validate_path_segment("investigation-1", 64).unwrap(), "investigation-1");
        for value in ["", "../case", "case/id", "case\\id", "case\nvalue", " case"] {
            assert!(validate_path_segment(value, 64).is_err(), "{value:?}");
        }
    }

    #[test]
    fn action_names_are_server_contract_values_only() {
        assert_eq!(validate_action("begin-triage").unwrap(), "begin-triage");
        assert!(validate_action("publish-registry").is_err());
        assert!(validate_action("network-notice-active").is_err());
        assert!(validate_action("begin-triage/../../publish").is_err());
    }

    #[test]
    fn typed_payload_rejects_authority_and_target_fields() {
        for field in ["targetState", "tenantId", "actorId", "role", "permissions", "status"] {
            let mut value = json!({
                "expectedStateVersion": 2,
                "reasonCode": "REVIEWED_ACTION",
                "reasonSummary": "Reviewed."
            });
            value[field] = json!("unsafe");
            assert!(serde_json::from_value::<GovernedCaseActionRequest>(value).is_err(), "{field}");
        }
    }

    #[test]
    fn typed_payload_enforces_bounded_versions_text_and_collections() {
        assert!(request().validate().is_ok());
        let mut invalid = request();
        invalid.expected_state_version = 0;
        assert!(invalid.validate().is_err());
        let mut invalid = request();
        invalid.reason_summary = "x".repeat(1025);
        assert!(invalid.validate().is_err());
        let mut invalid = request();
        invalid.evidence_references = Some(vec!["ref".into(); 101]);
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn response_validation_preserves_only_authoritative_server_actions() {
        assert!(validate_case_detail_response(&json!({
            "available": true,
            "case": { "caseId": "case-1", "currentState": "TRIAGE_PENDING", "stateVersion": 2 },
            "allowedActions": ["begin-triage"],
            "correlationId": "request-1"
        })).is_ok());
        assert!(validate_case_detail_response(&json!({
            "available": true,
            "case": { "caseId": "case-1" },
            "allowedActions": ["publish-registry"],
            "correlationId": "request-1"
        })).is_err());
    }
}
