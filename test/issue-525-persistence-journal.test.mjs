import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatePersistence } from '../lib/persistence.js';

test('issue #525 - StatePersistence appendEvent and replay journal', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persist-test-'));
  const filePath = path.join(tmpDir, 'state.json');

  try {
    const sp = new StatePersistence({ filePath });
    assert.equal(sp.journalPath, path.join(tmpDir, 'state-journal.jsonl'));

    // 1. Initial snapshot write
    const initialPoolState = new Map();
    initialPoolState.set('openai', {
      failedUntil: new Map([['key-1', 1000]]),
      revokedRefs: new Set(),
      pausedRefs: new Set(),
      pointer: 0,
      lastUsed: 'key-1',
    });

    const snapshot = StatePersistence.serialize({ poolState: initialPoolState });
    sp.save(snapshot);
    await sp.flush();

    assert.ok(fs.existsSync(filePath));

    // 2. Append events to journal without full snapshot rewrite
    await sp.appendEvent({ type: 'cooldown', pool: 'openai', ref: 'key-2', until: 5000 });
    await sp.appendEvent({ type: 'pause', pool: 'openai', ref: 'key-3' });
    await sp.appendEvent({ type: 'revoke', pool: 'openai', ref: 'key-4' });

    assert.ok(fs.existsSync(sp.journalPath));
    const journalRaw = fs.readFileSync(sp.journalPath, 'utf-8');
    assert.ok(journalRaw.includes('key-2'));
    assert.ok(journalRaw.includes('key-3'));
    assert.ok(journalRaw.includes('key-4'));

    // 3. Load snapshot with replayed journal
    const loaded = await sp.load();
    assert.ok(loaded);
    assert.equal(loaded.pools.openai.failedUntil['key-1'], 1000);
    assert.equal(loaded.pools.openai.failedUntil['key-2'], 5000);
    assert.ok(loaded.pools.openai.pausedRefs.includes('key-3'));
    assert.ok(loaded.pools.openai.revokedRefs.includes('key-4'));

    // 4. Flush truncates/rotates journal
    sp.save(loaded);
    await sp.flush();
    const rotatedJournal = fs.readFileSync(sp.journalPath, 'utf-8');
    assert.equal(rotatedJournal.trim(), '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
