import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { deriveVaultKey } from './machineKey.ts';

export class VaultDecryptionError extends Error {
  public readonly code = 'VAULT_DECRYPT_FAILED';
  public readonly statusCode = 422;
  public readonly keyId?: number;

  constructor(message: string, keyId?: number) {
    super(message);
    this.name = 'VaultDecryptionError';
    this.keyId = keyId;
  }
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim(), 'utf8').digest('hex');
}

export function maskApiKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 3)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function encryptApiKey(rawKey: string, customVaultKey?: Buffer): string {
  const key = customVaultKey ?? deriveVaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(rawKey.trim(), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptApiKey(
  encryptedPayload: string,
  optionsOrKey?: Buffer | { db?: DatabaseSync; keyId?: number; customVaultKey?: Buffer }
): string {
  const opts = Buffer.isBuffer(optionsOrKey)
    ? { customVaultKey: optionsOrKey }
    : optionsOrKey;

  const markUnreadableAndThrow = (reason: string): never => {
    if (opts?.db && typeof opts.keyId === 'number') {
      try {
        opts.db
          .prepare(`UPDATE api_keys SET status = 'UNREADABLE' WHERE id = ?`)
          .run(opts.keyId);
      } catch {
        // Ignore secondary update failure
      }
    }
    throw new VaultDecryptionError(
      `Vault key ${opts?.keyId ?? ''} could not be decrypted (${reason}). Please re-enter the API key in Stage 0 Vault.`,
      opts?.keyId
    );
  };

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    return markUnreadableAndThrow('malformed ciphertext envelope');
  }

  const [ivHex, tagHex, cipherHex] = parts;
  if (!ivHex || !tagHex || !cipherHex) {
    return markUnreadableAndThrow('empty envelope segment');
  }

  try {
    const key = opts?.customVaultKey ?? deriveVaultKey();
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');
    if (iv.length !== 12 || tag.length !== 16) {
      return markUnreadableAndThrow('invalid IV or auth tag length');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8'
    );
    if (!decrypted) {
      return markUnreadableAndThrow('empty plaintext');
    }
    return decrypted;
  } catch (err) {
    if (err instanceof VaultDecryptionError) throw err;
    return markUnreadableAndThrow((err as Error).message || 'GCM authentication failed');
  }
}
