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
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
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

    #[test]
    fn governed_idempotency_keys_are_narrow_and_header_safe() {
        assert_eq!(
            validated_idempotency_key("550e8400-e29b-41d4-a716-446655440000")
                .unwrap()
                .to_str()
                .unwrap(),
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert!(validated_idempotency_key("").is_err());
        assert!(validated_idempotency_key(&"a".repeat(129)).is_err());
        assert!(validated_idempotency_key("key\r\nX-Unsafe: value").is_err());
    }
}
