use std::sync::{Arc, Mutex};
use argon2::Argon2;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use rand::RngCore;
use zeroize::{Zeroize, Zeroizing};

use crate::storage::error::VaultError;

pub const VAULT_MAGIC: &[u8; 16] = b"LOWCON_VAULT_V01";
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;

/// Sealed vault record layout:
/// [16 bytes Magic] [16 bytes Salt] [12 bytes Nonce] [Encrypted Payload + 16 bytes Poly1305 Tag]
pub struct Vault;

impl Vault {
    /// Derives a 256-bit cryptographic key from password and salt using Argon2id.
    pub fn derive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, VaultError> {
        let mut key = Zeroizing::new([0u8; 32]);
        let argon2 = Argon2::default();
        argon2
            .hash_password_into(password.as_bytes(), salt, key.as_mut())
            .map_err(|e| VaultError::KeyDerivationFailed(e.to_string()))?;
        Ok(key)
    }

    /// Encrypts arbitrary plaintext bytes into a self-contained, authenticated envelope.
    pub fn encrypt(password: &str, plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
        let mut salt = [0u8; SALT_LEN];
        let mut nonce_bytes = [0u8; NONCE_LEN];
        let mut rng = rand::thread_rng();
        rng.fill_bytes(&mut salt);
        rng.fill_bytes(&mut nonce_bytes);

        let key = Self::derive_key(password, &salt)?;
        let cipher = ChaCha20Poly1305::new(Key::from_slice(key.as_ref()));
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| VaultError::EncryptionFailed(e.to_string()))?;

        let mut output = Vec::with_capacity(VAULT_MAGIC.len() + SALT_LEN + NONCE_LEN + ciphertext.len());
        output.extend_from_slice(VAULT_MAGIC);
        output.extend_from_slice(&salt);
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);

        Ok(output)
    }

    /// Decrypts a previously sealed envelope using the provided password.
    pub fn decrypt(password: &str, envelope: &[u8]) -> Result<Vec<u8>, VaultError> {
        let min_len = VAULT_MAGIC.len() + SALT_LEN + NONCE_LEN + 16; // 16 bytes for Poly1305 MAC tag
        if envelope.len() < min_len {
            return Err(VaultError::TruncatedPayload);
        }

        let magic = &envelope[..VAULT_MAGIC.len()];
        if magic != VAULT_MAGIC {
            return Err(VaultError::InvalidHeader);
        }

        let salt_start = VAULT_MAGIC.len();
        let salt_end = salt_start + SALT_LEN;
        let salt = &envelope[salt_start..salt_end];

        let nonce_start = salt_end;
        let nonce_end = nonce_start + NONCE_LEN;
        let nonce_bytes = &envelope[nonce_start..nonce_end];

        let ciphertext = &envelope[nonce_end..];

        let key = Self::derive_key(password, salt)?;
        let cipher = ChaCha20Poly1305::new(Key::from_slice(key.as_ref()));
        let nonce = Nonce::from_slice(nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| VaultError::DecryptionFailed)?;

        Ok(plaintext)
    }
}

/// In-memory vault session manager for handling locked / unlocked state.
#[derive(Debug, Clone)]
pub struct VaultManager {
    // When unlocked, holds active derived key in zeroizing memory.
    active_key: Arc<Mutex<Option<Zeroizing<[u8; 32]>>>>,
}

impl Default for VaultManager {
    fn default() -> Self {
        Self::new()
    }
}

