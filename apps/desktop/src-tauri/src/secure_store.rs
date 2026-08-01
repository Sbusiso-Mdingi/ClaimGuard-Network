use keyring::v1::{Entry, Error as KeyringError};

use crate::error::{DesktopError, DesktopResult};

const SERVICE: &str = "network.claimguard.desktop";

pub const INSTALLATION_ID: &str = "installation-id";
pub const DEVICE_PRIVATE_KEY: &str = "device-ed25519-private-key";
pub const ENROLLMENT_DOCUMENT: &str = "signed-enrollment-document";
pub const CACHE_KEY: &str = "cache-aes-256-key";
pub const SESSION_COOKIE: &str = "session-cookie";

#[derive(Clone, Default)]
pub struct SecureStore;

impl SecureStore {
    fn entry(name: &str) -> DesktopResult<Entry> {
        Entry::new(SERVICE, name).map_err(|_| DesktopError::CredentialStore)
    }

    pub fn get(&self, name: &str) -> DesktopResult<Option<Vec<u8>>> {
        match Self::entry(name)?.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(DesktopError::CredentialStore),
        }
    }

    pub fn set(&self, name: &str, value: &[u8]) -> DesktopResult<()> {
        Self::entry(name)?
            .set_secret(value)
            .map_err(|_| DesktopError::CredentialStore)
    }

    pub fn delete(&self, name: &str) -> DesktopResult<()> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(DesktopError::CredentialStore),
        }
    }

    pub fn delete_all(&self) -> DesktopResult<()> {
        for name in [
            SESSION_COOKIE,
            ENROLLMENT_DOCUMENT,
            DEVICE_PRIVATE_KEY,
            CACHE_KEY,
            INSTALLATION_ID,
        ] {
            self.delete(name)?;
        }
        Ok(())
    }
}
