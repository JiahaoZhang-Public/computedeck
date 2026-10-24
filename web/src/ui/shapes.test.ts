// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { shapeSvg } from './shapes';

// A geometry guard, not a browser raster replacement. Sample each 10px raster cell
// on a 24x24 grid and compare coverage, including the square's rounded corners.
function coverage(contains: (x: number, y: number) => boolean) {
  return Array.from({ length: 100 }, (_, pixel) => {
    let inside = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        if (
          contains(
            ((pixel % 10) + (x + 0.5) / 24) * 1.2,
            (Math.floor(pixel / 10) + (y + 0.5) / 24) * 1.2,
          )
        )
          inside++;
      }
    }
    return inside / (24 * 24);
  });
}

it('keeps the off square distinct from the ok circle at ten pixels', () => {
  const parser = new DOMParser();
  const circle = parser.parseFromString(shapeSvg('ok'), 'image/svg+xml').querySelector('circle')!;
  const square = parser.parseFromString(shapeSvg('off'), 'image/svg+xml').querySelector('rect')!;
  expect(circle).not.toBeNull();
  expect(square).not.toBeNull();
  const attr = (element: Element, name: string) => {
    expect(element.hasAttribute(name), name).toBe(true);
    return Number(element.getAttribute(name));
  };
  const [cx, cy, r] = ['cx', 'cy', 'r'].map((key) => attr(circle, key));
  const [x, y, width, height, radius] = ['x', 'y', 'width', 'height', 'rx'].map((key) =>
    attr(square, key),
  );
  const inCircle = (px: number, py: number) => (px - cx) ** 2 + (py - cy) ** 2 <= r ** 2;
  const inSquare = (px: number, py: number) => {
    if (px < x || px > x + width || py < y || py > y + height) return false;
    const dx = Math.max(x + radius - px, 0, px - (x + width - radius));
    const dy = Math.max(y + radius - py, 0, py - (y + height - radius));
    return dx ** 2 + dy ** 2 <= radius ** 2;
  };
  for (const px of [x + radius, x + width - radius]) {
    for (const py of [y + radius, y + height - radius]) {
      expect(inSquare(px, py)).toBe(true);
      expect(inCircle(px, py)).toBe(false);
    }
  }
  const ok = coverage(inCircle);
  const off = coverage(inSquare);
  const difference = ok.reduce((sum, alpha, i) => sum + Math.abs(alpha - off[i]), 0);
  const areaGain = off.reduce((sum, alpha, i) => sum + alpha - ok[i], 0);
  expect(difference).toBeGreaterThanOrEqual(12);
  expect(areaGain).toBeGreaterThanOrEqual(12);
});
