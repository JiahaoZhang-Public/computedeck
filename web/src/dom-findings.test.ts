import { expect, it } from 'vitest';
import { domFingerprints, type DomFinding } from '../e2e/dom-findings';

it('deduplicates by kind and identity, preserving occurrence counts without pixel sizes', () => {
  expect(
    domFingerprints([
      { kind: 'small-touch-target', identity: 'button: Refresh', width: 32, height: 30 },
      { kind: 'small-touch-target', identity: 'button: Refresh', width: 34, height: 31 },
    ]),
  ).toEqual([{ kind: 'small-touch-target', identity: 'button: Refresh', count: 2 }]);
});

it('keeps a baseline stable across measurement and traversal-order changes', () => {
  const findings: DomFinding[] = [
    { kind: 'small-touch-target', identity: 'button: 刷新', width: 32, height: 30 },
    { kind: 'horizontal-overflow', identity: 'html', width: 400, viewportWidth: 375 },
    { kind: 'empty-plugin-slot', identity: '#empty-slot', width: 100, height: 10 },
    { kind: 'duplicate-heading', identity: 'h2: Example' },
  ];
  expect(domFingerprints(findings)).toEqual(
    domFingerprints(
      [...findings].reverse().map((finding) => ({ ...finding, width: 42, height: 42 })),
    ),
  );
  expect(domFingerprints(findings)).not.toEqual(domFingerprints([...findings, findings[0]]));
  expect(domFingerprints(findings)).not.toEqual(domFingerprints(findings.slice(1)));
});

it('distinguishes finding kinds and control identities', () => {
  expect(
    domFingerprints([
      { kind: 'small-touch-target', identity: 'button: Example' },
      { kind: 'small-touch-target', identity: 'a: Example' },
      { kind: 'duplicate-heading', identity: 'button: Example' },
    ]),
  ).toHaveLength(3);
});
