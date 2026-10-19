import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { Source } from '../types';
import { findGroup } from '../groups';
import { formatMessage, t } from '../i18n';
import { qosGpuLimit, relativeTime, uniqueNodes } from '../domain';
import { partialCount } from '../domain';
import { nodeTone, sourceState } from '../labels';
import { Chips, Empty, GroupMark, Meter, Panel, Status } from '../ui';
import type { Ctx } from './shared';
import { GroupFilter, SearchBox } from './shared';
import { matches } from './util';
import { capacityText, groupSummary } from './summary';

export function ClustersPage({ ctx }: { ctx: Ctx }) {
  const { data, group, query, groups } = ctx;
  const [nodeFilter, setNodeFilter] = useState<'all' | 'idle' | 'abnormal'>('all');
  const clusters = groups.filter((item) => item.kind === 'cluster');
  const visible = clusters.filter((item) => group === 'all' || item.key === group);
  const keys = new Set(visible.map((item) => item.key));
  const accounts = data.sources.filter(
    (source) => source.kind === 'cluster' && keys.has(source.cluster_id),
  );
  const nodes = uniqueNodes(data.nodes.filter((node) => keys.has(node.cluster_id))).filter((node) =>
    matches(query, node.name, node.partitions.join(' '), node.state),
  );
  const idle = nodes.filter((node) => nodeTone(node) === 'green');
  const abnormal = nodes.filter((node) => nodeTone(node) === 'red');
  const shownNodes = nodeFilter === 'idle' ? idle : nodeFilter === 'abnormal' ? abnormal : nodes;
  if (!clusters.length)
    return (
      <Panel>
        <Empty
          title={t('clusters.empty')}
          text={t('clusters.emptyHint')}
          action={
            ctx.demo ? undefined : (
              <button
                className="button primary"
                onClick={() => ctx.configure(undefined, { kind: 'cluster' })}
              >
                <Plus size={14} /> {t('clusters.add')}
              </button>
            )
          }
        />
      </Panel>
    );
  return (
    <>
      <div className="toolbar bare">
        <GroupFilter ctx={ctx} options={clusters} />
      </div>
      <div className="cluster-cards">
        {visible.map((item) => {
          const row = groupSummary(data, item);
          const capacity = capacityText(row.nodes, row.state);
          return (
            <section className="panel cluster-card" key={item.key}>
              <header>
                <span className="with-mark">
                  <GroupMark group={item} />
                  <strong>{item.label}</strong>
                </span>
                <Status state={row.state} />
              </header>
              <div className="cluster-capacity">
                {row.nodes.nodes === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  <strong className={capacity.tone}>{capacity.text}</strong>
                )}
                {row.nodes.nodes > 0 && !capacity.outage && (
                  <>
                    <p className="muted">{capacity.detail}</p>
                    <Meter value={row.nodes.ratio} text="" />
                  </>
                )}
              </div>
              <dl className="kv">
                <div>
                  <dt>{t('clusters.nodes')}</dt>
                  <dd>
                    {row.nodes.nodes || '—'}
                    {row.nodes.abnormal > 0 && (
                      <span className={capacity.tone}>
                        {' · '}
                        {t('clusters.abnormal', { count: row.nodes.abnormal })}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('clusters.mine')}</dt>
                  <dd>
                    {partialCount(row.scoped.allocated, row.scoped.known_allocated)} /{' '}
                    {partialCount(row.scoped.requested, row.scoped.known_requested)}
                  </dd>
                </div>
                <div>
                  <dt>{t('clusters.nodeData')}</dt>
                  <dd>{row.nodes.observed_at ? relativeTime(row.nodes.observed_at) : '—'}</dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>
      <p className="page-note">{t('clusters.note')}</p>
      <Panel
        title={t('clusters.accounts')}
        count={accounts.length}
        actions={
          ctx.demo ? undefined : (
            <button
              className="button small"
              onClick={() => ctx.configure(undefined, { kind: 'cluster' })}
            >
              <Plus size={13} /> {t('clusters.addAccount')}
            </button>
          )
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('clusters.col.account')}</th>
                <th>{t('clusters.col.sshHost')}</th>
                <th className="num">{t('clusters.col.gpus')}</th>
                <th>{t('clusters.col.qos')}</th>
                <th className="num">{t('clusters.col.interval')}</th>
                <th className="num">{t('clusters.col.lastSuccess')}</th>
                <th>{t('clusters.col.state')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((source) => (
                <AccountRow key={source.id} source={source} ctx={ctx} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="panel-note">{t('clusters.qosNote')}</p>
      </Panel>
      <Panel title={t('clusters.nodes')} count={nodes.length}>
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
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clusters.col.node')}</th>
                  <th>{t('clusters.col.cluster')}</th>
                  <th>{t('clusters.col.gpuAllocated')}</th>
                  <th className="num">{t('clusters.col.cpuAllocated')}</th>
                  <th>Partition</th>
                  <th>{t('clusters.col.state')}</th>
                  <th className="num">{t('clusters.col.sampled')}</th>
                </tr>
              </thead>
              <tbody>
                {shownNodes.map((node) => (
                  <tr key={node.id}>
                    <td className="mono">{node.name}</td>
                    <td>{findGroup(groups, node.cluster_id)?.label ?? node.cluster_id}</td>
                    <td>
                      <Meter
                        value={
                          node.gpu_count && node.gpu_allocated != null
                            ? (node.gpu_allocated / node.gpu_count) * 100
                            : null
                        }
                        text={`${node.gpu_allocated ?? '?'} / ${node.gpu_count ?? '?'}`}
                      />
                    </td>
                    <td className="num">
                      {node.cpu_allocated ?? '?'} / {node.cpu_count ?? '?'}
                    </td>
                    <td className="muted">{node.partitions.join(', ') || '—'}</td>
                    <td>
                      <span className={`tag ${nodeTone(node)}`}>{node.state}</span>
                    </td>
                    <td className="num muted">{relativeTime(node.observed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={nodes.length || query ? t('clusters.nodes.noMatch') : t('clusters.nodes.none')}
            text={nodes.length || query ? undefined : t('clusters.nodes.noneHint')}
          />
        )}
      </Panel>
    </>
  );
}

function AccountRow({ source, ctx }: { source: Source; ctx: Ctx }) {
  const summary = ctx.data.summary.sources[source.id];
  const message = source.error
    ? formatMessage(source.error)
    : source.warnings?.map(formatMessage).join('; ');
  return (
    <>
      <tr className={message ? 'has-note' : ''}>
        <td>
          <span className="with-mark">
            <GroupMark group={findGroup(ctx.groups, source.cluster_id)} />
            <span>
              <strong>{source.name}</strong>
              <span className="sub">{source.username || '—'}</span>
            </span>
          </span>
        </td>
        <td className="mono">
          {source.ssh_alias || <span className="muted">{t('common.notSet')}</span>}
        </td>
        <td className="num">
          {partialCount(summary.allocated, summary.known_allocated)} /{' '}
          {partialCount(summary.requested, summary.known_requested)}
        </td>
        <td>
          {source.qos.length ? (
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
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className="num">{t('common.minutes', { count: source.interval_minutes })}</td>
        <td className="num">{relativeTime(source.last_success)}</td>
        <td>
          <Status state={sourceState(source)} />
        </td>
        <td className="num">
          {!ctx.demo && (
            <button className="button small" onClick={() => ctx.configure(source)}>
              {t('common.configure')}
            </button>
          )}
        </td>
      </tr>
      {message && (
        <tr className="note-row">
          <td colSpan={8}>
            <span className={source.error ? 'red-text' : 'amber-text'}>{message}</span>
          </td>
        </tr>
      )}
    </>
  );
}
