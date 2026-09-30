#!/usr/bin/env node
// Concatenate lib/client-src fragments into lib/client.js (single ModuleLoader entry).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from '../lib/atomic-io.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'lib', 'client-src');
const outFile = path.join(root, 'lib', 'client.js');

const files = (await readdir(srcDir)).filter((f) => f.endsWith('.js')).sort();
if (files.length === 0) throw new Error('no client-src fragments found in ' + srcDir);

let out = '';
for (const f of files) {
  out += await readFile(path.join(srcDir, f), 'utf8');
  if (!out.endsWith('\n')) out += '\n';
}
await atomicWriteFile(outFile, out);
console.log(`built lib/client.js from ${files.length} fragments (${out.length} bytes)`);
