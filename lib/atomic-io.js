// lib/atomic-io.js — crash-safe file writes and safe JSON loads (#264).
// Never overwrite a non-empty destination with empty/corrupt parse results.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Atomically write data to filePath (temp + rename in same directory).
 * @param {string} filePath
 * @param {string|Buffer} data
 */
export async function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Parse JSON safely. On failure returns fallback — never null-by-default wipe.
 * @param {string|Buffer|null|undefined} text
 * @param {any} fallback
 */
export function safeParseJson(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try {
    const v = JSON.parse(typeof text === 'string' ? text : String(text));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Read JSON file; corrupt/missing → fallback (previous in-memory value).
 * @param {string} filePath
 * @param {any} fallback
 */
export async function safeReadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return safeParseJson(raw, fallback);
  } catch {
    return fallback;
  }
}

/** Write JSON atomically. */
export async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2));
}
