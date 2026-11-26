import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent, KeyboardEvent, ReactNode } from 'react';
import { absoluteTime, clockTime, formatDate, number, relativeTime } from '../format';
import { t } from '../i18n';
import { ClockText } from '../data/ClockText';
import { Time } from '../ui/Time';
import type { ChartData } from './types';
import {
  compactRange,
  compactTime,
  intervalEnd,
  reading,
  seriesLabel,
  seriesFormat,
  seriesScope,
  statistics,
  summaryText,
} from './labels';
import { H, W, LEFT, gapBands, segments, seriesStyles, timeX, y } from './geometry';
import './chart.css';

export function Chart({
  data,
  onRange,
  onPage,
  controls,
  title = t('chart.scope'),
  scope,
  sharedScale = false,
}: {
  data: ChartData;
  onRange?: (range: string) => void;
  onPage?: (direction: -1 | 1) => void;
  controls?: ReactNode;
  title?: string;
  scope?: string;
  sharedScale?: boolean;
}) {
  const id = useId();
  const pointer = useRef({ x: 0, y: 0, moved: false });
  const hatch = `bucket-hatch-${id.replace(/[^\w-]/g, '')}`;
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [activeSeries, setActiveSeries] = useState(0);
  const [table, setTable] = useState(false);
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(W);
  useEffect(() => {
    if (!plot.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(plot.current);
    return () => observer.disconnect();
  }, [table]);
  const [tablePage, setTablePage] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const buckets = data.series[0]?.buckets ?? [];
  const selectedIndex = buckets.findIndex((bucket) => bucket.start === selected);
  const index = selectedIndex < 0 ? Math.max(0, buckets.length - 1) : selectedIndex;
  const active = buckets[index];
  const edgeX = (at: string) =>
    timeX(Date.parse(at), Date.parse(data.start), Date.parse(data.end), width);
  const x = (i: number) => (edgeX(buckets[i].start) + edgeX(buckets[i].end)) / 2;
  const isPinned = pinned && selectedIndex >= 0;
  const styles = seriesStyles(data.series);

  const summary = data.series
    .map((series) => `${seriesLabel(series)}: ${summaryText(series)}`)
    .join(' ');
  function select(next: number, series = activeSeries, pin = isPinned) {
    const i = Math.max(0, Math.min(buckets.length - 1, next));
    if (!buckets[i]) return;
    setSelected(buckets[i].start);
    setActiveSeries(series);
    setPinned(pin);
    setAnnouncement(
      `${absoluteTime(buckets[i].start)} · ${seriesLabel(data.series[series])} · ${reading(data.series[series].buckets[i], data.series[series])}`,
    );
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 10 : 1;
    const tick = Math.max(1, (data.bucket_seconds === 300 ? 3600 : 86400) / data.bucket_seconds);
    let next = index;
    switch (event.key) {
      case 'ArrowLeft':
        next -= step;
        break;
      case 'ArrowRight':
        next += step;
        break;
      case 'PageUp':
        next -= tick;
        break;
      case 'PageDown':
        next += tick;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = buckets.length - 1;
        break;
      case 'ArrowUp':
        select(index, Math.max(0, activeSeries - 1));
        break;
      case 'ArrowDown':
        select(index, Math.min(data.series.length - 1, activeSeries + 1));
        break;
      case 'Enter':
        select(index, activeSeries, !isPinned);
        break;
      case 'Escape':
        if (!isPinned) return;
        setPinned(false);
        setAnnouncement('');
        break;
      case '[':
      case ']':
        if (!onPage || event.shiftKey) return;
        onPage(event.key === '[' ? -1 : 1);
        break;
      case '1':
      case '2':
      case '3':
        if (!onRange || event.shiftKey) return;
        onRange({ '1': '24h', '2': '7d', '3': '30d' }[event.key]);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))
      select(next);
  }
  function nearest(event: { clientX: number; currentTarget: HTMLElement }) {
    const rect = event.currentTarget.getBoundingClientRect();
    const position = ((event.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    buckets.forEach((_, i) => {
      if (Math.abs(x(i) - position) < Math.abs(x(nearest) - position)) nearest = i;
    });
    return nearest;
  }
  function hover(event: PointerEvent<HTMLDivElement>) {
    if (
      event.buttons &&
      Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 8
    )
      pointer.current.moved = true;
    if (event.pointerType !== 'mouse' || event.buttons || isPinned || !buckets.length) return;
    setSelected(buckets[nearest(event)].start);
  }
  const pageCount = Math.ceil(buckets.length / 24);
  const page = Math.min(tablePage, Math.max(0, pageCount - 1));
  return (
    <section className="chart-kit" aria-label={title}>
      {/* The axis shows the range; the sentence stays for readers who cannot see the axis. */}
      <p className="sr-only">
        {title}
        {scope && <> · {scope}</>} · {compactRange(data.start, data.end)}
      </p>
      {/* The plot's text alternative; sighted readers get the same numbers from Table view. */}
      <p id={`${id}-summary`} className="sr-only">
        {summary}
      </p>
      <div className="chart-tools">
        {controls}
        <button
          className="button"
          type="button"
          aria-pressed={table}
          onClick={() => setTable(!table)}
        >
          {t('chart.table')}
        </button>
      </div>
      {!data.series.some((series) => series.buckets.some((bucket) => bucket.value !== null)) && (
        <p className="chart-empty">
          {data.last_sample
            ? `${t('chart.empty')} · ${t('chart.lastSample')} ${compactTime(data.last_sample)}`
            : t('chart.noLastSample')}
        </p>
      )}
      <div className="chart-readout" data-pinned={isPinned}>
        {active && (
          <>
            <strong>{t(isPinned ? 'chart.pinned' : 'chart.reading')}</strong>{' '}
            <ClockText>
              {() => (
                <span>
                  <Time value={active.start} /> – {intervalEnd(active.start, active.end)} ·{' '}
                  {relativeTime(active.start)}
                </span>
              )}
            </ClockText>
            {data.series.map((series, i) => (
              <div key={series.id} data-active={i === activeSeries}>
                {seriesLabel(series)} · {seriesScope(series)} ·{' '}
                {reading(series.buckets[index], series)}
                {series.buckets[index].value !== null &&
                  (data.bucket_seconds > 300 || series.buckets[index].samples > 1) && (
                    <span> · {statistics(series.buckets[index], series)}</span>
                  )}
              </div>
            ))}
            {isPinned && (
              <a
                className="link"
                href={`#/activity?from=${encodeURIComponent(active.start)}&to=${encodeURIComponent(active.end)}`}
              >
                {t('chart.activity')}
              </a>
            )}
          </>
        )}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {table ? (
        <>
          <div className="table-wrap" tabIndex={0} role="region" aria-label={t('chart.table')}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('chart.interval')}</th>
                  {data.series.map((series) => (
                    <th key={series.id}>{seriesLabel(series)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {buckets.slice(page * 24, (page + 1) * 24).map((bucket, offset) => (
                  <tr key={bucket.start}>
                    <td>
                      <Time value={bucket.start} /> – {intervalEnd(bucket.start, bucket.end)}
                    </td>
                    {data.series.map((series) => {
                      const b = series.buckets[page * 24 + offset];
                      return (
                        <td key={series.id}>
                          {reading(b, series)}
                          <span className="sub">{statistics(b, series)}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="chart-pages">
            <button
              type="button"
              className="button"
              disabled={page === 0}
              onClick={() => setTablePage(page - 1)}
            >
              {t('chart.previous')}
            </button>
            <span>
              {page + 1} / {pageCount || 1}
            </span>
            <button
              className="button"
              type="button"
              disabled={page + 1 >= pageCount}
              onClick={() => setTablePage(page + 1)}
            >
              {t('chart.next')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div
            ref={plot}
            className="chart-plot"
            role="group"
            aria-roledescription={t('chart.kind')}
            aria-label={title}
            aria-describedby={`${id}-summary ${id}-keys`}
            tabIndex={0}
            onKeyDown={key}
            onPointerDown={(event) => {
              pointer.current = { x: event.clientX, y: event.clientY, moved: false };
            }}
            onPointerMove={hover}
            onClick={(event) => {
              if (pointer.current.moved) return;
              select(nearest(event), activeSeries, !(isPinned && nearest(event) === index));
            }}
          >
            {data.series.map((series, n) => {
              const max =
                seriesFormat(series).kind === 'percent'
                  ? 100
                  : Math.max(
                      1,
                      ...(sharedScale
                        ? data.series
                            .filter((other) => {
                              const a = seriesFormat(series),
                                b = seriesFormat(other);
                              return a.kind === b.kind && a.currency === b.currency;
                            })
                            .flatMap((other) => other.buckets)
                        : series.buckets
                      ).map((b) => b.max ?? 0),
                    );
              return (
                <div key={series.id} className="chart-multiple" style={{ color: styles[n].color }}>
                  <div>
                    {seriesFormat(series).kind === 'percent'
                      ? t('chart.percentLabel', { label: seriesLabel(series) })
                      : seriesLabel(series)}
                  </div>
                  <svg viewBox={`0 0 ${width} ${H}`} aria-hidden="true">
                    {n === 0 && (
                      <defs>
                        <pattern
                          id={hatch}
                          width="6"
                          height="6"
                          patternUnits="userSpaceOnUse"
                          patternTransform="rotate(45)"
                        >
                          <path className="bucket-hatch" d="M0 0v6" />
                        </pattern>
                      </defs>
                    )}
                    {[0, 0.5, 1].map((tick) => (
                      <g key={tick}>
                        <line
                          className="bucket-grid"
                          x1={LEFT}
                          x2={width - 8}
                          y1={y(tick * max, max)}
                          y2={y(tick * max, max)}
                        />
                        <text
                          className="bucket-axis"
                          x={LEFT - 6}
                          y={y(tick * max, max) + 4}
                          textAnchor="end"
                        >
                          {number(tick * max, { maximumFractionDigits: 1 })}
                        </text>
                      </g>
                    ))}
                    {gapBands(series.buckets).map((band) => {
                      const left = edgeX(band.start),
                        span = edgeX(band.end) - left;
                      return (
                        <g key={band.start}>
                          <rect
                            className="bucket-gap"
                            x={left}
                            width={span}
                            y="4"
                            height={H - 8}
                            fill={`url(#${hatch})`}
                          />
                          {span >= 48 && (
                            <text
                              className="bucket-gap-label"
                              x={left + span / 2}
                              y={H / 2}
                              textAnchor="middle"
                            >
                              {t('chart.noData')}
                            </text>
                          )}
                        </g>
                      );
                    })}
                    {segments(series.buckets).map(({ indices, lowerBound }, segment) => {
                      const first = series.buckets[indices[0]];
                      const path = indices
                        .map(
                          (i, j) => `${j ? 'L' : 'M'}${x(i)} ${y(series.buckets[i].value!, max)}`,
                        )
                        .join(' ');
                      const band = [
                        ...indices.map((i) => `${x(i)},${y(series.buckets[i].max!, max)}`),
                        ...[...indices]
                          .reverse()
                          .map((i) => `${x(i)},${y(series.buckets[i].min!, max)}`),
                      ].join(' ');
                      return (
                        <g key={segment}>
                          {data.bucket_seconds > 300 && (
                            <polygon className="bucket-band" points={band} />
                          )}
                          <path
                            className="bucket-line"
                            data-lower-bound={lowerBound}
                            d={path}
                            strokeDasharray={lowerBound ? '3 3' : undefined}
                          />
                          {indices.length === 1 &&
                            !first.lower_bound &&
                            (styles[n].square ? (
                              <rect
                                className="bucket-dot"
                                x={x(indices[0]) - 2.5}
                                y={y(first.value!, max) - 2.5}
                                width="5"
                                height="5"
                              />
                            ) : (
                              <circle
                                className="bucket-dot"
                                cx={x(indices[0])}
                                cy={y(first.value!, max)}
                                r="2.5"
                              />
                            ))}
                        </g>
                      );
                    })}
                    {series.buckets.map((bucket, i) => {
                      if (bucket.value === null || !bucket.lower_bound) return null;
                      const before = series.buckets[i - 1],
                        after = series.buckets[i + 1];
                      if (
                        (before?.lower_bound &&
                          before.value !== null &&
                          before.end === bucket.start) ||
                        (after?.lower_bound && after.value !== null && bucket.end === after.start)
                      )
                        return null;
                      return (
                        <g key={bucket.start} className="bucket-bound-mark">
                          <circle
                            className="bucket-bound"
                            cx={x(i)}
                            cy={y(bucket.value, max)}
                            r="4"
                          />
                          <circle
                            className="bucket-bound-hole"
                            cx={x(i)}
                            cy={y(bucket.value, max)}
                            r="2.5"
                          />
                          <text
                            className="bucket-bound-label"
                            x={x(i)}
                            y={Math.max(12, y(bucket.value, max) - 8)}
                            textAnchor="middle"
                          >
                            ≥
                          </text>
                        </g>
                      );
                    })}
                    {data.end === data.as_of && (
                      <line className="bucket-now" x1={width - 8} x2={width - 8} y1="0" y2={H} />
                    )}
                    {active && (
                      <line className="bucket-cursor" x1={x(index)} x2={x(index)} y1="0" y2={H} />
                    )}
                    {active &&
                      series.buckets[index].value !== null &&
                      (styles[n].square ? (
                        <rect
                          className={
                            series.buckets[index].lower_bound
                              ? 'bucket-dot bucket-bound'
                              : 'bucket-dot'
                          }
                          x={x(index) - 3}
                          y={y(series.buckets[index].value!, max) - 3}
                          width="6"
                          height="6"
                        />
                      ) : (
                        <circle
                          className={
                            series.buckets[index].lower_bound
                              ? 'bucket-dot bucket-bound'
                              : 'bucket-dot'
                          }
                          cx={x(index)}
                          cy={y(series.buckets[index].value!, max)}
                          r="3"
                        />
                      ))}
                    {active &&
                      series.buckets[index].value !== null &&
                      series.buckets[index].lower_bound &&
                      (styles[n].square ? (
                        <rect
                          className="bucket-bound-hole"
                          x={x(index) - 1.5}
                          y={y(series.buckets[index].value!, max) - 1.5}
                          width="3"
                          height="3"
                        />
                      ) : (
                        <circle
                          className="bucket-bound-hole"
                          cx={x(index)}
                          cy={y(series.buckets[index].value!, max)}
                          r="1.5"
                        />
                      ))}
                  </svg>
                </div>
              );
            })}
            <div className="chart-ticks">
              {[
                data.start,
                new Date((Date.parse(data.start) + Date.parse(data.end)) / 2).toISOString(),
                data.end,
              ].map((at) => (
                <span key={at}>
                  {at === data.end && data.end === data.as_of
                    ? t('chart.now')
                    : data.bucket_seconds === 300
                      ? `${at === data.start || at === data.end ? `${formatDate(new Date(at), { month: 'short', day: 'numeric' })} · ` : ''}${clockTime(Date.parse(at))}`
                      : formatDate(new Date(at), { month: 'short', day: 'numeric' })}
                </span>
              ))}
            </div>
          </div>
          {/* Below the plot, so showing it on focus never moves the plot. */}
          <p id={`${id}-keys`} className="sub chart-keys">
            {t('chart.keys')}
          </p>
        </>
      )}
      {/* How the marks read is one disclosure away, not a caption under every chart. */}
      <details className="chart-about">
        <summary>{t('chart.about')}</summary>
        <p className="sub">{t('chart.legend')}</p>
        <p className="sub">
          {t('chart.lastSample')} ·{' '}
          {data.last_sample ? <Time value={data.last_sample} /> : t('chart.noLastSample')}
        </p>
      </details>
    </section>
  );
}
