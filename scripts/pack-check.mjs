#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const WARN_LIMIT = 256000; // 250 KiB practical threshold (#599)
const BLOCK_LIMIT = 262144; // 256 KiB DSH Store hard limit

// Ensure release tarballs are not left in source root (#310, #599)
const rootFiles = fs.readdirSync(process.cwd());
const strayTarballs = rootFiles.filter((f) => f.endsWith('.tgz'));
if (strayTarballs.length > 0) {
  console.error(`[pack:check] ERROR: Release tarballs found in checkout root: ${strayTarballs.join(', ')}. Artifacts must be created outside checkout via "npm pack --pack-destination /tmp".`);
  process.exit(1);
}

const FORBIDDEN_PREFIXES = [
  'docs/',
  'test/',
  'tools/',
  'scripts/',
  'lib/client-src/',
  '.worktrees/',
  '.gitea/',
  '.github/',
];
const FORBIDDEN_EXACT = new Set([
  'AGENTS.md',
  'index.md',
  '.gitignore',
  '.gitattributes',
  'pnpm-lock.yaml',
  'package-lock.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'TESTING.md',
]);

try {
  const jsonStr = execSync('npm pack --dry-run --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(jsonStr);
  let pkg = parsed;
  if (Array.isArray(parsed)) {
    pkg = parsed[0];
  } else if (parsed && typeof parsed === 'object') {
    const values = Object.values(parsed);
    if (values.length > 0 && values[0]?.files) {
      pkg = values[0];
    }
  }
  const files = pkg?.files || [];
  if (!Array.isArray(files) || files.length === 0) {
    console.error('[pack:check] ERROR: npm pack --dry-run --json returned no files.');
    process.exit(1);
  }

  let failed = false;
  for (const f of files) {
    const p = f.path || '';
    if (FORBIDDEN_EXACT.has(p) || FORBIDDEN_PREFIXES.some((pref) => p.startsWith(pref))) {
      console.error(`[pack:check] ERROR: Forbidden internal/non-product file in package: "${p}"`);
      failed = true;
    }
    if (f.size > BLOCK_LIMIT) {
      console.error(`[pack:check] ERROR: File "${p}" (${f.size} bytes) exceeds DSH Store block limit ${BLOCK_LIMIT} bytes`);
      failed = true;
    } else if (f.size >= WARN_LIMIT) {
      console.warn(`[pack:check] WARN: File "${p}" (${f.size} bytes) is close to DSH Store limit (${BLOCK_LIMIT} bytes)`);
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`[pack:check] OK: ${files.length} files packed (${pkg.size} bytes packed / ${pkg.unpackedSize} bytes unpacked). Zero stray *.tgz, all files <= ${BLOCK_LIMIT} bytes.`);
} catch (err) {
  console.error('[pack:check] Failed to check pack size:', err.message || err);
  process.exit(1);
}
