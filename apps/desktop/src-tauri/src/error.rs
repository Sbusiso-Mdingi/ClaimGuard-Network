use thiserror::Error;

#[derive(Debug, Error)]
pub enum DesktopError {
    #[error("secure credential storage is unavailable")]
    CredentialStore,
    #[error("the local encrypted cache could not be verified")]
    CacheIntegrity,
    #[error("the local encrypted cache could not be opened")]
    CacheUnavailable,
    #[error("the local encrypted cache could not be decrypted")]
    CacheDecryption,
    #[error("the device enrollment could not be verified")]
    EnrollmentInvalid,
    #[error("the device enrollment has expired")]
    EnrollmentExpired,
    #[error("the desktop client is not activated")]
    ActivationRequired,
    #[error("the desktop client is locked")]
    Locked,
    #[error("authentication is required")]
    AuthenticationRequired,
    #[error("this account does not have the required desktop capability")]
    CapabilityDenied,
    #[error("the server request was rejected: {0}")]
    ServerRejected(String),
    #[error("the ClaimGuard service is unavailable")]
    NetworkUnavailable,
    #[error("the server response was invalid")]
    InvalidResponse,
    #[error("the reset confirmation did not match")]
    ResetConfirmation,
    #[error("the desktop build is missing its trusted activation configuration")]
    BuildConfiguration,
    #[error("the organisation licensed on this device did not match the response")]
    OrganisationMismatch,
}

impl DesktopError {
    pub fn public_message(&self) -> String {
        match self {
            Self::ServerRejected(message) if !message.trim().is_empty() => message.clone(),
            _ => self.to_string(),
        }
    }
}

pub type DesktopResult<T> = Result<T, DesktopError>;
