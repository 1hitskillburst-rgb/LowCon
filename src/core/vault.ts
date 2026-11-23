const VAULT_MAGIC = 'LOWCON_VAULT_V01';
const MAGIC_BYTES = new TextEncoder().encode(VAULT_MAGIC);
const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 150_000;

export class VaultError extends Error {
  public readonly code:
    | 'INVALID_HEADER'
    | 'TRUNCATED_PAYLOAD'
    | 'DECRYPTION_FAILED'
    | 'EMPTY_PASSPHRASE';

  constructor(
    code: 'INVALID_HEADER' | 'TRUNCATED_PAYLOAD' | 'DECRYPTION_FAILED' | 'EMPTY_PASSPHRASE',
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SubtleCrypto API is unavailable in this runtime.');
  }
  return subtle;
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (!passphrase) {
    throw new VaultError('EMPTY_PASSPHRASE', 'Vault passphrase cannot be empty.');
  }
  const subtle = getSubtleCrypto();
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Encrypts plaintext UTF-8 JSON into a self-contained authenticated envelope:
 * [16 bytes Magic][16 bytes Salt][12 bytes IV][AES-256-GCM Ciphertext + 16-byte Tag]
 */
export async function encryptVaultString(passphrase: string, plaintext: string): Promise<string> {
  if (!passphrase) {
    throw new VaultError('EMPTY_PASSPHRASE', 'A non-empty passphrase is required to lock the vault.');
  }
  const subtle = getSubtleCrypto();
  const salt = new Uint8Array(SALT_LEN);
  const iv = new Uint8Array(IV_LEN);
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);

  const key = await deriveAesKey(passphrase, salt);
  const encodedPlain = new TextEncoder().encode(plaintext);
  const encryptedBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    encodedPlain,
  );
  const ciphertext = new Uint8Array(encryptedBuf);

  const envelope = new Uint8Array(MAGIC_BYTES.length + SALT_LEN + IV_LEN + ciphertext.length);
  envelope.set(MAGIC_BYTES, 0);
  envelope.set(salt, MAGIC_BYTES.length);
  envelope.set(iv, MAGIC_BYTES.length + SALT_LEN);
  envelope.set(ciphertext, MAGIC_BYTES.length + SALT_LEN + IV_LEN);

  return bytesToBase64(envelope);
}

/**
 * Decrypts and authenticates an encrypted vault envelope.
 * Rejects wrong passphrases, truncated envelopes, and tampered bytes.
 */
export async function decryptVaultString(passphrase: string, base64Envelope: string): Promise<string> {
  if (!passphrase) {
    throw new VaultError('EMPTY_PASSPHRASE', 'Enter your vault passphrase to unlock.');
  }

  let envelope: Uint8Array;
  try {
    envelope = base64ToBytes(base64Envelope);
  } catch {
    throw new VaultError('INVALID_HEADER', 'Stored vault payload is not valid base64.');
  }

  const minLen = MAGIC_BYTES.length + SALT_LEN + IV_LEN + 16;
  if (envelope.length < minLen) {
    throw new VaultError('TRUNCATED_PAYLOAD', 'Vault payload is truncated or incomplete.');
  }

  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (envelope[i] !== MAGIC_BYTES[i]) {
      throw new VaultError('INVALID_HEADER', 'Invalid vault magic header.');
    }
  }

  const salt = envelope.subarray(MAGIC_BYTES.length, MAGIC_BYTES.length + SALT_LEN);
  const iv = envelope.subarray(
    MAGIC_BYTES.length + SALT_LEN,
    MAGIC_BYTES.length + SALT_LEN + IV_LEN,
  );
  const ciphertext = envelope.subarray(MAGIC_BYTES.length + SALT_LEN + IV_LEN);

  const key = await deriveAesKey(passphrase, salt);
  const subtle = getSubtleCrypto();
  try {
    const plainBuf = await subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    throw new VaultError(
      'DECRYPTION_FAILED',
      'Incorrect passphrase or tampered vault payload. Decryption failed.',
    );
  }
}
