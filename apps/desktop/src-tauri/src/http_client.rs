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
}

pub(crate) struct VersionedEnrollment<'a> {
    pub enrollment: &'a EnrollmentDocument,
    pub signing_key: &'a SigningKey,
    pub session_cookie: Option<&'a str>,
    pub expected_version: &'a str,
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
