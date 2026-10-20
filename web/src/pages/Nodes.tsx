import { useState } from 'react';
import type { FormEvent } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { CollectionNode } from '../types';
import { api } from '../api';
import { errorText, formatMessage, t } from '../i18n';
import { relativeTime } from '../domain';
import { Panel, Status } from '../ui';
import type { Ctx } from './shared';

const STATUS: Record<CollectionNode['status'], string> = {
  ok: 'ready',
  error: 'error',
  unchecked: 'configured',
};

function NodeEditor({ node, onDone }: { node?: CollectionNode; onDone: (saved: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get('name') ?? '').trim(),
      ssh_alias: String(form.get('ssh_alias') ?? '').trim(),
      command: String(form.get('command') ?? '').trim() || 'computedeck',
    };
    try {
      await api(
        node ? `/nodes/${encodeURIComponent(node.id)}` : '/nodes',
        body,
        node ? 'PUT' : 'POST',
      );
      onDone(true);
    } catch (reason) {
      setError(errorText(reason, 'error.save'));
    }
  }
  return (
    <form className="inline-editor" onSubmit={(event) => void save(event)}>
      <div className="form-grid">
        <label>
          {t('nodes.name')}
          <input
            name="name"
            defaultValue={node?.name ?? ''}
            placeholder={t('nodes.namePlaceholder')}
            required
            maxLength={80}
            autoFocus
          />
        </label>
        <label>
          {t('source.form.sshAliasLabel')}
          <input
            name="ssh_alias"
            defaultValue={node?.ssh_alias ?? ''}
            placeholder="lab-gateway"
            pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
            required
          />
        </label>
        <label className="span-two">
          {t('nodes.command')}
          <input
            name="command"
            defaultValue={node?.command ?? 'computedeck'}
            placeholder="~/.local/bin/computedeck"
          />
          <small>{t('nodes.commandHint')}</small>
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" className="button" onClick={() => onDone(false)}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="button primary">
          {t('common.save')}
        </button>
      </footer>
    </form>
  );
}

/** Machines that collect sources for this service: a cluster reachable only from one of them. */
export function NodesPanel({ ctx, onChange }: { ctx: Ctx; onChange: () => Promise<void> }) {
  const [editing, setEditing] = useState<{ node?: CollectionNode } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const used = (node: CollectionNode) =>
    ctx.data.sources.filter((source) => source.node === node.id).length;

  async function check(node: CollectionNode) {
    setChecking(node.id);
    try {
      const result = await api<CollectionNode>(`/nodes/${encodeURIComponent(node.id)}/check`, {});
      ctx.notify(
        result.status === 'ok'
          ? t('nodes.checked', { name: node.name, version: result.version ?? '' })
          : formatMessage(result.error),
        result.status === 'ok' ? 'ok' : 'error',
      );
      await onChange();
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.save'), 'error');
    } finally {
      setChecking(null);
    }
  }
  async function remove(node: CollectionNode) {
    if (!window.confirm(t('notify.removeConfirm', { name: node.name }))) return;
    try {
      await api(`/nodes/${encodeURIComponent(node.id)}`, {}, 'DELETE');
      await onChange();
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.save'), 'error');
    }
  }

  return (
    <Panel
      title={t('nodes.title')}
      count={ctx.nodes.length}
      actions={
        !ctx.demo && (
          <button className="button small" onClick={() => setEditing({})}>
            <Plus size={13} /> {t('nodes.add')}
          </button>
        )
      }
    >
      {editing && (
        <NodeEditor
          node={editing.node}
          onDone={(saved) => {
            setEditing(null);
            if (saved) void onChange();
          }}
        />
      )}
      {ctx.nodes.length > 0 && (
        <div className="table-wrap">
          <table className="table stack-on-phone">
            <thead>
              <tr>
                <th>{t('nodes.name')}</th>
                <th>{t('source.form.sshAliasLabel')}</th>
                <th>{t('nodes.version')}</th>
                <th className="num">{t('nodes.sources')}</th>
                <th>{t('clusters.col.state')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ctx.nodes.map((node) => (
                <tr key={node.id} className={node.error ? 'has-note' : ''}>
                  <td>
                    <strong>{node.name}</strong>
                    <span className="sub mono truncate" title={node.command}>
                      {node.command}
                    </span>
                  </td>
                  <td className="mono" data-label={t('source.form.sshAliasLabel')}>
                    {node.ssh_alias}
                  </td>
                  <td data-label={t('nodes.version')}>
                    {node.version ?? '—'}
                    <span className="sub">
                      {node.checked_at
                        ? t('nodes.checkedAt', { time: relativeTime(node.checked_at) })
                        : t('nodes.notChecked')}
                    </span>
                  </td>
                  <td className="num" data-label={t('nodes.sources')}>
                    {used(node)}
                  </td>
                  <td className="wrap" data-label={t('clusters.col.state')}>
                    <Status state={STATUS[node.status] ?? 'configured'} />
                    {node.error && (
                      <span className="sub red-text">{formatMessage(node.error)}</span>
                    )}
                  </td>
                  <td className="num nowrap">
                    {!ctx.demo && (
                      <>
                        <button
                          className="icon-button"
                          aria-label={t('nodes.check')}
                          title={t('nodes.check')}
                          disabled={checking === node.id}
                          onClick={() => void check(node)}
                        >
                          <RefreshCw size={13} className={checking === node.id ? 'spin' : ''} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={t('common.configure')}
                          onClick={() => setEditing({ node })}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={t('common.remove')}
                          onClick={() => void remove(node)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="panel-note">{t('nodes.note', { where: ctx.serverName })}</p>
    </Panel>
  );
}
