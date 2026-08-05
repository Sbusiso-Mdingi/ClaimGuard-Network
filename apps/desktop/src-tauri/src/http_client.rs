use ed25519_dalek::SigningKey;
use reqwest::{header, Method};
use serde_json::Value;
use std::time::Duration;

use crate::{
    enrollment::{create_device_proof, EnrollmentDocument},
    error::{DesktopError, DesktopResult},
};

pub struct HttpResponse {
    pub body: Value,
    pub session_cookie: Option<String>,
}

struct EnrolledSecurity<'a> {
    enrollment: &'a EnrollmentDocument,
    signing_key: &'a SigningKey,
    session_cookie: Option<&'a str>,
    expected_version: Option<&'a str>,
    idempotency_key: Option<&'a str>,
}

pub(crate) struct VersionedEnrollment<'a> {
    pub enrollment: &'a EnrollmentDocument,
    pub signing_key: &'a SigningKey,
    pub session_cookie: Option<&'a str>,
    pub expected_version: &'a str,
}

pub(crate) struct GovernedActionEnrollment<'a> {
    pub enrollment: &'a EnrollmentDocument,
    pub signing_key: &'a SigningKey,
    pub session_cookie: Option<&'a str>,
    pub idempotency_key: &'a str,
}

fn validated_idempotency_key(value: &str) -> DesktopResult<header::HeaderValue> {
    if value.is_empty()
        || value.len() > 128
        || value.chars().any(|character| character.is_control())
    {
        return Err(DesktopError::InvalidResponse);
    }
    header::HeaderValue::from_str(value).map_err(|_| DesktopError::InvalidResponse)
}

#[derive(Clone)]
pub struct DesktopHttpClient {
    client: reqwest::Client,
    origin: String,
}

impl DesktopHttpClient {
    pub fn new(origin: String) -> DesktopResult<Self> {
        Self::with_timeout(origin, Duration::from_secs(30))
    }

    fn with_timeout(origin: String, timeout: Duration) -> DesktopResult<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .user_agent(concat!("ClaimGuard-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| DesktopError::BuildConfiguration)?;
        Ok(Self { client, origin })
    }

    pub async fn activate(&self, body: Vec<u8>) -> DesktopResult<HttpResponse> {
        self.send(Method::POST, "/desktop/activate", body, None)
            .await
    }

    pub async fn enrolled(
        &self,
        method: Method,
        path_and_query: &str,
        body: Vec<u8>,
        enrollment: &EnrollmentDocument,
        signing_key: &SigningKey,
        session_cookie: Option<&str>,
    ) -> DesktopResult<HttpResponse> {
        self.send(
            method,
            path_and_query,
            body,
            Some(EnrolledSecurity {
                enrollment,
                signing_key,
                session_cookie,
                expected_version: None,
                idempotency_key: None,
            }),
        )
        .await
    }

    pub async fn enrolled_versioned(
        &self,
        method: Method,
        path_and_query: &str,
        body: Vec<u8>,
        versioned: VersionedEnrollment<'_>,
    ) -> DesktopResult<HttpResponse> {
        self.send(
            method,
            path_and_query,
            body,
            Some(EnrolledSecurity {
                enrollment: versioned.enrollment,
                signing_key: versioned.signing_key,
                session_cookie: versioned.session_cookie,
                expected_version: Some(versioned.expected_version),
                idempotency_key: None,
            }),
        )
        .await
    }

    pub async fn enrolled_governed_action(
        &self,
        method: Method,
        path_and_query: &str,
        body: Vec<u8>,
        governed: GovernedActionEnrollment<'_>,
    ) -> DesktopResult<HttpResponse> {
        validated_idempotency_key(governed.idempotency_key)?;
        self.send(
            method,
            path_and_query,
            body,
            Some(EnrolledSecurity {
                enrollment: governed.enrollment,
                signing_key: governed.signing_key,
                session_cookie: governed.session_cookie,
                expected_version: None,
                idempotency_key: Some(governed.idempotency_key),
            }),
        )
        .await
    }

    async fn send(
        &self,
        method: Method,
        path_and_query: &str,
        body: Vec<u8>,
        security: Option<EnrolledSecurity<'_>>,
    ) -> DesktopResult<HttpResponse> {
        if !path_and_query.starts_with('/') || path_and_query.starts_with("//") {
            return Err(DesktopError::BuildConfiguration);
        }
        let url = format!("{}{}", self.origin, path_and_query);
        let parsed = url::Url::parse(&url).map_err(|_| DesktopError::BuildConfiguration)?;
        if parsed.origin().ascii_serialization() != self.origin {
            return Err(DesktopError::BuildConfiguration);
        }
        let mut request = self
            .client
            .request(method.clone(), parsed.clone())
            .header(header::ACCEPT, "application/json")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(security) = &security {
            let htu = format!("{}{}", self.origin, parsed.path());
            request = request.header(
                "DPoP",
                create_device_proof(
                    security.signing_key,
                    &security.enrollment.device_enrollment_id,
                    method.as_str(),
                    &htu,
                    &body,
                )?,
            );
        }
        if let Some(cookie) = security.as_ref().and_then(|value| value.session_cookie) {
            request = request.header(header::COOKIE, cookie);
        }
        if let Some(version) = security.as_ref().and_then(|value| value.expected_version) {
            request = request.header(header::IF_MATCH, version);
        }
        if let Some(key) = security.as_ref().and_then(|value| value.idempotency_key) {
            request = request.header("Idempotency-Key", validated_idempotency_key(key)?);
        }
        if !body.is_empty() {
            request = request.body(body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| DesktopError::NetworkUnavailable)?;
        let status = response.status();
        let session_cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .filter(|value| value.contains('=') && value.len() <= 8192)
            .map(str::to_owned);
        let bytes = response
            .bytes()
            .await
            .map_err(|_| DesktopError::InvalidResponse)?;
        let body =
            serde_json::from_slice::<Value>(&bytes).map_err(|_| DesktopError::InvalidResponse)?;
        if !status.is_success() {
            let message = body
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The ClaimGuard service rejected the request.")
                .to_string();
            return Err(DesktopError::ServerRejected(format!(
                "{}:{}",
                body.get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("REQUEST_REJECTED"),
                message
            )));
        }
        Ok(HttpResponse {
            body,
            session_cookie,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use crate::enrollment::Confirmation;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::mpsc,
        thread,
    };

    fn enrollment(origin: &str) -> EnrollmentDocument {
        EnrollmentDocument {
            iss: "claimguard-control-plane".into(),
            aud: "claimguard-desktop".into(),
            iat: 1,
            exp: i64::MAX,
            organisation_id: "org-a".into(),
            organisation_display_name: "Scheme A".into(),
            organisation_slug: "scheme-a".into(),
            device_enrollment_id: "11111111-1111-4111-8111-111111111111".into(),
            permitted_api_origin: origin.into(),
            environment: "test".into(),
            licence_expires_at: "2099-01-01T00:00:00Z".into(),
            offline_grace_expires_at: "2099-01-01T00:00:00Z".into(),
            signing_key_id: "key-1".into(),
            document_version: 1,
            cnf: Confirmation { jkt: "thumbprint".into() },
        }
    }

    fn read_request(mut stream: &TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        let mut expected = None;
        loop {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 { break; }
            bytes.extend_from_slice(&chunk[..read]);
            if expected.is_none() {
                if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index + 4]);
                    let length = headers.lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(str::trim).and_then(|value| value.parse::<usize>().ok()))
                        .unwrap_or(0);
                    expected = Some(index + 4 + length);
                }
            }
            if expected.is_some_and(|length| bytes.len() >= length) { break; }
        }
        String::from_utf8(bytes).unwrap()
    }

