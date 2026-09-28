import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readLockPid,
  isPidAlive,
  checkAndCleanLock,
  installExact,
  registerPluginUpdater
} from '../lib/plugin-updater.js';

test('readLockPid: extracts PID from json, numeric string, or regex', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const lockPath = join(tmp, 'package.json.lock');
    assert.equal(readLockPid(lockPath), undefined);

    writeFileSync(lockPath, JSON.stringify({ pid: 12345 }), 'utf8');
    assert.equal(readLockPid(lockPath), 12345);

    writeFileSync(lockPath, '54321\n', 'utf8');
    assert.equal(readLockPid(lockPath), 54321);

    writeFileSync(lockPath, 'invalid', 'utf8');
    assert.equal(readLockPid(lockPath), undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('isPidAlive: true for self, false for dead pid', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(9999999), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(undefined), false);
});

test('checkAndCleanLock: cleans dead PID lock, retains live PID lock', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const lockPath = join(tmp, 'package.json.lock');

    // No lock
    assert.deepEqual(checkAndCleanLock(tmp), { locked: false });

    // Dead PID lock
    writeFileSync(lockPath, JSON.stringify({ pid: 9999999 }), 'utf8');
    assert.equal(existsSync(lockPath), true);
    const deadCheck = checkAndCleanLock(tmp);
    assert.equal(deadCheck.locked, false);
    assert.equal(deadCheck.cleaned, true);
    assert.equal(existsSync(lockPath), false);

    // Live PID lock
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), 'utf8');
    assert.equal(existsSync(lockPath), true);
    const liveCheck = checkAndCleanLock(tmp);
    assert.equal(liveCheck.locked, true);
    assert.equal(liveCheck.pid, process.pid);
    assert.equal(existsSync(lockPath), true);

    // Matching childPid cleans lock even if alive
    const childCheck = checkAndCleanLock(tmp, process.pid);
    assert.equal(childCheck.locked, false);
    assert.equal(childCheck.cleaned, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installExact: throws 409 ELOCKED if profile is locked', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const lockPath = join(tmp, 'package.json.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), 'utf8');
    
    await assert.rejects(
      installExact(
        { cliEntry: '/fake/dsh', profileName: 'test', profileDir: tmp },
        '@goodandready/dsh-key-rotation@0.8.32'
      ),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, 'ELOCKED');
        return true;
      }
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installExact: timeout cleans up lockfile and kills child', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lock-test-'));
  const scriptPath = join(tmp, 'mock-cli.mjs');
  // Mock cli script that creates package.json.lock and sleeps
  writeFileSync(scriptPath, `
    import { writeFileSync } from 'node:fs';
    writeFileSync('package.json.lock', JSON.stringify({ pid: process.pid }));
    setTimeout(() => {}, 60000);
  `, 'utf8');

  try {
    await assert.rejects(
      installExact(
        { cliEntry: scriptPath, profileName: 'test', profileDir: tmp },
        '@goodandready/dsh-key-rotation@0.8.32',
        { timeoutMs: 150 }
      ),
      (err) => err.message.includes('timed out')
    );

    // Wait a brief tick for cleanup
    await new Promise(r => setTimeout(r, 600));
    assert.equal(existsSync(join(tmp, 'package.json.lock')), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installExact: arguments do not contain minimumReleaseAge=0', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lock-test-'));
  const scriptPath = join(tmp, 'mock-cli.mjs');
  writeFileSync(scriptPath, `
    const args = process.argv.slice(2);
    if (args.some(a => a.includes('minimumReleaseAge'))) {
      process.exit(1);
    }
    process.exit(0);
  `, 'utf8');

  try {
    await installExact(
      { cliEntry: scriptPath, profileName: 'test', profileDir: tmp },
      '@goodandready/dsh-key-rotation@0.8.32'
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('registerPluginUpdater: returns 409 when profile has live lock', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    writeFileSync(join(tmp, 'package.json.lock'), JSON.stringify({ pid: process.pid }));
    let registeredHandler;
    const mockCtx = {
      webServer: {
        register: ({ handler }) => { registeredHandler = handler; }
      }
    };

    registerPluginUpdater(mockCtx, {
      endpoint: '/update',
      packageName: '@goodandready/dsh-key-rotation',
      manifestUrl: new URL('../package.json', import.meta.url),
    });

    const req = {
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        'x-dsh-plugin-update': '1',
        origin: 'http://127.0.0.1:3080',
        host: '127.0.0.1:3080',
        'sec-fetch-site': 'same-origin'
      }
    };
    let responseStatus;
    let responseBody = '';
    const res = {
      writeHead: (status) => { responseStatus = status; },
      end: (chunk) => { if (chunk) responseBody += chunk; }
    };

    const origEnv = process.env.DSH_PROFILE_DIR;
    process.env.DSH_PROFILE_DIR = tmp;
    try {
      await registeredHandler(req, res);
      assert.equal(responseStatus, 409);
      assert.match(responseBody, /Another plugin installation is currently in progress/);
    } finally {
      process.env.DSH_PROFILE_DIR = origEnv;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
