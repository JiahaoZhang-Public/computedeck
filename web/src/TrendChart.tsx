import { useId, useState } from 'react';
import type { MouseEvent } from 'react';
import type { HistoryPoint } from './types';
import { dateTime, historyAllocation, historyPartial } from './domain';
import { locale, t } from './i18n';

const WIDTH = 760;
const HEIGHT = 180;
const PAD = 10;
const HOUR = 60 * 60 * 1000;

function tick(at: number, hours: number) {
  const date = new Date(at);
  const time = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
  if (hours <= 24) return date.toLocaleTimeString(locale(), time);
  const day = { month: 'short', day: 'numeric' } as const;
  // A week reads best by day; a few days need the time as well.
  return hours > 72
    ? date.toLocaleDateString(locale(), day)
    : date.toLocaleString(locale(), { ...day, ...time });
}

export default function TrendChart({
  history,
  hours = 24,
  empty,
}: {
  history: HistoryPoint[];
  hours?: number;
  /** Shown instead of the usual empty text, e.g. while a longer range loads. */
  empty?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // One hatch pattern per chart; an SVG id must not contain the colons React may put in ids.
  const hatch = `chart-hatch-${useId().replace(/[^\w-]/g, '')}`;
  const span = hours * HOUR;
  const end = Date.now();
  const start = end - span;
  // A missing collection longer than this is drawn as a gap, never bridged.
  const maxGap = Math.max(30 * 60 * 1000, (2.5 * span) / 600);
  const points = history
    .filter((point) => {
      const at = new Date(point.at).getTime();
      return at >= start && at <= end;
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const hasUtilization = points.some((point) => point.gpu_utilization != null);
  const hasAllocation = points.some((point) => historyAllocation(point) !== null);
  const maxAllocated = Math.max(1, ...points.map((point) => historyAllocation(point) ?? 0));
  const x = (at: string) =>
    PAD + ((new Date(at).getTime() - start) / (end - start)) * (WIDTH - 2 * PAD);
  const y = (fraction: number) => HEIGHT - 4 - fraction * (HEIGHT - 12);

  const segments: string[] = [];
  let current = '';
  points.forEach((point, i) => {
    const gap =
      i > 0 && new Date(point.at).getTime() - new Date(points[i - 1].at).getTime() > maxGap;
    if (gap || point.gpu_utilization == null) {
      if (current) segments.push(current);
      current = '';
    }
    if (point.gpu_utilization != null)
      current += `${current ? ' L' : 'M'} ${x(point.at)} ${y(point.gpu_utilization / 100)}`;
  });
  if (current) segments.push(current);

  function track(event: MouseEvent<HTMLDivElement>) {
    if (!points.length) return;
    const box = event.currentTarget.getBoundingClientRect();
    const target = ((event.clientX - box.left) / box.width) * WIDTH;
    let nearest = 0;
    points.forEach((point, i) => {
      if (Math.abs(x(point.at) - target) < Math.abs(x(points[nearest].at) - target)) nearest = i;
    });
    setHover(nearest);
  }
  const active = hover !== null ? points[hover] : null;
  const barWidth = Math.max(1, Math.min(4, ((WIDTH - 2 * PAD) / Math.max(points.length, 1)) * 0.6));
  const activeLeft = active ? (x(active.at) / WIDTH) * 100 : 0;

  return (
    <div className="chart">
      <div className="chart-axis">
        {[100, 75, 50, 25, 0].map((tick) => (
          <span key={tick}>{tick}%</span>
        ))}
      </div>
      <div className="chart-body" onMouseMove={track} onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('chart.aria')}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <line key={tick} className="chart-grid" x1="0" x2={WIDTH} y1={y(tick)} y2={y(tick)} />
          ))}
          <defs>
            <pattern
              id={hatch}
              width="4"
              height="4"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <path className="chart-hatch" d="M0 0h2v4h-2z" />
            </pattern>
          </defs>
          {points.map((point) => {
            const allocated = historyAllocation(point);
            if (allocated === null) return null;
            const top = y(allocated / maxAllocated);
            // A sample that misses some sources is hatched: its height is only a lower bound.
            const partial = historyPartial(point);
            return (
              <rect
                key={point.at}
                className={partial ? 'chart-bar partial' : 'chart-bar'}
                x={x(point.at) - barWidth / 2}
                y={top}
                width={barWidth}
                height={HEIGHT - 4 - top}
                rx="1.5"
                style={partial ? { fill: `url(#${hatch})` } : undefined}
              >
                {partial && <title>{t('chart.barPartial', { count: allocated })}</title>}
              </rect>
            );
          })}
          {segments.map((segment, i) => (
            <path key={i} className="chart-line" d={segment} vectorEffect="non-scaling-stroke" />
          ))}
          {points
            .filter((point) => point.gpu_utilization != null)
            .map((point) => (
              <circle
                key={point.at}
                className="chart-dot"
                cx={x(point.at)}
                cy={y(point.gpu_utilization! / 100)}
                r="2.5"
              />
            ))}
          {active && (
            <line
              className="chart-cursor"
              x1={x(active.at)}
              x2={x(active.at)}
              y1="0"
              y2={HEIGHT}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {active && (
          <div
            className={`chart-tooltip ${activeLeft > 70 ? 'left' : ''}`}
            style={{ left: `${activeLeft}%` }}
          >
            <strong>{dateTime(active.at)}</strong>
            <span>
              {t('chart.utilization')}{' '}
              {active.gpu_utilization == null ? '—' : `${Math.round(active.gpu_utilization)}%`}
            </span>
            <span>
              {t('chart.allocated')}{' '}
              {historyPartial(active)
                ? `≥ ${historyAllocation(active)} · ${t('chart.lowerBound')}`
                : (historyAllocation(active) ?? '—')}
              {active.unknown_allocation_sources
                ? ` · ${t('chart.unknownSources', { count: active.unknown_allocation_sources })}`
                : ''}
            </span>
          </div>
        )}
        {!hasUtilization && !hasAllocation && (
          <div className="chart-empty">{empty ?? t('chart.empty')}</div>
        )}
        <div className="chart-time">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <span key={i}>{tick(start + (i / 6) * span, hours)}</span>
          ))}
        </div>
      </div>
      <div className="chart-axis right">
        {[1, 0.75, 0.5, 0.25, 0].map((tick) => (
          <span key={tick}>{hasAllocation ? Math.round(maxAllocated * tick) : '—'}</span>
        ))}
      </div>
    </div>
  );
}
