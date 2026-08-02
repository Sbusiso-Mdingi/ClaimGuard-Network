use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use chrono::{DateTime, Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

use crate::error::{DesktopError, DesktopResult};

const CACHE_SCHEMA_VERSION: i64 = 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub resource: String,
    pub operation: String,
    pub id: String,
    pub version: String,
    pub updated_at: String,
    #[serde(default)]
    pub record: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMetadata {
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshnessMetadata {
    pub generated_at: String,
    #[serde(default = "default_claim_freshness")]
    pub claims_seconds: i64,
}

fn default_claim_freshness() -> i64 {
    15
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScope {
    pub organisation_id: String,
    pub claims_from: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPage {
    pub schema_version: u32,
    pub scope: SyncScope,
    pub changes: Vec<Change>,
    pub projections: serde_json::Map<String, Value>,
    pub page: PageMetadata,
    pub cursor: String,
    pub freshness: FreshnessMetadata,
    #[serde(default)]
    pub enrollment: Option<Value>,
}

pub struct EncryptedCache {
    connection: Connection,
    cipher: Aes256Gcm,
    organisation_id: String,
}

impl EncryptedCache {
    pub fn open(
        path: &Path,
        key: &[u8],
        organisation_id: &str,
        device_enrollment_id: &str,
    ) -> DesktopResult<Self> {
        if key.len() != 32 || organisation_id.is_empty() || device_enrollment_id.is_empty() {
            return Err(DesktopError::CacheUnavailable);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| DesktopError::CacheUnavailable)?;
        }
        let connection = Connection::open(path).map_err(|_| DesktopError::CacheUnavailable)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=FULL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA secure_delete=ON;
                 CREATE TABLE IF NOT EXISTS cache_binding (
                   singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                   schema_version INTEGER NOT NULL,
                   organisation_digest TEXT NOT NULL,
                   device_digest TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS encrypted_records (
                   resource TEXT NOT NULL,
                   record_key TEXT NOT NULL,
                   version TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   nonce BLOB NOT NULL,
                   ciphertext BLOB NOT NULL,
                   PRIMARY KEY (resource, record_key)
                 );
                 CREATE INDEX IF NOT EXISTS encrypted_records_resource_updated
                   ON encrypted_records (resource, updated_at DESC);
                 CREATE TABLE IF NOT EXISTS encrypted_meta (
                   name TEXT PRIMARY KEY,
                   nonce BLOB NOT NULL,
                   ciphertext BLOB NOT NULL
                 );",
            )
            .map_err(|_| DesktopError::CacheUnavailable)?;
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|_| DesktopError::CacheIntegrity)?;
        if integrity != "ok" {
            return Err(DesktopError::CacheIntegrity);
        }
        let organisation_digest = binding_digest("organisation", organisation_id);
        let device_digest = binding_digest("device", device_enrollment_id);
        let binding = connection
            .query_row(
                "SELECT schema_version, organisation_digest, device_digest FROM cache_binding WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
            .map_err(|_| DesktopError::CacheUnavailable)?;
        match binding {
            Some((version, stored_organisation, stored_device))
                if version == CACHE_SCHEMA_VERSION
                    && stored_organisation == organisation_digest
                    && stored_device == device_digest => {}
            Some(_) => return Err(DesktopError::OrganisationMismatch),
            None => {
                connection
                    .execute(
                        "INSERT INTO cache_binding (singleton, schema_version, organisation_digest, device_digest) VALUES (1, ?, ?, ?)",
                        params![CACHE_SCHEMA_VERSION, organisation_digest, device_digest],
                    )
                    .map_err(|_| DesktopError::CacheUnavailable)?;
            }
        }
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| DesktopError::CacheUnavailable)?;
        Ok(Self {
            connection,
            cipher,
            organisation_id: organisation_id.to_owned(),
        })
    }

    pub fn apply_sync_page(&mut self, page: &SyncPage, replace_scope: bool) -> DesktopResult<()> {
        if page.schema_version != CACHE_SCHEMA_VERSION as u32
            || page.scope.organisation_id != self.organisation_id
            || page.changes.len() > 500
        {
            return Err(DesktopError::OrganisationMismatch);
        }
        let cipher = self.cipher.clone();
        let organisation = self.organisation_id.clone();
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| DesktopError::CacheUnavailable)?;
        if replace_scope {
            transaction
                .execute(
                    "DELETE FROM encrypted_records WHERE resource IN ('claim', 'investigation')",
                    [],
                )
                .map_err(|_| DesktopError::CacheUnavailable)?;
        }
        for change in &page.changes {
            apply_change(&transaction, &cipher, &organisation, change)?;
        }
        for projection in page.projections.values() {
            let change = serde_json::from_value::<Change>(projection.clone())
                .map_err(|_| DesktopError::InvalidResponse)?;
            if !matches!(change.resource.as_str(), "dashboard" | "suspicious_network") {
                return Err(DesktopError::InvalidResponse);
            }
            apply_change(&transaction, &cipher, &organisation, &change)?;
        }
        set_meta(
            &transaction,
            &cipher,
            &organisation,
            "sync-cursor",
            &Value::String(page.cursor.clone()),
        )?;
        set_meta(
            &transaction,
            &cipher,
            &organisation,
            "last-successful-sync-at",
            &Value::String(page.freshness.generated_at.clone()),
        )?;
        set_meta(
            &transaction,
            &cipher,
            &organisation,
            "claims-freshness-seconds",
            &Value::Number(page.freshness.claims_seconds.into()),
        )?;
        set_meta(
            &transaction,
            &cipher,
            &organisation,
            "claims-scope-start",
            &Value::String(page.scope.claims_from.clone()),
        )?;
        if !page.page.has_more {
            prune_claims_outside_scope(
                &transaction,
                &cipher,
                &organisation,
                &page.scope.claims_from,
            )?;
        }
        let detail_cutoff = (Utc::now() - Duration::hours(24)).to_rfc3339();
        transaction
            .execute(
                "DELETE FROM encrypted_records WHERE resource IN ('claim_detail', 'investigation_detail') AND updated_at < ?",
                [detail_cutoff],
            )
            .map_err(|_| DesktopError::CacheUnavailable)?;
        transaction
            .commit()
            .map_err(|_| DesktopError::CacheUnavailable)
    }

    pub fn cursor(&self) -> DesktopResult<Option<String>> {
        Ok(self
            .meta("sync-cursor")?
            .and_then(|value| value.as_str().map(str::to_owned)))
    }

    pub fn last_successful_sync_at(&self) -> DesktopResult<Option<String>> {
        Ok(self
            .meta("last-successful-sync-at")?
            .and_then(|value| value.as_str().map(str::to_owned)))
    }

    pub fn claims_freshness_seconds(&self) -> DesktopResult<i64> {
        Ok(self
            .meta("claims-freshness-seconds")?
            .and_then(|value| value.as_i64())
            .unwrap_or(15))
    }

    pub fn claims(&self) -> DesktopResult<Vec<Value>> {
        self.records("claim", 500)
    }

    pub fn investigations(&self) -> DesktopResult<Vec<Value>> {
        self.records("investigation", 500)
    }

    pub fn dashboard(&self) -> DesktopResult<Option<Value>> {
        self.record("dashboard", "current")
    }

    pub fn suspicious_network(&self) -> DesktopResult<Option<Value>> {
        self.record("suspicious_network", "current")
    }

    pub fn claim_detail(&self, claim_id: &str) -> DesktopResult<Option<Value>> {
        self.record("claim_detail", claim_id)
    }

    pub fn store_claim_detail(&mut self, claim_id: &str, value: &Value) -> DesktopResult<()> {
        let change = Change {
            resource: "claim_detail".into(),
            operation: "upsert".into(),
            id: claim_id.into(),
            version: value
                .get("etag")
                .and_then(Value::as_str)
                .unwrap_or("on-demand-v1")
                .into(),
            updated_at: value
                .get("fetchedAt")
                .and_then(Value::as_str)
                .unwrap_or("1970-01-01T00:00:00.000Z")
                .into(),
            record: Some(value.clone()),
        };
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| DesktopError::CacheUnavailable)?;
        apply_change(&transaction, &self.cipher, &self.organisation_id, &change)?;
        transaction
            .commit()
            .map_err(|_| DesktopError::CacheUnavailable)
    }

    pub fn investigation_detail(&self, investigation_id: &str) -> DesktopResult<Option<Value>> {
        self.record("investigation_detail", investigation_id)
    }

    pub fn store_investigation_detail(
        &mut self,
        investigation_id: &str,
        value: &Value,
    ) -> DesktopResult<()> {
        let updated_at = value
            .pointer("/investigation/updatedAt")
            .and_then(Value::as_str)
            .ok_or(DesktopError::InvalidResponse)?;
        let change = Change {
            resource: "investigation_detail".into(),
            operation: "upsert".into(),
            id: investigation_id.into(),
            version: updated_at.into(),
            updated_at: value
                .get("fetchedAt")
                .and_then(Value::as_str)
                .unwrap_or(updated_at)
                .into(),
            record: Some(value.clone()),
        };
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| DesktopError::CacheUnavailable)?;
        apply_change(&transaction, &self.cipher, &self.organisation_id, &change)?;
        transaction
            .commit()
            .map_err(|_| DesktopError::CacheUnavailable)
    }

    pub fn apply_investigation_update(&mut self, value: &Value) -> DesktopResult<()> {
        let investigation = value
            .get("investigation")
            .and_then(Value::as_object)
            .ok_or(DesktopError::InvalidResponse)?;
        let investigation_id = investigation
            .get("investigationId")
            .and_then(Value::as_str)
            .ok_or(DesktopError::InvalidResponse)?;
        let updated_at = investigation
            .get("updatedAt")
            .and_then(Value::as_str)
            .ok_or(DesktopError::InvalidResponse)?;
        let closed = investigation
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status == "CLOSED");
        let change = Change {
            resource: "investigation".into(),
            operation: if closed { "delete" } else { "upsert" }.into(),
            id: investigation_id.into(),
            version: updated_at.into(),
            updated_at: updated_at.into(),
            record: if closed {
                None
            } else {
                Some(Value::Object(investigation.clone()))
            },
        };
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| DesktopError::CacheUnavailable)?;
        apply_change(&transaction, &self.cipher, &self.organisation_id, &change)?;
        transaction
            .commit()
            .map_err(|_| DesktopError::CacheUnavailable)
    }

    fn meta(&self, name: &str) -> DesktopResult<Option<Value>> {
        let encrypted = self
            .connection
            .query_row(
                "SELECT nonce, ciphertext FROM encrypted_meta WHERE name = ?",
                [name],
                |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()
            .map_err(|_| DesktopError::CacheUnavailable)?;
        encrypted
            .map(|(nonce, ciphertext)| {
                decrypt_json(
                    &self.cipher,
                    &nonce,
                    &ciphertext,
                    meta_aad(&self.organisation_id, name).as_bytes(),
                )
            })
            .transpose()
    }

    fn record(&self, resource: &str, id: &str) -> DesktopResult<Option<Value>> {
        let record_key = record_key(&self.organisation_id, resource, id);
        let encrypted = self
            .connection
            .query_row(
                "SELECT version, nonce, ciphertext FROM encrypted_records WHERE resource = ? AND record_key = ?",
                params![resource, record_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| DesktopError::CacheUnavailable)?;
        encrypted
            .map(|(version, nonce, ciphertext)| {
                decrypt_json(
                    &self.cipher,
                    &nonce,
                    &ciphertext,
                    record_aad(&self.organisation_id, resource, &record_key, &version).as_bytes(),
                )
            })
            .transpose()
    }

    fn records(&self, resource: &str, limit: usize) -> DesktopResult<Vec<Value>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT record_key, version, nonce, ciphertext FROM encrypted_records
                 WHERE resource = ? ORDER BY updated_at DESC LIMIT ?",
            )
            .map_err(|_| DesktopError::CacheUnavailable)?;
        let rows = statement
            .query_map(params![resource, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(|_| DesktopError::CacheUnavailable)?;
        let mut values = Vec::new();
        for row in rows {
            let (record_key, version, nonce, ciphertext) =
                row.map_err(|_| DesktopError::CacheUnavailable)?;
            values.push(decrypt_json(
                &self.cipher,
                &nonce,
                &ciphertext,
                record_aad(&self.organisation_id, resource, &record_key, &version).as_bytes(),
            )?);
        }
        Ok(values)
    }

    #[cfg(test)]
    fn corrupt_first_record(&self) {
        self.connection
            .execute(
                "UPDATE encrypted_records SET ciphertext = X'00' WHERE rowid = (SELECT rowid FROM encrypted_records LIMIT 1)",
                [],
            )
            .unwrap();
    }
}

fn apply_change(
    transaction: &Transaction<'_>,
    cipher: &Aes256Gcm,
    organisation: &str,
    change: &Change,
) -> DesktopResult<()> {
    if !matches!(
        change.resource.as_str(),
        "claim"
            | "investigation"
            | "dashboard"
            | "suspicious_network"
            | "claim_detail"
            | "investigation_detail"
    ) || change.id.is_empty()
        || change.id.len() > 512
        || change.version.len() > 256
    {
        return Err(DesktopError::InvalidResponse);
    }
    let key = record_key(organisation, &change.resource, &change.id);
    if change.resource == "investigation" {
        let detail_key = record_key(organisation, "investigation_detail", &change.id);
        transaction
            .execute(
                "DELETE FROM encrypted_records WHERE resource = 'investigation_detail' AND record_key = ?",
                [detail_key],
            )
            .map_err(|_| DesktopError::CacheUnavailable)?;
    }
    if change.operation == "delete" {
        transaction
            .execute(
                "DELETE FROM encrypted_records WHERE resource = ? AND record_key = ?",
                params![change.resource, key],
            )
            .map_err(|_| DesktopError::CacheUnavailable)?;
        return Ok(());
    }
    if change.operation != "upsert" && change.operation != "replace" {
        return Err(DesktopError::InvalidResponse);
    }
    let record = change
        .record
        .as_ref()
        .ok_or(DesktopError::InvalidResponse)?;
    let aad = record_aad(organisation, &change.resource, &key, &change.version);
    let (nonce, ciphertext) = encrypt_json(cipher, record, aad.as_bytes())?;
    transaction
        .execute(
            "INSERT INTO encrypted_records (resource, record_key, version, updated_at, nonce, ciphertext)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(resource, record_key) DO UPDATE SET
               version = excluded.version,
               updated_at = excluded.updated_at,
               nonce = excluded.nonce,
               ciphertext = excluded.ciphertext",
            params![
                change.resource,
                key,
                change.version,
                change.updated_at,
                nonce,
                ciphertext
            ],
        )
        .map_err(|_| DesktopError::CacheUnavailable)?;
    Ok(())
}

fn set_meta(
    transaction: &Transaction<'_>,
    cipher: &Aes256Gcm,
    organisation: &str,
    name: &str,
    value: &Value,
) -> DesktopResult<()> {
    let (nonce, ciphertext) = encrypt_json(cipher, value, meta_aad(organisation, name).as_bytes())?;
    transaction
        .execute(
            "INSERT INTO encrypted_meta (name, nonce, ciphertext) VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext",
            params![name, nonce, ciphertext],
        )
        .map_err(|_| DesktopError::CacheUnavailable)?;
    Ok(())
}

fn prune_claims_outside_scope(
    transaction: &Transaction<'_>,
    cipher: &Aes256Gcm,
    organisation: &str,
    scope_start: &str,
) -> DesktopResult<()> {
    DateTime::parse_from_rfc3339(scope_start).map_err(|_| DesktopError::InvalidResponse)?;
    let mut statement = transaction
        .prepare(
            "SELECT record_key, version, nonce, ciphertext FROM encrypted_records
             WHERE resource = 'claim' AND updated_at < ?",
        )
        .map_err(|_| DesktopError::CacheUnavailable)?;
    let rows = statement
        .query_map([scope_start], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|_| DesktopError::CacheUnavailable)?;
    let mut removals = Vec::new();
    for row in rows {
        let (key, version, nonce, ciphertext) = row.map_err(|_| DesktopError::CacheUnavailable)?;
        let claim = decrypt_json(
            cipher,
            &nonce,
            &ciphertext,
            record_aad(organisation, "claim", &key, &version).as_bytes(),
        )?;
        let investigation_active = claim
            .pointer("/investigation/status")
            .and_then(Value::as_str)
            .is_some_and(|status| status != "CLOSED");
        if !investigation_active {
            removals.push(key);
        }
    }
    drop(statement);
    for key in removals {
        transaction
            .execute(
                "DELETE FROM encrypted_records WHERE resource = 'claim' AND record_key = ?",
                [key],
            )
            .map_err(|_| DesktopError::CacheUnavailable)?;
    }
    Ok(())
}

fn encrypt_json(
    cipher: &Aes256Gcm,
    value: &Value,
    aad: &[u8],
) -> DesktopResult<(Vec<u8>, Vec<u8>)> {
    let plaintext = serde_json::to_vec(value).map_err(|_| DesktopError::InvalidResponse)?;
    let mut nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad,
            },
        )
        .map_err(|_| DesktopError::CacheUnavailable)?;
    Ok((nonce.to_vec(), ciphertext))
}

