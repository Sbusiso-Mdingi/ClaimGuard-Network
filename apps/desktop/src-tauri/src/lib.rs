mod cache;
mod enrollment;
mod error;
mod http_client;
mod secure_store;

use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

use cache::{EncryptedCache, SyncPage};
use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use enrollment::{
    public_jwk, public_key_thumbprint, signing_key_from_bytes, trusted_configuration,
    verify_enrollment, EnrollmentDocument, PublicJwk,
};
use error::{DesktopError, DesktopResult};
use http_client::DesktopHttpClient;
use rand::{rngs::OsRng, RngCore};
use reqwest::Method;
use secure_store::{
    SecureStore, CACHE_KEY, DEVICE_PRIVATE_KEY, ENROLLMENT_DOCUMENT, INSTALLATION_ID,
    SESSION_COOKIE,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Manager, State};
#[cfg(target_os = "windows")]
use tauri_plugin_updater::UpdaterExt;
use uuid::Uuid;
use zeroize::Zeroizing;

struct DesktopState {
    app_data_dir: PathBuf,
    origin: String,
    enrollment_verifying_jwk: PublicJwk,
    http: DesktopHttpClient,
    secure_store: SecureStore,
    locked: AtomicBool,
    offline: AtomicBool,
    sync_has_more: AtomicBool,
}

impl DesktopState {
    fn cache_path(&self) -> PathBuf {
        self.app_data_dir.join("claim-guard-cache.sqlite3")
    }

    fn load_enrollment(&self) -> DesktopResult<(EnrollmentDocument, SigningKey, String)> {
        let compact = self
            .secure_store
            .get(ENROLLMENT_DOCUMENT)?
            .ok_or(DesktopError::ActivationRequired)?;
        let compact = String::from_utf8(compact).map_err(|_| DesktopError::EnrollmentInvalid)?;
        let private_key = self
            .secure_store
            .get(DEVICE_PRIVATE_KEY)?
            .ok_or(DesktopError::EnrollmentInvalid)?;
        let signing_key = signing_key_from_bytes(&private_key)?;
        let thumbprint = public_key_thumbprint(&public_jwk(&signing_key));
        let document = verify_enrollment(
            &compact,
            &self.enrollment_verifying_jwk,
            &self.origin,
            &thumbprint,
        )?;
        Ok((document, signing_key, compact))
    }

    fn open_cache(&self, enrollment: &EnrollmentDocument) -> DesktopResult<EncryptedCache> {
        let key = self
            .secure_store
            .get(CACHE_KEY)?
            .ok_or(DesktopError::CacheUnavailable)?;
        EncryptedCache::open(
            &self.cache_path(),
            &key,
            &enrollment.organisation_id,
            &enrollment.device_enrollment_id,
        )
    }

    fn offline_grace_expired(enrollment: &EnrollmentDocument) -> DesktopResult<bool> {
        let expiry = DateTime::parse_from_rfc3339(&enrollment.offline_grace_expires_at)
            .map_err(|_| DesktopError::EnrollmentInvalid)?;
        Ok(expiry.timestamp() <= Utc::now().timestamp())
    }

    fn status(&self) -> DesktopResult<Value> {
        let enrollment = match self.load_enrollment() {
            Ok((document, _, _)) => document,
            Err(DesktopError::ActivationRequired) => {
                return Ok(json!({ "activationRequired": true }));
            }
            Err(error) => return Err(error),
        };
        let grace_expired = Self::offline_grace_expired(&enrollment)?;
        if grace_expired {
            self.locked.store(true, Ordering::SeqCst);
        }
        let locked = self.locked.load(Ordering::SeqCst);
        let session_exists = self.secure_store.get(SESSION_COOKIE)?.is_some();
        let authenticated = session_exists && !locked;
        let (claims, dashboard, last_sync, freshness) = if authenticated {
            let cache = self.open_cache(&enrollment)?;
            let last_sync = cache.last_successful_sync_at()?;
            let allowed_freshness = cache.claims_freshness_seconds()?;
            let freshness = if self.offline.load(Ordering::SeqCst) {
                "Offline"
            } else if last_sync
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|value| {
                    Utc::now().timestamp() - value.timestamp() <= allowed_freshness
                })
            {
                "Fresh"
            } else {
                "Stale"
            };
            (cache.claims()?, cache.dashboard()?, last_sync, freshness)
        } else {
            (Vec::new(), None, None, "Stale")
        };
        Ok(json!({
            "activationRequired": false,
            "authenticated": authenticated,
            "locked": locked,
            "lockReason": if grace_expired { Some("offline_grace_expired") } else if locked { Some("locked") } else { None },
            "enrollment": {
                "organisationId": enrollment.organisation_id,
                "organisationDisplayName": enrollment.organisation_display_name,
                "environment": enrollment.environment,
                "licenceExpiresAt": enrollment.licence_expires_at,
                "offlineGraceExpiresAt": enrollment.offline_grace_expires_at,
            },
            "cache": {
                "freshness": freshness,
                "lastSuccessfulSyncAt": last_sync,
                "claims": claims,
                "dashboard": dashboard,
            },
            "syncHasMore": self.sync_has_more.load(Ordering::SeqCst),
        }))
    }

    fn require_unlocked(&self) -> DesktopResult<()> {
        if self.locked.load(Ordering::SeqCst) {
            return Err(DesktopError::Locked);
        }
        if self.secure_store.get(SESSION_COOKIE)?.is_none() {
            return Err(DesktopError::AuthenticationRequired);
        }
        Ok(())
    }
}

