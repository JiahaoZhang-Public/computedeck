import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Deterministic incompressible bytes, so a limit test cannot pass through compression.
function bytes(length) {
  const value = Buffer.alloc(length);
  let state = 42;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    value[i] = state & 255;
  }
  return value;
}

const requiredEntries = [
  ...['Plan', 'Usage', 'Toolbox', 'Notify', 'Chat', 'Settings', 'Clusters'].map(
    (name) => `src/pages/${name}.tsx`,
  ),
  'src/forms.tsx',
  'src/Gallery.tsx',
  'src/locales/en.ts',
  'src/locales/zh-CN.ts',
];

function build(files, manifest, run) {
  files = { ...files };
  manifest = { ...manifest };
  for (const key of requiredEntries) {
    if (!(key in manifest)) {
      const file = `${path.basename(key)}.js`;
      files[file] = 0;
      manifest[key] = { file, isDynamicEntry: true };
    } else if (manifest[key] === null) {
      delete manifest[key];
    }
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'computedeck-size-'));
  try {
    mkdirSync(path.join(directory, '.vite'));
    writeFileSync(path.join(directory, '.vite/manifest.json'), JSON.stringify(manifest));
    for (const [name, length] of Object.entries(files))
      writeFileSync(path.join(directory, name), bytes(length));
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const script = new URL('./check-size.mjs', import.meta.url).pathname;

test('counts static imports once and excludes lazy routes from the initial budget', () => {
  build(
    { 'index.js': 100_000, 'shared.js': 60_000, 'route.js': 25_000, 'other.js': 25_000 },
    {
      index: {
        isEntry: true,
        file: 'index.js',
        imports: ['shared', 'shared'],
        dynamicImports: ['route', 'other'],
      },
      shared: { file: 'shared.js' },
      route: { file: 'route.js' },
      other: { file: 'other.js' },
    },
    (directory) => {
      const output = execFileSync(process.execPath, [script, directory], { encoding: 'utf8' });
      assert.match(output, /Initial JS.*160\d+ bytes/);
    },
  );
});

for (const [name, files, manifest] of [
  [
    'initial imports',
    { 'index.js': 100_000, 'shared.js': 71_000 },
    {
      index: { isEntry: true, file: 'index.js', imports: ['shared'] },
      shared: { file: 'shared.js' },
    },
  ],
  [
    'route chunk',
    { 'index.js': 10, 'route.js': 31_000 },
    {
      index: { isEntry: true, file: 'index.js' },
      route: { file: 'route.js' },
    },
  ],
  [
    'palette chunk',
    { 'index.js': 10, 'palette.js': 16_000 },
    {
      index: { isEntry: true, file: 'index.js' },
      palette: { file: 'palette.js' },
    },
  ],
  [
    'CSS total',
    { 'index.js': 10, 'a.css': 9_000, 'b.css': 9_000 },
    {
      index: { isEntry: true, file: 'index.js', css: ['a.css', 'b.css'] },
    },
  ],
]) {
  test(`rejects oversized ${name}`, () => {
    build(files, manifest, (directory) => {
      assert.equal(spawnSync(process.execPath, [script, directory]).status, 1);
    });
  });
}

test('includes the larger active locale and its static imports once in the initial budget', () => {
  build(
    { 'index.js': 135_000, 'en.js': 20_000, 'zh.js': 24_000, 'shared.js': 12_000 },
    {
      index: {
        isEntry: true,
        file: 'index.js',
        imports: ['shared'],
        dynamicImports: ['src/locales/en.ts', 'src/locales/zh-CN.ts'],
      },
      shared: { file: 'shared.js' },
      'src/locales/en.ts': { file: 'en.js', imports: ['shared'], isDynamicEntry: true },
      'src/locales/zh-CN.ts': { file: 'zh.js', imports: ['shared'], isDynamicEntry: true },
    },
    (directory) => {
      const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Initial JS.*171\d+ bytes.*170000 bytes/);
    },
  );
});

test('reports single-locale startup and the server-default case separately', () => {
  build(
    { 'index.js': 124_000, 'en.js': 20_000, 'zh.js': 24_000 },
    {
      index: {
        isEntry: true,
        file: 'index.js',
        dynamicImports: ['src/locales/en.ts', 'src/locales/zh-CN.ts'],
      },
      'src/locales/en.ts': { file: 'en.js', isDynamicEntry: true },
      'src/locales/zh-CN.ts': { file: 'zh.js', isDynamicEntry: true },
    },
    (directory) => {
      const output = execFileSync(process.execPath, [script, directory], { encoding: 'utf8' });
      assert.match(output, /Initial JS with device\/remembered locale.*148\d+ bytes/);
      assert.match(output, /Initial JS with server-default change.*168\d+ bytes/);
    },
  );
});

test('rejects a server-default startup over the ceiling even when one locale fits', () => {
  build(
    { 'index.js': 130_000, 'en.js': 20_000, 'zh.js': 24_000 },
    {
      index: { isEntry: true, file: 'index.js' },
      'src/locales/en.ts': { file: 'en.js', isDynamicEntry: true },
      'src/locales/zh-CN.ts': { file: 'zh.js', isDynamicEntry: true },
    },
    (directory) => {
      const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /device\/remembered locale.*154\d+ bytes/);
      assert.match(result.stdout, /server-default change.*174\d+ bytes.*170000 bytes/);
    },
  );
});

for (const key of requiredEntries) {
  test(`rejects a missing lazy entry: ${key}`, () => {
    build(
      { 'index.js': 10 },
      { index: { isEntry: true, file: 'index.js' }, [key]: null },
      (directory) => {
        const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.ok(
          result.stderr.includes(`Expected a lazy entry outside the initial import graph: ${key}`),
        );
      },
    );
  });
}

test('rejects a lazy entry pulled into the static import graph', () => {
  build(
    { 'index.js': 10 },
    { index: { isEntry: true, file: 'index.js', imports: ['src/pages/Usage.tsx'] } },
    (directory) => {
      const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Expected a lazy entry.*src\/pages\/Usage.tsx/);
    },
  );
});
