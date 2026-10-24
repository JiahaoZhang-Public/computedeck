export interface DomFinding {
  kind:
    | 'horizontal-overflow'
    | 'empty-plugin-slot'
    | 'duplicate-heading'
    | 'small-touch-target'
    | 'cell-overflow';
  identity: string;
  width?: number;
  height?: number;
  scrollHeight?: number;
  viewportWidth?: number;
}

/** Keep measurements in the report, not in the regression identity. */
export function domFingerprints(findings: DomFinding[]) {
  const counts = new Map<string, { kind: DomFinding['kind']; identity: string; count: number }>();
  for (const { kind, identity } of findings) {
    const key = JSON.stringify([kind, identity]);
    const previous = counts.get(key);
    if (previous) previous.count++;
    else counts.set(key, { kind, identity, count: 1 });
  }
  return [...counts.keys()].sort().map((key) => counts.get(key)!);
}
