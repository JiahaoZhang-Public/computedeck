import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import map from './compat-map.json';
import { tokens } from './tokens';
import {
  blocks,
  checkFallback,
  componentColorViolations,
  declarations,
  deprecatedPluginTokens,
} from './lint';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
it('checks all fallback contexts, including explicit themes and contrast-more', () => {
  expect(() => checkFallback(css)).not.toThrow();
  const start = css.indexOf('@supports not');
  // Every declaration in all eight fallback contexts must be present and correct.
  const end = css.indexOf('@media (forced-colors:', start);
  const matches = [...css.slice(start, end).matchAll(/--[\w-]+: var\(--p-[^;]+;/g)];
  expect(matches).toHaveLength(Object.keys(tokens).length * 8);
  for (const match of matches) {
    const index = start + match.index;
    const prefix = css.slice(0, index);
    const suffix = css.slice(index + match[0].length);
    expect(() => checkFallback(prefix + suffix)).toThrow(/parity/);
    const changed = match[0].replace(/var\([^)]*\)/, 'var(--p-wrong-light)');
    expect(() => checkFallback(prefix + changed + suffix)).toThrow(/parity/);
  }
  expect(() =>
    checkFallback(css.replace('--bg-canvas: var(', '--bg-canvas: light-dark(')),
  ).toThrow();
  expect(() =>
    checkFallback(css.replace('--p-bg-canvas-light: oklch(', '--p-bg-canvas-light: invalid(')),
  ).toThrow();
});

it('ships a forced-fallback file with exactly the same branches', () => {
  expect(readFileSync(new URL('./tokens.fallback-only.css', import.meta.url), 'utf8')).toBe(
    css.replaceAll('light-dark(', 'unsupported-light-dark('),
  );
});
it('keeps all 19 WEB_API 1 names plus the two repaired aliases', () => {
  const compat = declarations(
    blocks(readFileSync(new URL('./tokens-compat.css', import.meta.url), 'utf8'))[0].body,
  );
  expect(Object.keys(map)).toHaveLength(21);
  for (const [name, value] of Object.entries(map))
    expect(compat[name]).toBe(value.startsWith('--') ? `var(${value})` : value);
});
it('rejects literal component colours and private primitives, not masks or semantic tokens', () => {
  expect(
    componentColorViolations(
      '.x { color: var(--p-ink-light); background: #ffffff; fill: red; stroke: rgb(0 0 0); }',
    ),
  ).toHaveLength(4);
  expect(
    componentColorViolations('.x { color: var(--ink); mask: url("data:image/svg+xml,black"); }'),
  ).toEqual([]);
});

it('gives the first six legacy marks six distinct identity slots', () => {
  const styles = blocks(readFileSync(new URL('../styles.css', import.meta.url), 'utf8'));
  const slots = Array.from({ length: 6 }, (_, i) => {
    const rule = styles.find(({ selector }) => selector === `.mark-${i}`);
    const value = declarations(rule?.body ?? '')['--p'];
    expect(value).toMatch(/^var\(--id-[1-6]\)$/);
    return value;
  });
  expect(new Set(slots).size).toBe(6);
});
it('warns only for external build-time plugin source, not core or unrelated files', () => {
  const core = '/example/web/src';
  const code = '.example { color: var(--text); border-radius: var(--radius); }';
  for (const file of ['styles.css', 'Gallery.tsx', 'theme/compat.css', 'pages/Settings.tsx?direct'])
    expect(deprecatedPluginTokens(code, `${core}/${file}`, core)).toEqual([]);
  for (const file of ['/example/plugin/theme/style.css', '/example/web/src-plugin/view.tsx?direct'])
    expect(deprecatedPluginTokens(code, file, core)).toEqual(['--text']);
  expect(deprecatedPluginTokens(code, '/example/plugin/index.js', core)).toEqual([]);
  expect(
    deprecatedPluginTokens('.x { color: var(--ink); }', '/example/plugin/style.css', core),
  ).toEqual([]);
});

it('keeps frozen class variables independent of legacy page styles', () => {
  const compat = readFileSync(new URL('./compat.css', import.meta.url), 'utf8');
  const components = readFileSync(new URL('./components.css', import.meta.url), 'utf8');
  const defined = new Set([
    ...Object.keys(tokens).map((name) => `--${name}`),
    ...Object.keys(map),
    ...[...(components + compat).matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]),
  ]);
  for (const [, name] of compat.matchAll(/var\((--[\w-]+)/g))
    expect(defined.has(name), `Undefined compatibility variable: ${name}`).toBe(true);
});