    fn mock_server(status: &str, body: &str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        let status = status.to_owned();
        let body = body.to_owned();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&stream);
            sender.send(request).unwrap();
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            ).unwrap();
        });
        (format!("http://{address}"), receiver)
    }

    fn header_values<'a>(request: &'a str, name: &str) -> Vec<&'a str> {
        request.lines().filter_map(|line| {
            let (header_name, value) = line.split_once(':')?;
            header_name.eq_ignore_ascii_case(name).then_some(value.trim())
        }).collect()
    }

    fn proof_payload(request: &str) -> Value {
        let proof = header_values(request, "dpop").into_iter().next().unwrap();
        let encoded = proof.split('.').nth(1).unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
    }

    #[test]
    fn governed_idempotency_keys_are_narrow_and_header_safe() {
        assert_eq!(
            validated_idempotency_key("550e8400-e29b-41d4-a716-446655440000")
                .unwrap()
                .to_str()
                .unwrap(),
            "550e8400-e29b-41d4-a716-446655440000"
        );
        for value in ["", "key\rvalue", "key\nvalue", "key\u{0000}value", "key\u{007f}value"] {
            assert!(validated_idempotency_key(value).is_err(), "{value:?}");
        }
        assert!(validated_idempotency_key(&"a".repeat(129)).is_err());
    }

    #[test]
    fn governed_case_detail_get_preserves_cookie_and_exact_proof_target() {
        let response = json!({"available":true,"case":{"caseId":"case-1"},"allowedActions":[],"correlationId":"request-1"}).to_string();
        let (origin, captured) = mock_server("200 OK", &response);
        let client = DesktopHttpClient::new(origin.clone()).unwrap();
        let enrollment = enrollment(&origin);
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let result = tauri::async_runtime::block_on(client.enrolled(
            Method::GET,
            "/api/v1/cases/by-legacy-investigation/investigation-1",
            Vec::new(),
            &enrollment,
            &key,
            Some("cg_session_local=session-value"),
        )).unwrap();
        assert_eq!(result.body["case"]["caseId"], "case-1");
        let request = captured.recv().unwrap();
        assert!(request.starts_with("GET /api/v1/cases/by-legacy-investigation/investigation-1 HTTP/1.1\r\n"));
        assert_eq!(header_values(&request, "cookie"), ["cg_session_local=session-value"]);
        assert_eq!(header_values(&request, "dpop").len(), 1);
        assert!(header_values(&request, "idempotency-key").is_empty());
        assert!(header_values(&request, "if-match").is_empty());
        assert_eq!(request.split("\r\n\r\n").nth(1).unwrap_or(""), "");
        let proof = proof_payload(&request);
        assert_eq!(proof["htm"], "GET");
        assert_eq!(proof["htu"], format!("{origin}/api/v1/cases/by-legacy-investigation/investigation-1"));
        assert_eq!(proof["body_sha256"], URL_SAFE_NO_PAD.encode(Sha256::digest([])));
        assert!(header_values(&request, "x-renderer-header").is_empty());
    }

    #[test]
    fn governed_action_posts_exact_body_and_one_specialized_header() {
        let response = json!({"caseId":"case-1","state":"TRIAGE_ACTIVE","stateVersion":3,"transitionEventId":"event-1","operationId":"operation-1","correlationId":"request-1","replayed":false}).to_string();
        let (origin, captured) = mock_server("201 Created", &response);
        let client = DesktopHttpClient::new(origin.clone()).unwrap();
        let enrollment = enrollment(&origin);
        let key = SigningKey::from_bytes(&[8_u8; 32]);
        let body = br#"{"expectedStateVersion":2,"reasonCode":"REVIEWED","reasonSummary":"Reviewed."}"#.to_vec();
        tauri::async_runtime::block_on(client.enrolled_governed_action(
            Method::POST,
            "/api/v1/cases/case-1/actions/begin-triage",
            body.clone(),
            GovernedActionEnrollment {
                enrollment: &enrollment,
                signing_key: &key,
                session_cookie: Some("cg_session_local=session-value"),
                idempotency_key: "550e8400-e29b-41d4-a716-446655440000",
            },
        )).unwrap();
        let request = captured.recv().unwrap();
        assert!(request.starts_with("POST /api/v1/cases/case-1/actions/begin-triage HTTP/1.1\r\n"));
        assert_eq!(header_values(&request, "content-type"), ["application/json"]);
        assert_eq!(header_values(&request, "cookie"), ["cg_session_local=session-value"]);
        assert_eq!(header_values(&request, "idempotency-key"), ["550e8400-e29b-41d4-a716-446655440000"]);
        assert_eq!(header_values(&request, "dpop").len(), 1);
        assert!(header_values(&request, "if-match").is_empty());
        assert_eq!(request.split("\r\n\r\n").nth(1).unwrap().as_bytes(), body);
        let proof = proof_payload(&request);
        assert_eq!(proof["htm"], "POST");
        assert_eq!(proof["htu"], format!("{origin}/api/v1/cases/case-1/actions/begin-triage"));
        assert_eq!(proof["body_sha256"], URL_SAFE_NO_PAD.encode(Sha256::digest(&body)));
        let body_value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body_value["expectedStateVersion"], 2);
        for prohibited in ["targetState", "toState", "tenantId", "actorId", "role", "permissions", "status"] {
            assert!(body_value.get(prohibited).is_none(), "{prohibited}");
        }
    }

    #[test]
    fn stable_server_codes_survive_without_sensitive_response_echo() {
        for code in ["CASE_STATE_VERSION_CONFLICT", "CASE_NOT_FOUND", "CASE_ROLE_NOT_AUTHORISED", "NETWORK_NOTICE_GOVERNANCE_REQUIRED"] {
            let response = json!({"code":code,"message":"Safe rejection."}).to_string();
            let (origin, _) = mock_server("409 Conflict", &response);
            let client = DesktopHttpClient::new(origin.clone()).unwrap();
            let enrollment = enrollment(&origin);
            let key = SigningKey::from_bytes(&[9_u8; 32]);
            let error = tauri::async_runtime::block_on(client.enrolled(
                Method::GET, "/api/v1/cases/case-1", Vec::new(), &enrollment, &key, Some("secret-cookie"),
            )).unwrap_err();
            match error {
                DesktopError::ServerRejected(value) => {
                    assert_eq!(value, format!("{code}:Safe rejection."));
                    assert!(!value.contains("secret-cookie"));
                    assert!(!value.contains("dpop"));
                }
                other => panic!("unexpected error: {other:?}"),
            }
        }
    }

    #[test]
    fn malformed_empty_network_and_timeout_fail_safely() {
        for body in ["not-json", ""] {
            let (origin, _) = mock_server("200 OK", body);
            let client = DesktopHttpClient::new(origin).unwrap();
            let error = tauri::async_runtime::block_on(client.activate(Vec::new())).unwrap_err();
            assert!(matches!(error, DesktopError::InvalidResponse));
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let client = DesktopHttpClient::new(origin).unwrap();
        let error = tauri::async_runtime::block_on(client.activate(Vec::new())).unwrap_err();
        assert!(matches!(error, DesktopError::NetworkUnavailable));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _ = read_request(&stream);
            thread::sleep(Duration::from_millis(100));
        });
        let client = DesktopHttpClient::with_timeout(origin, Duration::from_millis(20)).unwrap();
        let error = tauri::async_runtime::block_on(client.activate(Vec::new())).unwrap_err();
        assert!(matches!(error, DesktopError::NetworkUnavailable));
    }
}
