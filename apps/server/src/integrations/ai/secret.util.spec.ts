import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from './secret.util';

describe('secret.util', () => {
  const SECRET = 'test-app-secret';

  it('round-trips a value', () => {
    const stored = encryptSecret('sk-very-secret', SECRET);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('sk-very-secret');
    expect(decryptSecret(stored, SECRET)).toBe('sk-very-secret');
  });

  it('produces a different ciphertext per call (random IV)', () => {
    expect(encryptSecret('same', SECRET)).not.toBe(
      encryptSecret('same', SECRET),
    );
  });

  it('passes legacy plaintext values through unchanged', () => {
    expect(isEncryptedSecret('sk-plaintext')).toBe(false);
    expect(decryptSecret('sk-plaintext', SECRET)).toBe('sk-plaintext');
  });

  it('returns null when the app secret changed', () => {
    const stored = encryptSecret('sk-very-secret', SECRET);
    expect(decryptSecret(stored, 'rotated-secret')).toBeNull();
  });

  it('returns null on a corrupted blob', () => {
    expect(decryptSecret('enc:v1:not-base64!!!', SECRET)).toBeNull();
  });
});
