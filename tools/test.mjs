import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const core = process.argv.includes('--core');
if (core && !(process.env.DSH_TEST_CORE_DIR && process.env.DSH_TEST_CORE_VERSION)) {
  console.error('test:core requires DSH_TEST_CORE_DIR and DSH_TEST_CORE_VERSION (see TESTING.md).');
  process.exit(1);
}
// Explicit discovery avoids counting lib/ops-test.js as a test and avoids
// shell glob differences between Windows and POSIX. Node 18 has no test-timeout
// CLI flag, so the runner owns an overall deadline instead.
const files = readdirSync(join(root, 'test')).filter(name => /\.test\.(?:mjs|js)$/.test(name))
  .filter(name => core === (name === 'real-core.test.mjs')).sort().map(name => join(root, 'test', name));
if (!files.length) throw new Error('No regression tests discovered');
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', timeout: 120000 });
if (run.error) console.error(run.error.message);
process.exit(run.status ?? 1);