fn command_result(result: DesktopResult<Value>) -> Result<Value, String> {
    result.map_err(|error| error.public_message())
}

#[tauri::command]
fn desktop_status(state: State<'_, DesktopState>) -> Result<Value, String> {
    command_result(state.status())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRequest<'a> {
    activation_key: &'a str,
    installation_id: &'a str,
    device_public_key: &'a PublicJwk,
}

#[tauri::command]
async fn activate_desktop(
    activation_key: String,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    command_result(async {
        if state.secure_store.get(ENROLLMENT_DOCUMENT)?.is_some() {
            return Err(DesktopError::ServerRejected(
                "This installation is already licensed. Use the confirmed administrative reset before changing its organisation.".into(),
            ));
        }
        let activation_key = Zeroizing::new(activation_key);
        if activation_key.len() > 256 || !activation_key.starts_with("cgak_") {
            return Err(DesktopError::ServerRejected(
                "The organisation activation key could not be verified.".into(),
            ));
        }
        let installation_id = match state.secure_store.get(INSTALLATION_ID)? {
            Some(value) => String::from_utf8(value).map_err(|_| DesktopError::CredentialStore)?,
            None => {
                let value = Uuid::new_v4().to_string();
                state.secure_store.set(INSTALLATION_ID, value.as_bytes())?;
                value
            }
        };
        let signing_key = match state.secure_store.get(DEVICE_PRIVATE_KEY)? {
            Some(value) => signing_key_from_bytes(&value)?,
            None => {
                let value = SigningKey::generate(&mut OsRng);
                state.secure_store.set(DEVICE_PRIVATE_KEY, value.as_bytes())?;
                value
            }
        };
        let device_jwk = public_jwk(&signing_key);
        let request = ActivationRequest {
            activation_key: activation_key.as_str(),
            installation_id: &installation_id,
            device_public_key: &device_jwk,
        };
        let request_bytes = Zeroizing::new(
            serde_json::to_vec(&request).map_err(|_| DesktopError::InvalidResponse)?,
        );
        let response = state.http.activate(request_bytes.to_vec()).await?;
        let compact = response
            .body
            .get("signedEnrollment")
            .and_then(Value::as_str)
            .ok_or(DesktopError::InvalidResponse)?;
        let thumbprint = public_key_thumbprint(&device_jwk);
        let document = verify_enrollment(
            compact,
            &state.enrollment_verifying_jwk,
            &state.origin,
            &thumbprint,
        )?;
        let cache_path = state.cache_path();
        for path in [
            cache_path.clone(),
            cache_path.with_extension("sqlite3-wal"),
            cache_path.with_extension("sqlite3-shm"),
        ] {
            if path.exists() {
                std::fs::remove_file(path).map_err(|_| DesktopError::CacheUnavailable)?;
            }
        }
        let mut cache_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(cache_key.as_mut());
        state.secure_store.set(CACHE_KEY, cache_key.as_ref())?;
        EncryptedCache::open(
            &state.cache_path(),
            cache_key.as_ref(),
            &document.organisation_id,
            &document.device_enrollment_id,
        )?;
        state
            .secure_store
            .set(ENROLLMENT_DOCUMENT, compact.as_bytes())?;
        state.locked.store(true, Ordering::SeqCst);
        state.offline.store(false, Ordering::SeqCst);
        state.status()
    }
    .await)
}

#[derive(Serialize)]
struct LoginRequest<'a> {
    username: &'a str,
    password: &'a str,
}

