// lib/atomic-io.js — crash-safe file writes and safe JSON loads (#264, #521).
// Never overwrite a non-empty destination with empty/corrupt parse results.
// Clean up orphaned temporary files on failure or during startup.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Atomically write data to filePath (temp + rename in same directory).
 * Cleans up temporary file if open, write, sync, or rename fails (#521).
 * @param {string} filePath
 * @param {string|Buffer} data
 */
export async function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fh = null;
  try {
    fh = await fs.open(tmp, 'w');
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.rename(tmp, filePath);
  } catch (err) {
    if (fh) {
      try { await fh.close(); } catch {}
    }
    try { await fs.unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Clean up stale temporary files left behind by crashed or interrupted writes (#521).
 * @param {string} filePath
 * @param {number} [maxAgeMs=3600000]
 * @returns {Promise<number>} number of files unlinked
 */
export async function cleanupStaleTmpFiles(filePath, maxAgeMs = 3600000) {
  if (!filePath || typeof filePath !== 'string') return 0;
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const prefix = `.${base}.`;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    let cleaned = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(prefix) && entry.name.endsWith('.tmp')) {
        const fullPath = path.join(dir, entry.name);
        try {
          const st = await fs.stat(fullPath);
          if (now - st.mtimeMs > maxAgeMs) {
            await fs.unlink(fullPath);
            cleaned++;
          }
        } catch {}
      }
    }
    return cleaned;
  } catch {
    return 0;
  }
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
