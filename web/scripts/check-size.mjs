// Vite's build manifest identifies the initial static import graph, without counting lazy routes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const directory = path.resolve(process.argv[2] || 'dist');
const manifest = JSON.parse(readFileSync(path.join(directory, '.vite/manifest.json'), 'utf8'));
const entry = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entry) throw new Error('No Vite entry found');
const initial = new Set();
function visit(key) {
  if (initial.has(key)) return;
  initial.add(key);
  for (const dependency of manifest[key].imports || []) visit(dependency);
}
visit(entry);
const size = (file) => gzipSync(readFileSync(path.join(directory, file))).length;
let failed = false;
function check(label, bytes, ceiling) {
  console.log(`${label}: ${bytes} bytes gzip / ${ceiling} bytes`);
  if (bytes > ceiling) failed = true;
}
check(
  'Initial JS (target 160 KB)',
  [...initial].reduce((sum, key) => sum + size(manifest[key].file), 0),
  200_000,
);
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
