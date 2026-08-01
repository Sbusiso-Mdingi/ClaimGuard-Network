use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{DesktopError, DesktopResult};

const ACTIVATION_ORIGIN: Option<&str> = option_env!("CLAIMGUARD_ACTIVATION_ORIGIN");
const ENROLLMENT_VERIFYING_JWK: Option<&str> = option_env!("CLAIMGUARD_ENROLLMENT_VERIFYING_JWK");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PublicJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    #[serde(default)]
    pub kid: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Confirmation {
    pub jkt: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentDocument {
    pub iss: String,
    pub aud: String,
    pub iat: i64,
    pub exp: i64,
    pub organisation_id: String,
    pub organisation_display_name: String,
    pub organisation_slug: String,
    pub device_enrollment_id: String,
    pub permitted_api_origin: String,
    pub environment: String,
    pub licence_expires_at: String,
    pub offline_grace_expires_at: String,
    pub signing_key_id: String,
    pub document_version: u32,
    pub cnf: Confirmation,
}

#[derive(Debug, Deserialize)]
struct EnrollmentHeader {
    alg: String,
    typ: String,
    kid: String,
}

pub fn trusted_configuration() -> DesktopResult<(String, PublicJwk)> {
    let origin = ACTIVATION_ORIGIN
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(DesktopError::BuildConfiguration)?;
    let parsed = url::Url::parse(origin).map_err(|_| DesktopError::BuildConfiguration)?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "https" && !local {
        return Err(DesktopError::BuildConfiguration);
    }
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(DesktopError::BuildConfiguration);
    }
    let jwk = serde_json::from_str::<PublicJwk>(
        ENROLLMENT_VERIFYING_JWK.ok_or(DesktopError::BuildConfiguration)?,
    )
    .map_err(|_| DesktopError::BuildConfiguration)?;
    validate_public_jwk(&jwk)?;
    Ok((parsed.origin().ascii_serialization(), jwk))
}

fn validate_public_jwk(jwk: &PublicJwk) -> DesktopResult<()> {
    if jwk.kty != "OKP" || jwk.crv != "Ed25519" {
        return Err(DesktopError::EnrollmentInvalid);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(&jwk.x)
        .map_err(|_| DesktopError::EnrollmentInvalid)?;
    if bytes.len() != 32 {
        return Err(DesktopError::EnrollmentInvalid);
    }
    Ok(())
}

pub fn public_jwk(signing_key: &SigningKey) -> PublicJwk {
    PublicJwk {
        kty: "OKP".into(),
        crv: "Ed25519".into(),
        x: URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes()),
        kid: None,
    }
}

pub fn public_key_thumbprint(jwk: &PublicJwk) -> String {
    let canonical = format!(
        "{{\"crv\":\"{}\",\"kty\":\"{}\",\"x\":\"{}\"}}",
        jwk.crv, jwk.kty, jwk.x
    );
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

pub fn verify_enrollment(
    compact: &str,
    trusted_jwk: &PublicJwk,
    expected_origin: &str,
    expected_device_thumbprint: &str,
) -> DesktopResult<EnrollmentDocument> {
    validate_public_jwk(trusted_jwk)?;
    let segments: Vec<&str> = compact.split('.').collect();
    if segments.len() != 3
        || segments
            .iter()
            .any(|part| part.is_empty() || part.len() > 16_384)
    {
        return Err(DesktopError::EnrollmentInvalid);
    }
    let header: EnrollmentHeader = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(segments[0])
            .map_err(|_| DesktopError::EnrollmentInvalid)?,
    )
    .map_err(|_| DesktopError::EnrollmentInvalid)?;
    if header.alg != "EdDSA" || header.typ != "claimguard-enrollment+jwt" {
        return Err(DesktopError::EnrollmentInvalid);
    }
    if trusted_jwk
        .kid
        .as_deref()
        .is_some_and(|kid| kid != header.kid)
    {
        return Err(DesktopError::EnrollmentInvalid);
    }
    let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(&trusted_jwk.x)
        .map_err(|_| DesktopError::EnrollmentInvalid)?
        .try_into()
        .map_err(|_| DesktopError::EnrollmentInvalid)?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| DesktopError::EnrollmentInvalid)?;
    let signature = Signature::from_slice(
        &URL_SAFE_NO_PAD
            .decode(segments[2])
            .map_err(|_| DesktopError::EnrollmentInvalid)?,
    )
    .map_err(|_| DesktopError::EnrollmentInvalid)?;
    key.verify(
        format!("{}.{}", segments[0], segments[1]).as_bytes(),
        &signature,
    )
    .map_err(|_| DesktopError::EnrollmentInvalid)?;
    let document: EnrollmentDocument = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(segments[1])
            .map_err(|_| DesktopError::EnrollmentInvalid)?,
    )
    .map_err(|_| DesktopError::EnrollmentInvalid)?;
    if document.iss != "claimguard-control-plane"
        || document.aud != "claimguard-desktop"
        || document.signing_key_id != header.kid
        || document.permitted_api_origin != expected_origin
        || document.cnf.jkt != expected_device_thumbprint
        || document.organisation_id.is_empty()
        || document.device_enrollment_id.is_empty()
        || document.document_version == 0
    {
        return Err(DesktopError::EnrollmentInvalid);
    }
    let now = Utc::now().timestamp();
    if document.iat > now + 300 || document.exp <= now {
        return Err(DesktopError::EnrollmentExpired);
    }
    DateTime::parse_from_rfc3339(&document.licence_expires_at)
        .map_err(|_| DesktopError::EnrollmentInvalid)?;
    DateTime::parse_from_rfc3339(&document.offline_grace_expires_at)
        .map_err(|_| DesktopError::EnrollmentInvalid)?;
    Ok(document)
}

