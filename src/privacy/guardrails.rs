use std::path::{Component, Path, PathBuf};
use crate::privacy::error::PrivacyError;

/// Transparent declaration of LowCon's security boundary.
pub const SECURITY_BOUNDARY_DISCLOSURE: &str = "\
### LowCon Security Boundary & Privacy Policy

1. **Air-Gapped Operation:** LowCon contains zero runtime networking dependencies, socket bindings, or cloud APIs. All model inference and data storage run locally on your hardware.
2. **Local Data Isolation:** All chats, task states, pinned memories, and configuration reside strictly within your configured application data directory.
3. **Encrypted Vault:** Sensitive database records and credentials can be sealed using ChaCha20-Poly1305 authenticated encryption with Argon2id key derivation.
4. **Honest Limitations:**
   - LowCon CANNOT protect against a compromised operating system or kernel malware.
   - LowCon CANNOT protect against other malicious processes running under the same OS user account with access to process memory or filesystem permissions.
   - LowCon CANNOT protect against physical access to an unlocked, running workstation.
5. **No Telemetry or Crash Uploads:** Diagnostic logs are local-only, disabled by default, and redacted to omit prompts and conversations.";

/// System-wide offline boundary status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfflineStatus {
    pub is_offline: bool,
    pub network_listeners_active: bool,
    pub telemetry_enabled: bool,
    pub cloud_inference_enabled: bool,
    pub storage_directory: PathBuf,
}

impl OfflineStatus {
    pub fn new(storage_dir: PathBuf) -> Self {
        Self {
            is_offline: true,
            network_listeners_active: false,
            telemetry_enabled: false,
            cloud_inference_enabled: false,
            storage_directory: storage_dir,
        }
    }

    /// Verifies that all offline invariants are strictly maintained.
    pub fn verify_invariants(&self) -> Result<(), PrivacyError> {
        if !self.is_offline {
            return Err(PrivacyError::NetworkViolation(
                "Offline flag is disabled".to_string(),
            ));
        }
        if self.network_listeners_active {
            return Err(PrivacyError::NetworkViolation(
                "Active network listener detected".to_string(),
            ));
        }
        if self.telemetry_enabled {
            return Err(PrivacyError::NetworkViolation(
                "Telemetry was enabled".to_string(),
            ));
        }
        if self.cloud_inference_enabled {
            return Err(PrivacyError::NetworkViolation(
                "Cloud inference was enabled".to_string(),
            ));
        }
        Ok(())
    }
}

/// Enforces that all persistent data reads and writes stay strictly within
/// the user's approved local storage directory.
#[derive(Debug, Clone)]
pub struct StorageLocationPolicy {
    allowed_root: PathBuf,
}

impl StorageLocationPolicy {
    pub fn new(allowed_root: PathBuf) -> Self {
        Self { allowed_root }
    }

    pub fn allowed_root(&self) -> &Path {
        &self.allowed_root
    }

    /// Validates that a requested file or directory path is strictly inside
    /// the designated application storage root.
    pub fn validate_path(&self, requested: &Path) -> Result<PathBuf, PrivacyError> {
        // Reject path traversal components (e.g. `..`)
        for component in requested.components() {
            if component == Component::ParentDir {
                return Err(PrivacyError::PathTraversalDetected(requested.to_path_buf()));
            }
        }

        // Normalize paths for comparison
        let normalized_root = normalize_path(&self.allowed_root);
        let normalized_target = if requested.is_absolute() {
            normalize_path(requested)
        } else {
            normalize_path(&self.allowed_root.join(requested))
        };

        if normalized_target.starts_with(&normalized_root) {
            Ok(normalized_target)
        } else {
            Err(PrivacyError::UnauthorizedStoragePath {
                attempted: requested.to_path_buf(),
                allowed_base: self.allowed_root.clone(),
            })
        }
    }

    /// Verifies that a user-selected local model file exists and is explicitly chosen
    /// (does not allow directory crawling).
    pub fn validate_user_selected_model_path(&self, path: &Path) -> Result<PathBuf, PrivacyError> {
        for component in path.components() {
            if component == Component::ParentDir {
                return Err(PrivacyError::PathTraversalDetected(path.to_path_buf()));
            }
        }

        if !path.exists() {
            return Err(PrivacyError::UnapprovedFileAccess(path.to_path_buf()));
        }

        if path.is_dir() {
            return Err(PrivacyError::UnapprovedFileAccess(path.to_path_buf()));
        }

        Ok(path.to_path_buf())
    }
}

/// Helper to normalize paths without requiring symlink resolution on nonexistent files.
fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            c => normalized.push(c.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_offline_invariants() {
        let status = OfflineStatus::new(PathBuf::from("/tmp/lowcon"));
        assert!(status.verify_invariants().is_ok());

        let mut bad_status = status.clone();
        bad_status.is_offline = false;
        assert!(bad_status.verify_invariants().is_err());

        let mut bad_net = status.clone();
        bad_net.network_listeners_active = true;
        assert!(bad_net.verify_invariants().is_err());

        let mut bad_telemetry = status.clone();
        bad_telemetry.telemetry_enabled = true;
        assert!(bad_telemetry.verify_invariants().is_err());

        let mut bad_cloud = status.clone();
        bad_cloud.cloud_inference_enabled = true;
        assert!(bad_cloud.verify_invariants().is_err());
    }

    #[test]
    fn test_storage_location_policy() {
        let base = if cfg!(windows) {
            PathBuf::from(r"C:\Users\test\AppData\LowCon")
        } else {
            PathBuf::from("/home/test/.local/share/lowcon")
        };
        let policy = StorageLocationPolicy::new(base.clone());

        // Valid relative subpath
        let valid_sub = policy.validate_path(Path::new("sessions.db"));
        assert!(valid_sub.is_ok());
        assert!(valid_sub.unwrap().starts_with(&base));

        // Valid nested subpath
        let valid_nested = policy.validate_path(Path::new("vaults/keys.db"));
        assert!(valid_nested.is_ok());

        // Path traversal rejection
        let traversal = policy.validate_path(Path::new("../forbidden.db"));
        assert!(matches!(traversal, Err(PrivacyError::PathTraversalDetected(_))));

        // Unauthorized absolute path
        let unauthorized = if cfg!(windows) {
            PathBuf::from(r"C:\Windows\System32\cmd.exe")
        } else {
            PathBuf::from("/etc/passwd")
        };
        let unauth_res = policy.validate_path(&unauthorized);
        assert!(matches!(unauth_res, Err(PrivacyError::UnauthorizedStoragePath { .. })));
    }
}
