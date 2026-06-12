import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * At-rest encryption for the workspace AI provider apiKey, keyed off
 * APP_SECRET. Values are tagged with a version prefix so already-stored
 * plaintext keys keep working (they are upgraded on the next save).
 */
const PREFIX = 'enc:v1:';
const IV_LENGTH = 12; // AES-GCM standard nonce size
const TAG_LENGTH = 16;

function deriveKey(appSecret: string): Buffer {
  return createHash('sha256').update(appSecret, 'utf8').digest();
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plain: string, appSecret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(appSecret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypts a stored secret. Non-encrypted values (legacy plaintext) pass
 * through unchanged. Returns null when the value is encrypted but cannot be
 * decrypted (e.g. APP_SECRET changed) — callers should treat that as "no key
 * set" rather than failing every AI request.
 */
export function decryptSecret(
  stored: string,
  appSecret: string,
): string | null {
  if (!isEncryptedSecret(stored)) {
    return stored;
  }
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(appSecret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
