import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { EnvironmentService } from '../environment/environment.service';

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 16; // per-record random salt for scrypt key derivation
const IV_LENGTH = 12; // recommended IV length for GCM
const AUTH_TAG_LENGTH = 16; // GCM authentication tag length
const KEY_LENGTH = 32; // 256-bit key for aes-256-gcm

/**
 * Symmetric secret encryption helper.
 *
 * Encrypts short secrets (e.g. provider API keys) with AES-256-GCM. The key is
 * derived from APP_SECRET via scrypt using a per-record random salt, so two
 * encryptions of the same plaintext produce different blobs. The output layout
 * is base64( salt | iv | authTag | ciphertext ).
 *
 * Decryptions are memoized by blob: scryptSync blocks the event loop for
 * ~120 ms per call, and every AI request (search included) resolves up to three
 * keys. A blob never changes — a re-entered key is a new blob — so each
 * key-sized one is derived once per process.
 */
@Injectable()
export class SecretBoxService {
  private static readonly MAX_DECRYPTED = 64;
  private static readonly MAX_CACHED_BLOB_CHARS = 4096;
  // blob -> plaintext, in insertion order; the oldest entry goes first at the cap.
  private readonly decrypted = new Map<string, string>();

  constructor(private readonly environmentService: EnvironmentService) {}

  private deriveKey(salt: Buffer): Buffer {
    return scryptSync(
      this.environmentService.getAppSecret(),
      salt,
      KEY_LENGTH,
    );
  }

  encryptSecret(plain: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = this.deriveKey(salt);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([salt, iv, authTag, ciphertext]).toString('base64');
  }

  decryptSecret(blob: string): string {
    const known = this.decrypted.get(blob);
    if (known !== undefined) return known;

    const plain = this.decryptUncached(blob);
    // Byte budget: only key-sized blobs are kept; a large one (an external MCP
    // server's header set) is decrypted on every call.
    if (blob.length > SecretBoxService.MAX_CACHED_BLOB_CHARS) return plain;
    if (this.decrypted.size >= SecretBoxService.MAX_DECRYPTED) {
      this.decrypted.delete(this.decrypted.keys().next().value);
    }
    this.decrypted.set(blob, plain);
    return plain;
  }

  private decryptUncached(blob: string): string {
    try {
      const data = Buffer.from(blob, 'base64');

      const salt = data.subarray(0, SALT_LENGTH);
      const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const authTag = data.subarray(
        SALT_LENGTH + IV_LENGTH,
        SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
      );
      const ciphertext = data.subarray(
        SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
      );

      const key = this.deriveKey(salt);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    } catch {
      // decipher.final() throws on tamper / wrong key. Surface a clear,
      // recoverable error instead of crashing the process (§6.3).
      throw new Error(
        'Failed to decrypt secret — APP_SECRET may have changed; re-enter the API key',
      );
    }
  }
}