#[tauri::command]
async fn desktop_login(
    username: String,
    password: String,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    command_result(async {
        if username.trim().is_empty() || username.len() > 320 || password.len() > 4096 {
            return Err(DesktopError::ServerRejected(
                "The account could not be authorised for the organisation licensed on this device.".into(),
            ));
        }
        let password = Zeroizing::new(password);
        let (enrollment, signing_key, _) = state.load_enrollment()?;
        let body = Zeroizing::new(
            serde_json::to_vec(&LoginRequest {
                username: username.trim(),
                password: password.as_str(),
            })
            .map_err(|_| DesktopError::InvalidResponse)?,
        );
        let existing_cookie = state.secure_store.get(SESSION_COOKIE)?;
        let existing_cookie = existing_cookie
            .as_deref()
            .and_then(|value| std::str::from_utf8(value).ok());
        let response = state
            .http
            .enrolled(
                Method::POST,
                "/desktop/auth/login",
                body.to_vec(),
                &enrollment,
                &signing_key,
                existing_cookie,
            )
            .await?;
        let response_organisation = response
            .body
            .pointer("/licensedOrganisation/organisationId")
            .and_then(Value::as_str)
            .ok_or(DesktopError::InvalidResponse)?;
        if response_organisation != enrollment.organisation_id {
            return Err(DesktopError::OrganisationMismatch);
        }
        let thumbprint = public_key_thumbprint(&public_jwk(&signing_key));
        let renewed = response
            .body
            .pointer("/enrollment/signedEnrollment")
            .and_then(Value::as_str)
            .ok_or(DesktopError::InvalidResponse)?;
        let renewed_document = verify_enrollment(
            renewed,
            &state.enrollment_verifying_jwk,
            &state.origin,
            &thumbprint,
        )?;
        if renewed_document.organisation_id != enrollment.organisation_id
            || renewed_document.device_enrollment_id != enrollment.device_enrollment_id
        {
            return Err(DesktopError::OrganisationMismatch);
        }
        let session_cookie = response.session_cookie.ok_or(DesktopError::InvalidResponse)?;
        state
            .secure_store
            .set(ENROLLMENT_DOCUMENT, renewed.as_bytes())?;
        state.secure_store.set(SESSION_COOKIE, session_cookie.as_bytes())?;
        state.locked.store(false, Ordering::SeqCst);
        state.offline.store(false, Ordering::SeqCst);
        state.status()
    }
    .await)
}

#[tauri::command]
async fn desktop_logout(state: State<'_, DesktopState>) -> Result<Value, String> {
    command_result(
        async {
            if let (Ok((enrollment, signing_key, _)), Some(cookie)) = (
                state.load_enrollment(),
                state.secure_store.get(SESSION_COOKIE)?,
            ) {
                if let Ok(cookie) = std::str::from_utf8(&cookie) {
                    let _ = state
                        .http
                        .enrolled(
                            Method::POST,
                            "/desktop/auth/logout",
                            Vec::new(),
                            &enrollment,
                            &signing_key,
                            Some(cookie),
                        )
                        .await;
                }
            }
            state.secure_store.delete(SESSION_COOKIE)?;
            state.locked.store(true, Ordering::SeqCst);
            state.status()
        }
        .await,
    )
}

#[tauri::command]
fn lock_desktop(state: State<'_, DesktopState>) -> Result<Value, String> {
    state.locked.store(true, Ordering::SeqCst);
    command_result(state.status())
}

async fn request_sync_page(
    state: &DesktopState,
    enrollment: &EnrollmentDocument,
    signing_key: &SigningKey,
    cookie: &str,
    cursor: Option<&str>,
) -> DesktopResult<(SyncPage, bool)> {
    let bootstrap = cursor.is_none();
    let path = if let Some(cursor) = cursor {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("cursor", cursor)
            .append_pair("limit", "500")
            .append_pair("schemaVersion", "1")
            .finish();
        format!("/desktop/sync/changes?{query}")
    } else {
        "/desktop/sync/bootstrap?limit=500&schemaVersion=1".into()
    };
    let response = state
        .http
        .enrolled(
            Method::GET,
            &path,
            Vec::new(),
            enrollment,
            signing_key,
            Some(cookie),
        )
        .await?;
    let page = serde_json::from_value::<SyncPage>(response.body)
        .map_err(|_| DesktopError::InvalidResponse)?;
    Ok((page, bootstrap))
}

