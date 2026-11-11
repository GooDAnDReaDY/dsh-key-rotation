import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
const walkAll = (path, out) => {
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, item.name);
    if (item.isDirectory()) {
      if (item.name !== 'client-src') walkAll(full, out);
    } else if (/\.(mjs|js)$/.test(item.name)) {
      out.push(full);
    }
  }
};
for (const dir of ['lib', 'test', 'tools', 'scripts']) {
  walkAll(join(root, dir), files);
}

JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const file of files) {
  const run = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', timeout: 10000 });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

// Hygiene scan (#601): disallow infrastructure paths, service names, machine names, and LAN IPs
const scanTargets = [
  ...files,
  join(root, 'CHANGELOG.md'),
  join(root, 'README.md'),
  join(root, 'README.ru.md'),
  join(root, 'README.zh.md'),
];

const forbiddenPatterns = [
  { label: 'home path', re: new RegExp('/ho' + 'me/', 'i') },
  { label: 'mnt path', re: new RegExp('/mn' + 't/', 'i') },
  { label: 'test unit name', re: new RegExp('dsh-test-' + 'web', 'i') },
  { label: 'host label', re: new RegExp('Mini' + '(?:PC|AI)', 'i') },
  { label: 'LAN IPv4', re: new RegExp('\\b192\\.' + '168\\.\\d+\\.\\d+(?!/16\\b)') },
];

const leaks = [];
for (const full of scanTargets) {
  const rel = relative(root, full).replace(/\\/g, '/');
  if (rel === 'tools/check.mjs') continue;
  const text = readFileSync(full, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const pat of forbiddenPatterns) {
      if (pat.re.test(lines[i])) {
        leaks.push(`${rel}:${i + 1} [${pat.label}]: ${lines[i].trim()}`);
      }
    }
  }
}

if (leaks.length > 0) {
  console.error('[check] ERROR: Forbidden infrastructure paths/hosts/IPs found in checked files:');
  for (const l of leaks) console.error('  ' + l);
  process.exit(1);
}

console.log(`Syntax checked ${files.length} JavaScript files, package.json, and scanned ${scanTargets.length} files for path/IP hygiene.`);
