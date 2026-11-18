import { ClockText } from '../data/ClockText';
import { UnmeasuredLinks } from './UnmeasuredLinks';
import { useRouteParam } from '../useRouteParam';
import type { NodeSummary, Source, Summary } from '../types';
import { findGroup } from '../groups';
import { t } from '../i18n';
import { qosGpuLimit, relativeTime, uniqueNodes, sourceHasData } from '../domain';
import { partialCount } from '../domain';
import { nodeTone, sourceState } from '../labels';
import { Chips, Empty, Meter, Panel, Status } from '../ui';
import type { Ctx } from './shared';
import { GroupFilter, SearchBox } from './shared';
import { matches } from './util';
import { allocationText, groupSummary } from './summary';

export function ClustersPage({ ctx }: { ctx: Ctx }) {
  const { data, group, query, groups } = ctx;
  const [requestedFilter, setNodeFilter] = useRouteParam('nodes', 'all');
  const nodeFilter = ['all', 'idle', 'abnormal'].includes(requestedFilter)
    ? requestedFilter
    : 'all';
  const clusters = groups.filter((item) => item.kind === 'cluster');
  const visible = clusters.filter((item) => group === 'all' || item.key === group);
  const keys = new Set(visible.map((item) => item.key));
  const accounts = data.sources.filter(
    (source) => source.kind === 'cluster' && keys.has(source.cluster_id),
  );
  const nodes = uniqueNodes(
    data.nodes.filter(
      (node) =>
        keys.has(node.cluster_id) &&
        data.sources.some(
          (source) => source.id === node.source_id && sourceHasData(source, 'nodes'),
        ),
    ),
  ).filter((node) => matches(query, node.name, node.partitions.join(' '), node.state));
  const idle = nodes.filter((node) => nodeTone(node) === 'green');
  const abnormal = nodes.filter((node) => nodeTone(node) === 'red');
  const shownNodes = nodeFilter === 'idle' ? idle : nodeFilter === 'abnormal' ? abnormal : nodes;
  if (!clusters.length)
    return (
      <Panel>
        <Empty
          title={t('clusters.empty')}
          action={
            ctx.demo ? undefined : (
              <button
                className="button primary"
                onClick={() => ctx.configure(undefined, { kind: 'cluster' })}
              >
                {t('clusters.add')}
              </button>
            )
          }
        />
      </Panel>
    );
  return (
    <>
      <div className="toolbar bare">
        <GroupFilter ctx={ctx} options={clusters} allLabel={t('jobs.allClusters')} />
      </div>
      <div className="cluster-cards">
        {visible.map((item) => {
          const row = groupSummary(data, item);
          const tone =
            row.state === 'unavailable' ? 'red-text' : row.state === 'degraded' ? 'amber-text' : '';
          const mine = row.scoped;
          return (
            <section className="panel cluster-card" key={item.key}>
              <header>
                <strong>{item.label}</strong>
                <ClockText>{() => <Status state={groupSummary(data, item).state} />}</ClockText>
              </header>
              <strong className={`cluster-hero ${tone}`}>
                {row.nodes.nodes ? allocationText(row.nodes) : '—'}
              </strong>
              <CapacityBar nodes={row.nodes} />
              <dl className="kv">
                <div>
                  <dt>{t('clusters.nodes')}</dt>
                  <dd>
                    {row.nodes.nodes || '—'}
                    {row.nodes.abnormal > 0 && (
                      <span className={tone || 'amber-text'}>
                        {' · '}
                        {t('clusters.abnormal', { count: row.nodes.abnormal })}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('clusters.mine')}</dt>
                  <dd>
                    <UnmeasuredLinks
                      value={`${partialCount(mine.allocated, mine.known_allocated)} / ${partialCount(mine.requested, mine.known_requested)}`}
                      items={mergeUnmeasured(mine)}
                      ctx={ctx}
                    />
                  </dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>
      <Panel
        title={t('clusters.accounts')}
        actions={
          ctx.demo ? undefined : (
            <button
              className="button small"
              onClick={() => ctx.configure(undefined, { kind: 'cluster' })}
            >
              {t('clusters.addAccount')}
            </button>
          )
        }
      >
        <div className="table-wrap">
          <table className="table stack-on-phone cluster-accounts-table">
            <thead>
              <tr>
                <th>{t('job.cluster')}</th>
                <th>{t('sources.col.login')}</th>
                <th className="col-mid">{t('clusters.col.sshHost')}</th>
                <th className="num">{t('clusters.col.gpus')}</th>
                <th>{t('clusters.col.qos')}</th>
                <th className="num col-low">{t('clusters.col.lastSuccess')}</th>
                <th>{t('clusters.col.state')}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((source) => (
                <AccountRow key={source.id} source={source} ctx={ctx} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={t('clusters.nodes')}>
        <div className="toolbar">
          <Chips
            label={t('clusters.nodeState')}
            value={nodeFilter}
            onChange={setNodeFilter}
            options={[
              { value: 'all', label: t('filter.all'), count: nodes.length },
              { value: 'idle', label: t('clusters.idle'), count: idle.length },
              { value: 'abnormal', label: t('clusters.abnormalTab'), count: abnormal.length },
            ]}
          />
          <div className="toolbar-end">
            <SearchBox ctx={ctx} placeholder={t('clusters.searchNodes')} />
          </div>
        </div>
        {shownNodes.length ? (
          <div className="table-wrap">
            <table className="table stack-on-phone">
              <thead>
                <tr>
                  <th>{t('clusters.col.node')}</th>
                  <th>{t('clusters.col.cluster')}</th>
                  <th>{t('clusters.col.gpuAllocated')}</th>
                  <th className="num">{t('clusters.col.cpuAllocated')}</th>
                  <th>{t('clusters.col.partition')}</th>
                  <th>{t('clusters.col.state')}</th>
                </tr>
              </thead>
              <tbody>
                {shownNodes.map((node) => (
                  <tr key={node.id}>
                    <td className="mono">{node.name}</td>
                    <td data-label={t('clusters.col.cluster')}>
                      {findGroup(groups, node.cluster_id)?.label ?? node.cluster_id}
                    </td>
                    <td data-label={t('clusters.col.gpuAllocated')}>
                      <Meter
                        value={
                          node.gpu_count && node.gpu_allocated != null
                            ? (node.gpu_allocated / node.gpu_count) * 100
                            : null
                        }
                        text={`${node.gpu_allocated ?? '?'} / ${node.gpu_count ?? '?'}`}
                      />
                    </td>
                    <td className="num phone-hide" data-label={t('clusters.col.cpuAllocated')}>
                      {node.cpu_allocated ?? '?'} / {node.cpu_count ?? '?'}
                    </td>
                    <td className="muted" data-label={t('clusters.col.partition')}>
                      {node.partitions.join(', ') || '—'}
                    </td>
                    <td data-label={t('clusters.col.state')}>
                      {/* The scheduler's own word stays one hover away when the tag translates it. */}
                      <span className={`tag ${nodeTone(node)}`} title={node.state}>
                        {/^FUTURE$/i.test(node.state)
                          ? t('clusters.future')
                          : node.health_reason === 'no_partition'
                            ? t('clusters.noPartition')
                            : node.health === 'on_demand'
                              ? t('clusters.onDemand')
                              : node.state.replaceAll('+', '+\u200b')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={nodes.length || query ? t('clusters.nodes.noMatch') : t('clusters.nodes.none')}
          />
        )}
      </Panel>
    </>
  );
}

/** Running and queued gaps, each source and reason listed once. */
function mergeUnmeasured(summary: Summary) {
  return [
    ...summary.unmeasured,
    ...summary.queued_unmeasured.filter(
      (item) =>
        !summary.unmeasured.some(
          (other) => other.subject.id === item.subject.id && other.reason.code === item.reason.code,
        ),
    ),
  ];
}

/** Allocated, free, on-demand and unavailable GPUs as one segmented bar; its name has the numbers. */
function CapacityBar({ nodes }: { nodes: NodeSummary }) {
  if (!nodes.nodes) return null;
  const parts = [
    ['allocated', nodes.allocated, t('clusters.bar.allocated', { count: nodes.allocated ?? '—' })],
    ['free', nodes.unallocated, t('clusters.bar.free', { count: nodes.unallocated ?? '—' })],
    ['on-demand', nodes.on_demand, t('summary.onDemand', { count: nodes.on_demand ?? 0 })],
    [
      'unavailable',
      nodes.unavailable,
      t('clusters.bar.unavailable', { count: nodes.unavailable ?? '—' }),
    ],
  ] as const;
  const label = [
    ...parts.filter(([kind, count]) => kind !== 'on-demand' || count).map(([, , text]) => text),
    ...(nodes.unknown ? [t('summary.unknownNodes', { count: nodes.unknown })] : []),
  ].join(' · ');
  // An unknown total is a hatched bar, not an empty space; its name says what is unknown.
  return (
    <span
      className={nodes.capacity ? 'capacity-bar' : 'capacity-bar unknown'}
      role="img"
      aria-label={label}
      title={label}
    >
      {parts.map(
        ([kind, count]) => !!count && <i key={kind} className={kind} style={{ flexGrow: count }} />,
      )}
    </span>
  );
}

function AccountRow({ source, ctx }: { source: Source; ctx: Ctx }) {
  const summary = ctx.data.summary.sources[source.id];
  // What and its state; why a login fails is in its pane, which the row opens.
  return (
    <>
      <tr
        className="clickable"
        tabIndex={0}
        onClick={() => ctx.diagnose(source)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.target === event.currentTarget) ctx.diagnose(source);
        }}
      >
        <td>
          <strong>{source.name}</strong>
        </td>
        <td className="mono" data-label={t('sources.col.login')}>
          {source.username || '—'}
        </td>
        <td className="mono col-mid" data-label={t('clusters.col.sshHost')}>
          {source.ssh_alias || <span className="muted">{t('common.notSet')}</span>}
        </td>
        <td className="num" data-label={t('clusters.col.gpus')}>
          <UnmeasuredLinks
            value={`${partialCount(summary.allocated, summary.known_allocated)} / ${partialCount(summary.requested, summary.known_requested)}`}
            items={mergeUnmeasured(summary)}
            ctx={ctx}
          />
        </td>
        <td data-label={t('clusters.col.qos')}>
          {source.qos.length ? (
            <details className="account-qos" onClick={(event) => event.stopPropagation()}>
              <summary>{t('clusters.qosEntries', { count: source.qos.length })}</summary>
              <span className="tags">
                {source.qos.map((qos) => {
                  const limit = qosGpuLimit(qos);
                  return (
                    <span
                      key={qos.name}
                      className="tag"
                      title={`${JSON.stringify(qos.limits)} · ${qos.origin}`}
                    >
                      {qos.name}
                      {limit != null && (
                        <span className="tag-detail">
                          {limit === Infinity
                            ? t('clusters.qosNoLimit')
                            : t('clusters.qosLimit', { count: limit })}
                        </span>
                      )}
                    </span>
                  );
                })}
              </span>
            </details>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className="num col-low" data-label={t('clusters.col.lastSuccess')}>
          <ClockText>{() => relativeTime(source.last_success)}</ClockText>
        </td>
        <td data-label={t('clusters.col.state')}>
          <Status state={sourceState(source)} />
        </td>
      </tr>
    </>
  );
}