#[tauri::command]
async fn synchronize_desktop(state: State<'_, DesktopState>) -> Result<Value, String> {
    command_result(
        async {
            state.require_unlocked()?;
            let (enrollment, signing_key, _) = state.load_enrollment()?;
            let cookie = state
                .secure_store
                .get(SESSION_COOKIE)?
                .ok_or(DesktopError::AuthenticationRequired)?;
            let cookie = std::str::from_utf8(&cookie).map_err(|_| DesktopError::CredentialStore)?;
            let mut cache = state.open_cache(&enrollment)?;
            let cursor = cache.cursor()?;
            let requested =
                request_sync_page(&state, &enrollment, &signing_key, cookie, cursor.as_deref())
                    .await;
            let (page, replace_scope) = match requested {
                Ok(value) => value,
                Err(DesktopError::ServerRejected(message))
                    if message.starts_with("DESKTOP_CURSOR_EXPIRED:") =>
                {
                    request_sync_page(&state, &enrollment, &signing_key, cookie, None).await?
                }
                Err(DesktopError::NetworkUnavailable) => {
                    state.offline.store(true, Ordering::SeqCst);
                    return Err(DesktopError::NetworkUnavailable);
                }
                Err(error) => return Err(error),
            };
            if page.scope.organisation_id != enrollment.organisation_id {
                return Err(DesktopError::OrganisationMismatch);
            }
            let renewed = page
                .enrollment
                .as_ref()
                .and_then(|value| value.get("signedEnrollment"))
                .and_then(Value::as_str)
                .ok_or(DesktopError::InvalidResponse)?;
            let thumbprint = public_key_thumbprint(&public_jwk(&signing_key));
            let renewed_document = verify_enrollment(
                renewed,
                &state.enrollment_verifying_jwk,
                &state.origin,
                &thumbprint,
            )?;
            if renewed_document.organisation_id != enrollment.organisation_id
                || renewed_document.device_enrollment_id != enrollment.device_enrollment_id
            {
                return Err(DesktopError::OrganisationMismatch);
            }
            cache.apply_sync_page(&page, replace_scope)?;
            state
                .secure_store
                .set(ENROLLMENT_DOCUMENT, renewed.as_bytes())?;
            state
                .sync_has_more
                .store(page.page.has_more, Ordering::SeqCst);
            state.offline.store(false, Ordering::SeqCst);
            state.status()
        }
        .await,
    )
}

#[tauri::command]
async fn desktop_claim_details(
    claim_id: String,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    command_result(
        async {
            state.require_unlocked()?;
            if claim_id.trim().is_empty() || claim_id.len() > 512 {
                return Err(DesktopError::InvalidResponse);
            }
            let (enrollment, signing_key, _) = state.load_enrollment()?;
            let mut cache = state.open_cache(&enrollment)?;
            if state.offline.load(Ordering::SeqCst) {
                return cache
                    .claim_detail(&claim_id)?
                    .ok_or(DesktopError::NetworkUnavailable);
            }
            let cookie = state
                .secure_store
                .get(SESSION_COOKIE)?
                .ok_or(DesktopError::AuthenticationRequired)?;
            let cookie = std::str::from_utf8(&cookie).map_err(|_| DesktopError::CredentialStore)?;
            let encoded: String =
                url::form_urlencoded::byte_serialize(claim_id.as_bytes()).collect();
            match state
                .http
                .enrolled(
                    Method::GET,
                    &format!("/desktop/claims/{encoded}"),
                    Vec::new(),
                    &enrollment,
                    &signing_key,
                    Some(cookie),
                )
                .await
            {
                Ok(response) => {
                    cache.store_claim_detail(&claim_id, &response.body)?;
                    state.offline.store(false, Ordering::SeqCst);
                    Ok(response.body)
                }
                Err(DesktopError::NetworkUnavailable) => {
                    state.offline.store(true, Ordering::SeqCst);
                    cache
                        .claim_detail(&claim_id)?
                        .ok_or(DesktopError::NetworkUnavailable)
                }
                Err(error) => Err(error),
            }
        }
        .await,
    )
}

#[tauri::command]
fn reset_desktop(confirmation: String, state: State<'_, DesktopState>) -> Result<Value, String> {
    command_result((|| {
        if confirmation != "RESET CLAIMGUARD" {
            return Err(DesktopError::ResetConfirmation);
        }
        let cache_path = state.cache_path();
        let paths = [
            cache_path.clone(),
            PathBuf::from(format!("{}-wal", cache_path.display())),
            PathBuf::from(format!("{}-shm", cache_path.display())),
        ];
        for path in paths {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(DesktopError::CacheUnavailable),
            }
        }
        state.secure_store.delete_all()?;
        state.locked.store(true, Ordering::SeqCst);
        state.offline.store(false, Ordering::SeqCst);
        state.sync_has_more.store(false, Ordering::SeqCst);
        Ok(json!({ "activationRequired": true }))
    })())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let (origin, enrollment_verifying_jwk) = trusted_configuration()
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            let app_data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            app.manage(DesktopState {
                app_data_dir,
                http: DesktopHttpClient::new(origin.clone())
                    .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?,
                origin,
                enrollment_verifying_jwk,
                secure_store: SecureStore,
                locked: AtomicBool::new(true),
                offline: AtomicBool::new(false),
                sync_has_more: AtomicBool::new(false),
            });

            #[cfg(target_os = "windows")]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(updater) = handle.updater() {
                        if let Ok(Some(update)) = updater.check().await {
                            let _ = update.download_and_install(|_, _| {}, || {}).await;
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            activate_desktop,
            desktop_login,
            desktop_logout,
            lock_desktop,
            synchronize_desktop,
            desktop_claim_details,
            reset_desktop,
        ])
        .run(tauri::generate_context!())
        .expect("ClaimGuard desktop runtime failed");
}
