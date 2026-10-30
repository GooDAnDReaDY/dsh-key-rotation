#!/usr/bin/env node
// scripts/build-client.mjs — Modern UI client bundler with JSX support via esbuild (#523).
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { atomicWriteFile } from '../lib/atomic-io.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'lib', 'client-src');
const outFile = path.join(root, 'lib', 'client.js');
const MAX_BUNDLE_BYTES = 262144; // 256 KiB DSH Store limit

const isCheck = process.argv.includes('--check');

const files = (await readdir(srcDir))
  .filter((f) => f.endsWith('.js') || f.endsWith('.jsx'))
  .sort();

if (files.length === 0) throw new Error('no client-src fragments found in ' + srcDir);

let rawCombined = '';
for (const f of files) {
  const filePath = path.join(srcDir, f);
  const part = await readFile(filePath, 'utf8');
  rawCombined += part;
  if (!rawCombined.endsWith('\n')) rawCombined += '\n';
}

// Compile complete JSX tree via esbuild with preserved legal comments and UTF-8 charset
const transformed = transformSync(rawCombined, {
  loader: 'jsx',
  target: 'es2020',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  legalComments: 'inline',
  charset: 'utf8',
  minifyWhitespace: false,
  minifySyntax: false,
  minifyIdentifiers: false,
  sourcefile: 'client.jsx',
});

const bundle = transformed.code;

if (isCheck) {
  if (!existsSync(outFile)) {
    console.error('[build-client] ERROR: lib/client.js does not exist on disk!');
    process.exit(1);
  }
  const onDisk = readFileSync(outFile, 'utf8');
  if (onDisk !== bundle) {
    console.error('[build-client] ERROR: lib/client.js on disk is out of sync with lib/client-src/! Run "npm run build:client".');
    process.exit(1);
  }
  console.log(`[build-client] Check mode: lib/client.js is up to date (${bundle.length} bytes).`);
  process.exit(0);
}

await atomicWriteFile(outFile, bundle);
const st = await stat(outFile);

console.log(`built lib/client.js from ${files.length} JSX/JS fragments (${st.size} bytes) via esbuild`);

if (st.size > MAX_BUNDLE_BYTES) {
  console.error(`[build-client] ERROR: lib/client.js (${st.size} bytes) exceeds DSH limit (${MAX_BUNDLE_BYTES} bytes)!`);
  process.exit(1);
}

// Verify syntax
execFileSync(process.execPath, ['--check', outFile], { stdio: 'inherit' });
