import type { CSSProperties } from 'react';
import './display.css';
import type { Group } from '../groups';
import { initials } from '../groups';

function identityStyle(slot?: number): CSSProperties {
  return {
    '--identity': slot ? `var(--id-${slot})` : 'var(--fg-subtle)',
    '--identity-tint': slot ? `var(--id-tint-${slot})` : 'var(--bg-sunken)',
  } as CSSProperties;
}
/** Decorative next to an already visible group name. */
export function Swatch({ slot, group }: { slot?: number; group?: Group }) {
  return (
    <span
      className="identity-swatch"
      style={identityStyle(group?.slot ?? slot)}
      aria-hidden="true"
    />
  );
}
/** Use where the full name is not adjacent; it remains the accessible name. */
export function Monogram({
  slot,
  group,
  label = group?.label ?? '',
  decorative = false,
  initial = initials(label),
}: {
  slot?: number;
  group?: Group;
  label?: string;
  decorative?: boolean;
  initial?: string;
}) {
  return (
    <span
      className="identity-monogram"
      style={identityStyle(group?.slot ?? slot)}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
    >
      {initial}
    </span>
  );
}
