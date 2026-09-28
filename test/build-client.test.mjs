import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('lib/client-src fragments exist and follow naming convention', () => {
  const srcDir = path.join(root, 'lib', 'client-src');
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length >= 5, 'expected at least 5 client fragments');
  for (const f of files) {
    assert.match(f, /^\d{2}-[\w-]+\.js$/, `fragment name ${f} matches convention`);
  }
});

test('scripts/build-client.mjs produces deterministic lib/client.js matching disk', () => {
  const clientOnDisk = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  const run = spawnSync(process.execPath, ['scripts/build-client.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `build script failed: ${run.stderr}`);
  const clientAfterBuild = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  assert.equal(clientAfterBuild, clientOnDisk, 'lib/client.js on disk must match fresh build output');
});

test('package.json scripts and files include build:client and exclude client-src', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:client'], 'node scripts/build-client.mjs');
  assert.equal(pkg.scripts['pretest'], 'node scripts/build-client.mjs');
  assert.ok(pkg.files.includes('lib/*.js'), 'files must include lib/*.js');
  assert.ok(!pkg.files.includes('lib'), 'files must not include naked lib to keep client-src out of tarball');
});