impl VaultManager {
    pub fn new() -> Self {
        Self {
            active_key: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.active_key
            .lock()
            .map(|k| k.is_some())
            .unwrap_or(false)
    }

    pub fn unlock_with_key(&self, key: Zeroizing<[u8; 32]>) {
        if let Ok(mut lock) = self.active_key.lock() {
            *lock = Some(key);
        }
    }

    pub fn unlock_with_password(&self, password: &str, salt: &[u8]) -> Result<(), VaultError> {
        let derived = Vault::derive_key(password, salt)?;
        self.unlock_with_key(derived);
        Ok(())
    }

    pub fn lock(&self) {
        if let Ok(mut lock) = self.active_key.lock() {
            if let Some(mut key) = lock.take() {
                key.zeroize();
            }
        }
    }

    /// Encrypts using the in-memory active key (if unlocked).
    pub fn encrypt_with_active_key(&self, plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
        let lock = self.active_key.lock().map_err(|_| VaultError::VaultLocked)?;
        let key_ref = lock.as_ref().ok_or(VaultError::VaultLocked)?;

        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);

        let cipher = ChaCha20Poly1305::new(Key::from_slice(key_ref.as_ref()));
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| VaultError::EncryptionFailed(e.to_string()))?;

        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    /// Decrypts using the in-memory active key (if unlocked).
    pub fn decrypt_with_active_key(&self, payload: &[u8]) -> Result<Vec<u8>, VaultError> {
        let lock = self.active_key.lock().map_err(|_| VaultError::VaultLocked)?;
        let key_ref = lock.as_ref().ok_or(VaultError::VaultLocked)?;

        if payload.len() < NONCE_LEN + 16 {
            return Err(VaultError::TruncatedPayload);
        }

        let nonce_bytes = &payload[..NONCE_LEN];
        let ciphertext = &payload[NONCE_LEN..];

        let cipher = ChaCha20Poly1305::new(Key::from_slice(key_ref.as_ref()));
        let nonce = Nonce::from_slice(nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| VaultError::DecryptionFailed)?;

        Ok(plaintext)
    }
}

impl Drop for VaultManager {
    fn drop(&mut self) {
        self.lock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_encrypt_decrypt_roundtrip() {
        let password = "SuperSecretLocalVaultPassword#2026";
        let plaintext = b"Conversation transcript and private LLM weights metadata";

        let encrypted = Vault::encrypt(password, plaintext).expect("Encryption failed");
        assert_ne!(&encrypted[..], plaintext);
        assert_eq!(&encrypted[..16], VAULT_MAGIC);

        let decrypted = Vault::decrypt(password, &encrypted).expect("Decryption failed");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_vault_wrong_password_fails() {
        let plaintext = b"Sensitive memory notes";
        let encrypted = Vault::encrypt("correct_password", plaintext).unwrap();

        let err = Vault::decrypt("wrong_password", &encrypted);
        assert_eq!(err, Err(VaultError::DecryptionFailed));
    }

    #[test]
    fn test_vault_corrupted_data_fails() {
        let password = "test_password";
        let plaintext = b"Data to be tampered with";
        let mut encrypted = Vault::encrypt(password, plaintext).unwrap();

        // Corrupt one byte of ciphertext
        let len = encrypted.len();
        encrypted[len - 1] ^= 0xFF;

        let err = Vault::decrypt(password, &encrypted);
        assert_eq!(err, Err(VaultError::DecryptionFailed));
    }

    #[test]
    fn test_vault_truncated_payload_fails() {
        let err = Vault::decrypt("pass", b"too_short");
        assert_eq!(err, Err(VaultError::TruncatedPayload));
    }

    #[test]
    fn test_vault_manager_lifecycle() {
        let manager = VaultManager::new();
        assert!(!manager.is_unlocked());

        let err = manager.encrypt_with_active_key(b"data");
        assert_eq!(err, Err(VaultError::VaultLocked));

        let salt = [42u8; SALT_LEN];
        manager.unlock_with_password("my_pass", &salt).unwrap();
        assert!(manager.is_unlocked());

        let secret = b"my active vault secret";
        let encrypted = manager.encrypt_with_active_key(secret).unwrap();
        let decrypted = manager.decrypt_with_active_key(&encrypted).unwrap();
        assert_eq!(decrypted, secret);

        manager.lock();
        assert!(!manager.is_unlocked());
        assert_eq!(manager.decrypt_with_active_key(&encrypted), Err(VaultError::VaultLocked));
    }
}
