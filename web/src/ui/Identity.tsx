import type { CSSProperties } from 'react';
import './display.css';
import { initials } from '../groups';

function identityStyle(slot?: number): CSSProperties {
  return {
    '--identity': slot ? `var(--id-${slot})` : 'var(--fg-subtle)',
    '--identity-tint': slot ? `var(--id-tint-${slot})` : 'var(--bg-sunken)',
  } as CSSProperties;
}
/** Decorative next to an already visible group name. */
export function Swatch({ slot }: { slot?: number }) {
  return <span className="identity-swatch" style={identityStyle(slot)} aria-hidden="true" />;
}
/** Use where the full name is not adjacent; it remains the accessible name. */
export function Monogram({
  slot,
  label,
  initial = initials(label),
}: {
  slot?: number;
  label: string;
  initial?: string;
}) {
  return (
    <span className="identity-monogram" style={identityStyle(slot)} role="img" aria-label={label}>
      {initial}
    </span>
  );
}
