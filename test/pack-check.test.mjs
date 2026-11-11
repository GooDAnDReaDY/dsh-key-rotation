import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(root, 'scripts', 'pack-check.mjs');

test('Issue #599: pack-check fails immediately if a *.tgz tarball exists in checkout root', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-krot-pack-check-'));
  try {
    writeFileSync(join(tmpDir, 'goodandready-dsh-key-rotation-0.0.0.tgz'), 'stub');
    const res = spawnSync(process.execPath, [scriptPath], { cwd: tmpDir, encoding: 'utf8' });
    assert.notEqual(res.status, 0, 'pack-check must fail when .tgz exists in cwd');
    assert.match(res.stderr, /Release tarballs found in checkout root/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
