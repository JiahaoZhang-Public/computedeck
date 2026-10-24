import path from 'node:path';
import compatMap from './compat-map.json' with { type: 'json' };
import { tokens, contrastMore } from './tokens.ts';
import { cssColor } from './color.ts';

// Small block reader for the generator's CSS (selectors, declarations, nested media).
// It deliberately does not parse arbitrary component CSS or data URLs.
export function blocks(source: string) {
  const result: { selector: string; body: string }[] = [];
  source = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open === -1) break;
    let end = open + 1;
    let depth = 1;
    while (depth && end < source.length) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
      end++;
    }
    if (depth) throw new Error('Unclosed CSS block');
    result.push({
      selector: source.slice(cursor, open).trim(),
      body: source.slice(open + 1, end - 1),
    });
    cursor = end;
  }
  return result;
}
export function declarations(body: string) {
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
  );
}
export function checkFallback(css: string) {
  const root = blocks(css);
  const fallback = root.find(
    ({ selector }) => selector === '@supports not (color: light-dark(#000, #fff))',
  );
  if (!fallback) throw new Error('Missing light-dark fallback');
  if (fallback.body.includes('light-dark(')) throw new Error('light-dark in fallback');
  const primitive = root.find(({ body }) => body.includes('--p-bg-canvas-light:'));
  if (!primitive) throw new Error('Missing primitives');
  const primitives = declarations(primitive.body);
  for (const more of [false, true]) {
    const modernBlock = more
      ? blocks(
          root.find(({ selector }) => selector === '@media (prefers-contrast: more)')?.body ?? '',
        )[0]
      : root.find(({ body }) => body.includes('--bg-canvas: light-dark('));
    const modern = declarations(modernBlock?.body ?? '');
    const outer = blocks(fallback.body);
    const contexts = more
      ? blocks(
          outer.find(({ selector }) => selector === '@media (prefers-contrast: more)')?.body ?? '',
        )
      : outer;
    for (const [selector, theme] of [
      [':root', 'light'],
      [':root:not([data-theme="light"])', 'dark'],
      [':root[data-theme="light"]', 'light'],
      [':root[data-theme="dark"]', 'dark'],
    ] as const) {
      const candidates = selector.includes(':not(')
        ? blocks(
            contexts.find(({ selector }) => selector === '@media (prefers-color-scheme: dark)')
              ?.body ?? '',
          )
        : contexts;
      const values = declarations(
        candidates.find((item) => item.selector === selector)?.body ?? '',
      );
      for (const name of Object.keys(tokens)) {
        const source = more ? (contrastMore[name] ?? name) : name;
        const expected = cssColor(tokens[source][theme]);
        if (
          values[`--${name}`] !== `var(--p-${source}-${theme})` ||
          primitives[`--p-${source}-${theme}`] !== expected ||
          modern[`--${name}`] !== `light-dark(var(--p-${source}-light), var(--p-${source}-dark))`
        )
          throw new Error(`Fallback parity: ${name}, ${selector}, contrast-more=${more}`);
      }
    }
  }
}
export function componentColorViolations(source: string) {
  // SVG masks encode geometry, not rendered colours. Comments cannot introduce a colour.
  source = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([\s\S]*?\)/g, '');
  return [
    ...source.matchAll(
      /var\(\s*--p-[\w-]+|#[\da-f]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?|lab|lch)\(|(?:color|background(?:-color)?|border(?:-color)?|fill|stroke)\s*:\s*['"]?(?:white|black|red|blue|green|gray)\b/gi,
    ),
  ].map((match) => match[0]);
}

// Only build-time plugin modules outside core source pass through this dev warning.
export function deprecatedPluginTokens(code: string, id: string, coreDirectory: string) {
  const filename = id.split('?')[0];
  const relative = path.relative(coreDirectory, filename);
  if (
    !/\.(css|tsx|jsx)$/.test(filename) ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
    return [];
  return Object.keys(compatMap).filter(
    (name) =>
      !['--radius', '--radius-sm', '--mono'].includes(name) && code.includes(`var(${name})`),
  );
}