fn decrypt_json(
    cipher: &Aes256Gcm,
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> DesktopResult<Value> {
    if nonce.len() != 12 {
        return Err(DesktopError::CacheDecryption);
    }
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| DesktopError::CacheDecryption)?;
    serde_json::from_slice(&plaintext).map_err(|_| DesktopError::CacheDecryption)
}

fn binding_digest(kind: &str, value: &str) -> String {
    hex::encode(Sha256::digest(
        format!("ClaimGuard:{kind}:{value}").as_bytes(),
    ))
}

fn record_key(organisation: &str, resource: &str, id: &str) -> String {
    hex::encode(Sha256::digest(
        format!("{organisation}:{resource}:{id}").as_bytes(),
    ))
}

fn record_aad(organisation: &str, resource: &str, record_key: &str, version: &str) -> String {
    format!("ClaimGuard:v1:{organisation}:{resource}:{record_key}:{version}")
}

fn meta_aad(organisation: &str, name: &str) -> String {
    format!("ClaimGuard:v1:{organisation}:meta:{name}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn page(cursor: &str, changes: Vec<Change>) -> SyncPage {
        SyncPage {
            schema_version: 1,
            scope: SyncScope {
                organisation_id: "org-a".into(),
                claims_from: "2026-05-01T00:00:00.000Z".into(),
            },
            changes,
            projections: serde_json::Map::new(),
            page: PageMetadata { has_more: false },
            cursor: cursor.into(),
            freshness: FreshnessMetadata {
                generated_at: "2026-08-01T00:00:00.000Z".into(),
                claims_seconds: 15,
            },
            enrollment: None,
        }
    }

    fn claim(operation: &str, value: Option<Value>) -> Change {
        Change {
            resource: "claim".into(),
            operation: operation.into(),
            id: "claim-1".into(),
            version: "v1".into(),
            updated_at: "2026-08-01T00:00:00.000Z".into(),
            record: value,
        }
    }

    #[test]
    fn tombstones_remove_encrypted_records() {
        let directory = tempdir().unwrap();
        let mut cache = EncryptedCache::open(
            &directory.path().join("cache.db"),
            &[7; 32],
            "org-a",
            "device-a",
        )
        .unwrap();
        cache
            .apply_sync_page(
                &page(
                    "cursor-1",
                    vec![claim(
                        "upsert",
                        Some(serde_json::json!({"claimId":"claim-1"})),
                    )],
                ),
                false,
            )
            .unwrap();
        assert_eq!(cache.claims().unwrap().len(), 1);
        cache
            .apply_sync_page(&page("cursor-2", vec![claim("delete", None)]), false)
            .unwrap();
        assert!(cache.claims().unwrap().is_empty());
    }

    #[test]
    fn cursor_advances_only_when_the_whole_page_commits() {
        let directory = tempdir().unwrap();
        let mut cache = EncryptedCache::open(
            &directory.path().join("cache.db"),
            &[8; 32],
            "org-a",
            "device-a",
        )
        .unwrap();
        cache
            .apply_sync_page(&page("cursor-1", vec![]), false)
            .unwrap();
        let invalid = Change {
            resource: "forbidden".into(),
            ..claim("upsert", Some(serde_json::json!({})))
        };
        assert!(cache
            .apply_sync_page(&page("cursor-2", vec![invalid]), false)
            .is_err());
        assert_eq!(cache.cursor().unwrap().as_deref(), Some("cursor-1"));
    }

    #[test]
    fn corrupted_ciphertext_fails_closed() {
        let directory = tempdir().unwrap();
        let mut cache = EncryptedCache::open(
            &directory.path().join("cache.db"),
            &[9; 32],
            "org-a",
            "device-a",
        )
        .unwrap();
        cache
            .apply_sync_page(
                &page(
                    "cursor",
                    vec![claim(
                        "upsert",
                        Some(serde_json::json!({"claimId":"claim-1"})),
                    )],
                ),
                false,
            )
            .unwrap();
        cache.corrupt_first_record();
        assert!(matches!(cache.claims(), Err(DesktopError::CacheDecryption)));
    }

    #[test]
    fn completed_sync_prunes_only_inactive_claims_outside_retention() {
        let directory = tempdir().unwrap();
        let mut cache = EncryptedCache::open(
            &directory.path().join("cache.db"),
            &[10; 32],
            "org-a",
            "device-a",
        )
        .unwrap();
        let mut inactive = claim(
            "upsert",
            Some(serde_json::json!({
                "claimId": "claim-1",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "investigation": null
            })),
        );
        inactive.updated_at = "2026-01-01T00:00:00.000Z".into();
        let active = Change {
            id: "claim-2".into(),
            record: Some(serde_json::json!({
                "claimId": "claim-2",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "investigation": { "status": "OPEN" }
            })),
            ..inactive.clone()
        };
        cache
            .apply_sync_page(&page("cursor", vec![inactive, active]), false)
            .unwrap();
        let claims = cache.claims().unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0]["claimId"], "claim-2");
    }

    #[test]
    fn investigation_updates_replace_compact_state_and_invalidate_cached_detail() {
        let directory = tempdir().unwrap();
        let mut cache = EncryptedCache::open(
            &directory.path().join("cache.db"),
            &[11; 32],
            "org-a",
            "device-a",
        )
        .unwrap();
        let initial = Change {
            resource: "investigation".into(),
            operation: "upsert".into(),
            id: "investigation-1".into(),
            version: "2026-08-01T10:00:00.000Z".into(),
            updated_at: "2026-08-01T10:00:00.000Z".into(),
            record: Some(serde_json::json!({
                "investigationId": "investigation-1",
                "claimId": "claim-1",
                "status": "OPEN",
                "priority": "NORMAL",
                "updatedAt": "2026-08-01T10:00:00.000Z"
            })),
        };
        cache
            .apply_sync_page(&page("cursor-1", vec![initial]), false)
            .unwrap();
        cache
            .store_investigation_detail(
                "investigation-1",
                &serde_json::json!({
                    "available": true,
                    "fetchedAt": "2026-08-01T10:00:01.000Z",
                    "investigation": {
                        "investigationId": "investigation-1",
                        "status": "OPEN",
                        "updatedAt": "2026-08-01T10:00:00.000Z",
                        "notes": [{"noteId": "note-1"}]
                    }
                }),
            )
            .unwrap();
        assert!(cache
            .investigation_detail("investigation-1")
            .unwrap()
            .is_some());

        cache
            .apply_investigation_update(&serde_json::json!({
                "available": true,
                "investigation": {
                    "investigationId": "investigation-1",
                    "claimId": "claim-1",
                    "status": "UNDER_REVIEW",
                    "priority": "HIGH",
                    "updatedAt": "2026-08-01T10:05:00.000Z"
                }
            }))
            .unwrap();
        assert_eq!(cache.investigations().unwrap()[0]["status"], "UNDER_REVIEW");
        assert!(cache
            .investigation_detail("investigation-1")
            .unwrap()
            .is_none());

        cache
            .apply_investigation_update(&serde_json::json!({
                "available": true,
                "investigation": {
                    "investigationId": "investigation-1",
                    "status": "CLOSED",
                    "updatedAt": "2026-08-01T10:10:00.000Z"
                }
            }))
            .unwrap();
        assert!(cache.investigations().unwrap().is_empty());
    }
}