pub fn create_device_proof(
    signing_key: &SigningKey,
    device_enrollment_id: &str,
    method: &str,
    target_uri: &str,
    body: &[u8],
) -> DesktopResult<String> {
    #[derive(Serialize)]
    struct Header<'a> {
        alg: &'a str,
        typ: &'a str,
        kid: &'a str,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        device_enrollment_id: &'a str,
        iat: i64,
        jti: String,
        htm: &'a str,
        htu: &'a str,
        #[serde(rename = "body_sha256")]
        body_sha256: String,
    }
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Header {
            alg: "EdDSA",
            typ: "dpop+jwt",
            kid: device_enrollment_id,
        })
        .map_err(|_| DesktopError::InvalidResponse)?,
    );
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Payload {
            device_enrollment_id,
            iat: Utc::now().timestamp(),
            jti: uuid::Uuid::new_v4().to_string(),
            htm: method,
            htu: target_uri,
            body_sha256: URL_SAFE_NO_PAD.encode(Sha256::digest(body)),
        })
        .map_err(|_| DesktopError::InvalidResponse)?,
    );
    let input = format!("{header}.{payload}");
    let signature = signing_key.sign(input.as_bytes());
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

pub fn signing_key_from_bytes(bytes: &[u8]) -> DesktopResult<SigningKey> {
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| DesktopError::EnrollmentInvalid)?;
    Ok(SigningKey::from_bytes(&seed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;

    fn signed_enrollment(key: &SigningKey, device: &SigningKey, origin: &str) -> String {
        let jwk = public_jwk(device);
        let header = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "alg": "EdDSA", "typ": "claimguard-enrollment+jwt", "kid": "enroll-key-1"
            }))
            .unwrap(),
        );
        let now = Utc::now();
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "iss": "claimguard-control-plane",
                "aud": "claimguard-desktop",
                "iat": now.timestamp(),
                "exp": (now + chrono::Duration::days(30)).timestamp(),
                "organisationId": "org-a",
                "organisationDisplayName": "Scheme A",
                "organisationSlug": "scheme-a",
                "deviceEnrollmentId": "device-a",
                "permittedApiOrigin": origin,
                "environment": "test",
                "licenceExpiresAt": (now + chrono::Duration::days(30)).to_rfc3339(),
                "offlineGraceExpiresAt": (now + chrono::Duration::days(7)).to_rfc3339(),
                "signingKeyId": "enroll-key-1",
                "documentVersion": 1,
                "cnf": { "jkt": public_key_thumbprint(&jwk) }
            }))
            .unwrap(),
        );
        let input = format!("{header}.{payload}");
        format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).to_bytes())
        )
    }

    #[test]
    fn enrollment_is_bound_to_the_device_and_origin() {
        let enrollment_key = SigningKey::generate(&mut OsRng);
        let device_key = SigningKey::generate(&mut OsRng);
        let mut trusted = public_jwk(&enrollment_key);
        trusted.kid = Some("enroll-key-1".into());
        let compact = signed_enrollment(&enrollment_key, &device_key, "https://api.example.test");
        let thumbprint = public_key_thumbprint(&public_jwk(&device_key));
        let result =
            verify_enrollment(&compact, &trusted, "https://api.example.test", &thumbprint).unwrap();
        assert_eq!(result.organisation_id, "org-a");
        assert!(verify_enrollment(
            &compact,
            &trusted,
            "https://other.example.test",
            &thumbprint
        )
        .is_err());
    }
}
