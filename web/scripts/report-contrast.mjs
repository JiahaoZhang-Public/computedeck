import { tokens, contrastMore } from '../src/theme/tokens.ts';
import { apca, contrast } from '../src/theme/color.ts';
const backgrounds = ['canvas', 'surface', 'sunken', 'hover', 'selected'].map(
  (name) => `bg-${name}`,
);
console.log(
  'Contrast minima across row backgrounds (WCAG gates in Vitest; APCA Lc advisory only):',
);
for (const theme of ['light', 'dark'])
  for (const more of [false, true]) {
    const color = (name) => tokens[more ? (contrastMore[name] ?? name) : name][theme];
    for (const name of [
      'fg-default',
      'fg-muted',
      'fg-subtle',
      ...['ok', 'wait', 'warn', 'error', 'unknown', 'off'].map((state) => `status-${state}-fg`),
    ]) {
      const bgs = name.startsWith('status-')
        ? [...backgrounds, name.replace(/-fg$/, '-bg')]
        : backgrounds;
      const wcag = Math.min(...bgs.map((bg) => contrast(color(name), color(bg))));
      const lc = Math.min(...bgs.map((bg) => Math.abs(apca(color(name), color(bg)))));
      console.log(
        `${theme}${more ? '/more' : ''} ${name}: WCAG ${wcag.toFixed(2)}; |Lc| ${lc.toFixed(1)}`,
      );
    }
  }
