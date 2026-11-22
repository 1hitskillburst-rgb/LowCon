use thiserror::Error;
use std::path::PathBuf;

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum PrivacyError {
    #[error("Storage access outside authorized directory: attempted {attempted:?}, authorized base is {allowed_base:?}")]
    UnauthorizedStoragePath {
        attempted: PathBuf,
        allowed_base: PathBuf,
    },

    #[error("Path traversal detected: {0}")]
    PathTraversalDetected(PathBuf),

    #[error("File access rejected: path does not exist or user did not explicitly select: {0:?}")]
    UnapprovedFileAccess(PathBuf),

    #[error("Offline violation attempt: network or remote feature requested: {0}")]
    NetworkViolation(String),

    #[error("Diagnostic log policy violation: sensitive content leak prevented: {0}")]
    SensitiveContentLeak(String),
}
