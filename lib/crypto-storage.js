// lib/crypto-storage.js — AES-256-GCM encryption for credentials at rest (#370)
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function getDerivedKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypt plaintext using AES-256-GCM if secretKey is provided.
 * If secretKey is not set, returns plaintext as-is.
 */
export function encryptSecret(plaintext, secretKey = process.env.DSH_KEY_SECRET) {
  if (!secretKey || !plaintext || typeof plaintext !== 'string') return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext; // already encrypted
  const key = getDerivedKey(secretKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${PREFIX}${iv.toString('hex')}:${authTag}:${ciphertext}`;
}

/**
 * Decrypt ciphertext using AES-256-GCM if prefixed with enc:v1:.
 * If not encrypted, or if secretKey is missing/incorrect, returns safe fallback.
 */
export function decryptSecret(ciphertext, secretKey = process.env.DSH_KEY_SECRET) {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  if (!ciphertext.startsWith(PREFIX)) return ciphertext; // plaintext fallback
  if (!secretKey) return ciphertext;
  try {
    const parts = ciphertext.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return ciphertext;
    const [ivHex, tagHex, dataHex] = parts;
    const key = getDerivedKey(secretKey);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(dataHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return ciphertext;
  }
}
