use thiserror::Error;
use crate::privacy::PrivacyError;

#[derive(Error, Debug)]
pub enum StorageError {
    #[error("Database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Privacy violation in storage: {0}")]
    Privacy(#[from] PrivacyError),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Record not found: {entity} with id {id}")]
    NotFound { entity: &'static str, id: String },

    #[error("Vault error: {0}")]
    Vault(#[from] VaultError),

    #[error("Migration error: {0}")]
    Migration(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    #[error("Invalid vault magic header or format")]
    InvalidHeader,

    #[error("Payload too short or truncated")]
    TruncatedPayload,

    #[error("Argon2 key derivation failed: {0}")]
    KeyDerivationFailed(String),

    #[error("Decryption failed: invalid password or corrupted data")]
    DecryptionFailed,

    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),

    #[error("Vault is locked: must unlock before performing operation")]
    VaultLocked,

    #[error("Vault error: {0}")]
    Other(String),
}
