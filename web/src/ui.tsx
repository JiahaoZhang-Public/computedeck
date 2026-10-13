import type { ReactNode } from 'react';
import type { Group } from './groups';
import { initials } from './groups';
import { statusLabel, statusTone } from './labels';

export function Status({ state, label }: { state: string; label?: string }) {
  return (
    <span className={`status ${statusTone(state)}`}>
      <i />
      {label ?? statusLabel(state)}
    </span>
  );
}
export function GroupMark({ group, label }: { group?: Group; label?: string }) {
  return (
    <span className={`provider-mark ${group ? `mark-${group.color}` : ''}`} aria-hidden="true">
      {group?.initials ?? initials(label ?? '?')}
    </span>
  );
}

export function Meter({ value, text }: { value: number | null; text?: ReactNode }) {
  const width = Math.max(0, Math.min(100, value ?? 0));
  return (
    <span className={`meter ${value == null ? 'unknown' : ''}`}>
      <span className="meter-track">
        <i style={{ width: `${width}%` }} />
      </span>
      <span className="meter-text">{text ?? (value == null ? '—' : `${Math.round(value)}%`)}</span>
    </span>
  );
}

export function Stat({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function Panel({
  title,
  count,
  actions,
  children,
  className = '',
  id,
}: {
  title?: ReactNode;
  /** A number, or a partial ("≥ 3") or unknown ("—") count. */
  count?: number | string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`panel ${className}`} id={id}>
      {(title || actions) && (
        <header className="panel-header">
          <h2>
            {title}
            {count !== undefined && <span className="count">{count}</span>}
          </h2>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Chips<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; count?: number | string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="chips" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span>{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch with a visible label. */
export function Switch({
  checked,
  label,
  name,
  disabled,
  onChange,
}: {
  checked: boolean;
  /** Visible state text. */
  label: string;
  /** What the switch turns on, for screen readers; the state is announced separately. */
  name?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <span aria-hidden={name ? true : undefined}>{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}

/** The ComputeDeck mark: three stacked layers. Colours follow the theme. */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="brand-svg"
      width={size}
      height={size}
      viewBox="-3.44 0 106.89 106.89"
      aria-hidden="true"
    >
      <path
        className="brand-base"
        d="M0.00 65.91Q0.00 64.41 1.32 65.11L42.16 86.75Q50.10 90.96 58.00 86.69L96.05 66.15Q100.00 64.01 100.00 68.50L100.00 80.72Q100.00 82.51 98.41 83.36L57.80 104.88Q50.13 108.94 42.46 104.88L4.50 84.76Q0.00 82.37 0.00 77.28Z"
      />
      <path
        className="brand-middle"
        d="M0.00 40.69Q0.00 39.20 1.33 39.89L42.03 61.05Q49.99 65.19 57.96 61.05L83.21 47.92Q87.72 45.57 87.72 50.66L87.72 59.41Q87.72 63.90 83.77 66.04L57.74 80.10Q50.10 84.22 42.42 80.16L4.50 60.06Q0.00 57.67 0.00 52.58Z"
      />
      <path
        className="brand-top"
        d="M42.12 2.15Q50.03 -2.12 57.96 2.09L93.35 20.85Q107.11 28.14 93.41 35.54L58.14 54.58Q50.24 58.85 42.30 54.64L6.91 35.89Q-6.85 28.60 6.85 21.20Z"
      />
    </svg>
  );
}
