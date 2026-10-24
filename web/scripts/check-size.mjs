// Vite's build manifest identifies the initial static import graph, without counting lazy routes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const directory = path.resolve(process.argv[2] || 'dist');
const manifest = JSON.parse(readFileSync(path.join(directory, '.vite/manifest.json'), 'utf8'));
const entry = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entry) throw new Error('No Vite entry found');
function importsOf(key, result = new Set()) {
  if (result.has(key)) return result;
  result.add(key);
  for (const dependency of manifest[key].imports || []) importsOf(dependency, result);
  return result;
}
const initial = importsOf(entry);
const size = (file) => gzipSync(readFileSync(path.join(directory, file))).length;
const jsSize = (keys) => [...keys].reduce((sum, key) => sum + size(manifest[key].file), 0);
// A cold Overview also needs its selected dictionary, even though it is dynamically imported.
const localeEntries = Object.keys(manifest).filter((key) =>
  /^src\/locales\/(en|zh-CN)\.ts$/.test(key),
);
const initialSize = Math.max(
  jsSize(initial),
  ...localeEntries.map((key) => jsSize(new Set([...initial, ...importsOf(key)]))),
);
let failed = false;
function check(label, bytes, ceiling) {
  console.log(`${label}: ${bytes} bytes gzip / ${ceiling} bytes`);
  if (bytes > ceiling) failed = true;
}
check('Initial JS including active locale (target 160 KB)', initialSize, 170_000);
const css = new Set();
for (const [key, chunk] of Object.entries(manifest)) {
  for (const file of chunk.css || []) css.add(file);
  if (chunk.file.endsWith('.css')) css.add(chunk.file);
  if (!initial.has(key) && chunk.file.endsWith('.js')) {
    check(chunk.file, size(chunk.file), /palette/i.test(key) ? 15_000 : 30_000);
  }
}
check(
  'CSS',
  [...css].reduce((sum, file) => sum + size(file), 0),
  16_000,
);
if (failed) process.exitCode = 1;
