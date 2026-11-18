import { describe, expect, it } from 'vitest';
import { tokens, contrastMore } from './tokens';
import { apca, contrast, deltaE, linearRGB } from './color';

const backgrounds = ['canvas', 'surface', 'sunken', 'hover', 'selected', 'raised', 'overlay'].map(
  (name) => `bg-${name}`,
);
const states = ['ok', 'wait', 'warn', 'error', 'unknown', 'off'];

describe.each(['light', 'dark'] as const)('%s contrast', (theme) => {
  for (const more of [false, true]) {
    const color = (name: string) => tokens[more ? (contrastMore[name] ?? name) : name][theme];
    const pairs: [string, string, number][] = [];
    for (const bg of backgrounds) {
      for (const fg of ['fg-default', 'fg-muted', 'fg-subtle', 'accent-fg'])
        pairs.push([fg, bg, 4.5]);
      for (const mark of [
        'border-strong',
        'focus-ring',
        'accent-fill',
        'chart-line',
        'chart-bar',
        ...Array.from({ length: 6 }, (_, i) => `id-${i + 1}`),
      ])
        pairs.push([mark, bg, 3]);
    }
    for (const state of states) {
      for (const bg of [...backgrounds, `status-${state}-bg`]) {
        pairs.push([`status-${state}-fg`, bg, 4.5]);
        pairs.push([`status-${state}-shape`, bg, 3]);
      }
    }
    pairs.push(
      ['hatch-edge', 'bg-sunken', 3],
      ['grid-others', 'ink', 3],
      ['fg-on-ink', 'ink', 4.5],
      ['fg-on-ink', 'ink', 3], // focus-ring-on-ink
      ['fg-on-accent', 'accent-fill', 4.5],
      ['accent-fg', 'accent-bg', 4.5],
      ['fg-default', 'accent-bg', 4.5],
    );
    for (let i = 1; i <= 6; i++)
      pairs.push([`id-${i}`, `id-tint-${i}`, 3], ['fg-default', `id-tint-${i}`, 4.5]);
    it.each(pairs)(`contrast-more=${more}: %s on %s >= %s`, (fg, bg, minimum) => {
      expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(minimum);
    });
    it(`hatch edge against the composited stripe, contrast-more=${more}`, () => {
      for (const bg of ['bg-sunken', 'bg-surface', 'bg-canvas'])
        expect(contrast(color('hatch-edge'), color('hatch'), color(bg))).toBeGreaterThanOrEqual(3);
    });
    // Frozen class pairs, including primary hover and all status tints.
    const compat = [
      ['panel', 'fg-default', 'bg-surface'],
      ['panel-header', 'fg-default', 'bg-surface'],
      ['panel-note', 'fg-subtle', 'bg-surface'],
      ['button', 'fg-default', 'bg-surface'],
      ['secondary-button', 'fg-default', 'bg-surface'],
      ['primary-button', 'fg-on-accent', 'accent-fill'],
      ['primary', 'fg-on-accent', 'accent-fill'],
      ['form-error', 'status-error-fg', 'status-error-bg'],
      ['num', 'fg-default', 'bg-surface'],
      ['spin', 'fg-default', 'bg-surface'],
      ['status green', 'fg-default', 'status-ok-bg'],
      ['status amber', 'status-warn-fg', 'status-warn-bg'],
      ['status red', 'status-error-fg', 'status-error-bg'],
      ['table-wrap', 'fg-default', 'bg-surface'],
      ['table', 'fg-default', 'bg-surface'],
      ['compact', 'fg-default', 'bg-surface'],
      ['table th', 'fg-subtle', 'bg-sunken'],
      ['sub', 'fg-subtle', 'bg-surface'],
      ['muted', 'fg-subtle', 'bg-surface'],
      ['red-text', 'status-error-fg', 'bg-surface'],
      ['red', 'status-error-fg', 'bg-surface'],
      ['amber', 'status-warn-fg', 'bg-surface'],
      ['link', 'accent-fg', 'bg-surface'],
      ['banner amber', 'status-warn-fg', 'status-warn-bg'],
    ];
    it.each(compat)(`compat contrast-more=${more}: %s`, (_name, fg, bg) => {
      expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(4.5);
    });
    it(`primary hover contrast-more=${more}`, () => {
      // color-mix(in oklch, accent 88%, black): lightness and chroma scale; hue stays.
      const fill = color('accent-fill');
      const hover = [fill[0] * 0.88, fill[1] * 0.88, fill[2]];
      expect(contrast(color('fg-on-accent'), hover)).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('keeps identities distinct from each other and status foregrounds/shapes', () => {
    for (let i = 1; i <= 6; i++) {
      const identity = tokens[`id-${i}`][theme];
      for (const state of states)
        for (const part of ['fg', 'shape'])
          expect(deltaE(identity, tokens[`status-${state}-${part}`][theme])).toBeGreaterThanOrEqual(
            0.08,
          );
      for (let j = i + 1; j <= 6; j++)
        expect(deltaE(identity, tokens[`id-${j}`][theme])).toBeGreaterThanOrEqual(0.1);
    }
  });
});
it('has no sRGB clipping', () => {
  for (const pair of Object.values(tokens))
    for (const color of Object.values(pair))
      for (const channel of linearRGB(color)) {
        expect(channel).toBeGreaterThanOrEqual(-0.000001);
        expect(channel).toBeLessThanOrEqual(1.000001);
      }
});
it('checks reference black/white contrast and OKLab distance', () => {
  expect(contrast([1, 0, 0], [0, 0, 0])).toBeCloseTo(21);
  expect(deltaE([0.5, 0.1, 0], [0.5, 0.1, 180])).toBeCloseTo(0.2);
  expect(linearRGB([0.5, 0, 0])[0]).toBeCloseTo(0.125);
});

it('reports signed APCA reference values without gating on Lc', () => {
  expect(apca([0, 0, 0], [1, 0, 0])).toBeCloseTo(106.04, 2);
  expect(apca([1, 0, 0], [0, 0, 0])).toBeCloseTo(-107.88, 2);
  expect(apca([0.5, 0, 0], [0.5, 0, 0])).toBe(0);
});

it('composites a half-transparent black stripe over white in sRGB', () => {
  expect(contrast([0, 0, 0], [0, 0, 0, 0.5], [1, 0, 0])).toBeCloseTo(5.2808, 4);
});
