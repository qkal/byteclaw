/**
 * Secret Encryption at Rest
 * Provides AES-256-GCM encryption for sensitive data storage
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

export interface EncryptionOptions {
  key: string;
  salt?: string;
  ivLength?: number;
  keyLength?: number;
}

export interface EncryptedData {
  iv: string;
  salt: string;
  data: string;
  authTag: string;
}

/**
 * Derive encryption key from password using scrypt
 */
function deriveKey(password: string, salt: Buffer, keyLength: number = 32): Buffer {
  return scryptSync(password, salt, keyLength);
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encrypt(text: string, options: EncryptionOptions): EncryptedData {
  const salt = options.salt ? Buffer.from(options.salt, 'hex') : randomBytes(16);
  const ivLength = options.ivLength ?? 16;
  const keyLength = options.keyLength ?? 32;

  const key = deriveKey(options.key, salt, keyLength);
  const iv = randomBytes(ivLength);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    data: encrypted,
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt data using AES-256-GCM
 */
export function decrypt(encryptedData: EncryptedData, options: EncryptionOptions): string {
  const salt = Buffer.from(encryptedData.salt, 'hex');
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const keyLength = options.keyLength ?? 32;

  const key = deriveKey(options.key, salt, keyLength);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));

  let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Encrypt an object (JSON)
 */
export function encryptObject<T extends Record<string, unknown>>(
  obj: T,
  options: EncryptionOptions,
): EncryptedData {
  const text = JSON.stringify(obj);
  return encrypt(text, options);
}

/**
 * Decrypt an object (JSON)
 */
export function decryptObject<T extends Record<string, unknown>>(
  encryptedData: EncryptedData,
  options: EncryptionOptions,
): T {
  const text = decrypt(encryptedData, options);
  return JSON.parse(text) as T;
}

/**
 * Generate a random encryption key
 */
export function generateEncryptionKey(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Generate a random salt
 */
export function generateSalt(length: number = 16): string {
  return randomBytes(length).toString('hex');
}

/**
 * Secret Manager for managing encrypted secrets
 */
export class SecretManager {
  private encryptionKey: string;
  private secrets: Map<string, EncryptedData> = new Map();

  constructor(encryptionKey: string) {
    this.encryptionKey = encryptionKey;
  }

  /**
   * Store a secret
   */
  setSecret(key: string, value: string): void {
    const encrypted = encrypt(value, { key: this.encryptionKey });
    this.secrets.set(key, encrypted);
  }

  /**
   * Retrieve a secret
   */
  getSecret(key: string): string | null {
    const encrypted = this.secrets.get(key);
    if (!encrypted) return null;
    return decrypt(encrypted, { key: this.encryptionKey });
  }

  /**
   * Delete a secret
   */
  deleteSecret(key: string): void {
    this.secrets.delete(key);
  }

  /**
   * Check if a secret exists
   */
  hasSecret(key: string): boolean {
    return this.secrets.has(key);
  }

  /**
   * Get all secret keys
   */
  listSecrets(): string[] {
    return Array.from(this.secrets.keys());
  }

  /**
   * Clear all secrets
   */
  clear(): void {
    this.secrets.clear();
  }

  /**
   * Export secrets (for backup)
   */
  exportSecrets(): Record<string, EncryptedData> {
    return Object.fromEntries(this.secrets);
  }

  /**
   * Import secrets (for restore)
   */
  importSecrets(secrets: Record<string, EncryptedData>): void {
    for (const [key, value] of Object.entries(secrets)) {
      this.secrets.set(key, value);
    }
  }
}

/**
 * Create a secret manager instance
 */
export function createSecretManager(encryptionKey: string): SecretManager {
  return new SecretManager(encryptionKey);
}
