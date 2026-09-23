import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

function saveBlock() {
  const start = source.indexOf('      const save = () => {');
  const end = source.indexOf('      const field =', start);
  assert.notEqual(start, -1, 'save() block must exist');
  assert.notEqual(end, -1, 'field helper must follow save()');
  return source.slice(start, end);
}

test('browser client bundle parses as JavaScript', () => {
  assert.doesNotThrow(() => new Function(source));
});

test('legacy settingsScope writes go through the revision-reporting bridge', () => {
  assert.match(source, /return \{ kind: 'settingsScope', service: scope \};/);
  const save = saveBlock();
  assert.match(save, /settingsContract === 'configForm'/);
  assert.match(save, /settingsScope\.mutate\(ops, expectedRevision\)/);
  assert.doesNotMatch(save, /settingsScope\.set\(/);
  assert.match(save, /JSON\.stringify\(\{ section: savingDraft, expectedRevision \}\)/);
  assert.match(save, /saveViaBridge\(\);\s*\n      \};/);
});

test('staged edits keep their original revision fence', () => {
  assert.match(source, /draftRevisionRef\.current = state\.revision/);
  const save = saveBlock();
  assert.match(save, /const savingDraft = draft;/);
  assert.match(save, /const expectedRevision = draftRevisionRef\.current \?\? state\.revision;/);
  assert.doesNotMatch(save, /section: savingDraft, expectedRevision: state\.revision/);
});

test('in-flight saves cannot clear newer edits or be double-submitted', () => {
  assert.match(source, /const saveInFlightRef = React\.useRef\(false\)/);
  assert.match(source, /if \(saveInFlightRef\.current\) return;/);
  assert.match(source, /btn\(t\('save'\), save, \{ primary: true, disabled: state\.status === 'saving' \}\)/);
  assert.match(source, /btn\(t\('discard'\), \(\) => \{/);
  assert.match(source, /clearDraft\(\);\s*\n\s*load\(\);/);
});
