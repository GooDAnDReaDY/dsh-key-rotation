import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
for (const dir of ['lib', 'test', 'tools']) {
  const walk = path => { for (const item of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, item.name);
    if (item.isDirectory()) walk(full); else if (/\.(mjs|js)$/.test(item.name)) files.push(full);
  } }; walk(join(root, dir));
}
JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const file of files) {
  const run = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', timeout: 10000 });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
console.log(`Syntax checked ${files.length} JavaScript files and package.json.`);
