import { useConfirm } from '../layers/useConfirm';
import { useRouteParam } from '../useRouteParam';
import { Fragment, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowRight, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { CollectionNode, RouteMode, Source } from '../types';
import { api } from '../api';
import { errorText, formatMessage, t } from '../i18n';
import { statusKind, statusKindLabel } from '../labels';
import { sshHostHint, useSshHosts } from '../sshHosts';
import { Panel } from '../ui';
import { StatusLabel } from '../ui/Status';
import type { Ctx } from './shared';

const STATUS: Record<CollectionNode['status'], string> = {
  ok: 'ready',
  error: 'error',
  unchecked: 'configured',
};
const MODES: RouteMode[] = ['jump', 'collect'];
/** Destinations named on one line before the rest are counted. */
const NAMED = 4;

const routeMode = (node: CollectionNode | undefined): RouteMode =>
  node?.mode === 'jump' ? 'jump' : 'collect';

function RouteEditor({
  node,
  inUse,
  demo,
  onDone,
}: {
  node?: CollectionNode;
  /** Sources use the route, so its kind stays what they were saved with. */
  inUse: boolean;
  demo: boolean;
  onDone: (saved?: CollectionNode) => void;
}) {
  const [mode, setMode] = useState<RouteMode>(node ? routeMode(node) : 'jump');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hosts = useSshHosts(demo);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get('name') ?? '').trim(),
      ssh_alias: String(form.get('ssh_alias') ?? '').trim(),
      command: String(form.get('command') ?? node?.command ?? '').trim() || 'computedeck',
      mode,
    };
    setBusy(true);
    try {
      onDone(
        await api<CollectionNode>(
          node ? `/nodes/${encodeURIComponent(node.id)}` : '/nodes',
          body,
          node ? 'PUT' : 'POST',
        ),
      );
    } catch (reason) {
      setError(errorText(reason, 'error.save'));
      setBusy(false);
    }
  }
  return (
    <form className="inline-editor" onSubmit={(event) => void save(event)}>
      {/* The route's last failure is here, in its editor, not on the list. */}
      {node?.error && <p className="red-text">{formatMessage(node.error)}</p>}
      <div className="form-grid">
        <fieldset className="span-two choice-group route-kinds" disabled={inUse}>
          <legend>{t('routes.form.kind')}</legend>
          {MODES.map((kind) => (
            <label key={kind} className="type-card route-kind">
              <input
                type="radio"
                name="mode"
                value={kind}
                checked={mode === kind}
                onChange={() => setMode(kind)}
              />
              <span>
                <strong>{t(`routes.kind.${kind}`)}</strong>
                <small>{t(`routes.kindHint.${kind}`)}</small>
              </span>
            </label>
          ))}
          {inUse && <small>{t('routes.form.kindLocked')}</small>}
        </fieldset>
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
            list="route-ssh-hosts"
            defaultValue={node?.ssh_alias ?? ''}
            placeholder="lab-gateway"
            pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
            required
          />
          <datalist id="route-ssh-hosts">
            {hosts.map((host) => (
              <option key={host.alias} value={host.alias}>
                {sshHostHint(host)}
              </option>
            ))}
          </datalist>
        </label>
        {mode === 'collect' && (
          <label className="span-two">
            {t('nodes.command')}
            <input
              name="command"
              defaultValue={node?.command ?? 'computedeck'}
              placeholder="~/.local/bin/computedeck"
            />
          </label>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" className="button" onClick={() => onDone()}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {t('routes.form.save')}
        </button>
      </footer>
    </form>
  );
}

/** The hops of one route, left to right; a list, so it reads in order without the arrows. */
function Path({ hops }: { hops: ReactNode[] }) {
  return (
    <span className="route-path grow" role="list">
      {hops.map((hop, index) => (
        <Fragment key={index}>
          {index > 0 && <ArrowRight size={12} className="muted" aria-hidden="true" />}
          <span className={index === hops.length - 1 ? 'hop end' : 'hop'} role="listitem">
            {hop}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** How this ComputeDeck reaches each source: directly, or through another machine. */
export function RoutesPanel({ ctx, onChange }: { ctx: Ctx; onChange: () => Promise<void> }) {
  const [confirm, confirmation] = useConfirm();
  const [routeParam, setRouteParam] = useRouteParam('route');
  const [checking, setChecking] = useState<string | null>(null);
  const here = ctx.remote ? ctx.serverName : t('routes.here');
  const editing =
    routeParam === 'new'
      ? {}
      : routeParam
        ? { node: ctx.nodes.find((node) => node.id === routeParam) }
        : null;
  const using = (id: string) => ctx.data.sources.filter((source) => (source.node ?? '') === id);
  /** Each cluster or platform once, however many logins it has. */
  const destinations = (sources: Source[]) => {
    const names = [
      ...new Set(
        sources.map(
          (source) =>
            ctx.groups.find((group) => group.sources.includes(source))?.label ?? source.name,
        ),
      ),
    ];
    return names.length ? (
      <>
        {names.slice(0, NAMED).join(', ')}
        {names.length > NAMED && ` ${t('summary.more', { count: names.length - NAMED })}`}
      </>
    ) : (
      <span className="muted">{t('routes.unused')}</span>
    );
  };

  async function check(node: CollectionNode) {
    setChecking(node.id);
    try {
      const result = await api<CollectionNode>(`/nodes/${encodeURIComponent(node.id)}/check`, {});
      ctx.notify(
        result.status !== 'ok'
          ? formatMessage(result.error)
          : routeMode(result) === 'jump'
            ? t('routes.checkedJump', { name: node.name })
            : t('nodes.checked', { name: node.name, version: result.version ?? '' }),
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
    if (!(await confirm(t('notify.removeConfirm', { name: node.name }), t('layer.removeNode'))))
      return;
    try {
      await api(`/nodes/${encodeURIComponent(node.id)}`, {}, 'DELETE');
      await onChange();
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.save'), 'error');
    }
  }

  const direct = using('');
  return (
    <Panel
      id="routes"
      className="routes-panel"
      title={t('routes.title')}
      actions={
        !ctx.demo && (
          <button className="button small" onClick={() => setRouteParam('new')}>
            {t('routes.add')}
          </button>
        )
      }
    >
      {confirmation}
      {editing && !ctx.demo && (
        <RouteEditor
          key={editing.node?.id ?? 'new'}
          node={editing.node}
          inUse={!!editing.node && using(editing.node.id).length > 0}
          demo={ctx.demo}
          onDone={(saved) => {
            setRouteParam('');
            if (saved) void onChange().then(() => check(saved));
          }}
        />
      )}
      <ul className="rows routes">
        <li>
          <Path hops={[here, destinations(direct)]} />
          <span className="muted">{t('routes.kind.direct')}</span>
        </li>
        {ctx.nodes.map((node) => {
          const mode = routeMode(node);
          const state = STATUS[node.status] ?? 'configured';
          return (
            <li key={node.id}>
              <Path
                hops={[
                  here,
                  <strong title={node.ssh_alias}>{node.name}</strong>,
                  destinations(using(node.id)),
                ]}
              />
              <span className="muted">{t(`routes.kind.${mode}`)}</span>
              <StatusLabel kind={statusKind(state)} label={statusKindLabel(state)} />
              {!ctx.demo && (
                <span className="nowrap">
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
                    title={t('common.configure')}
                    onClick={() => setRouteParam(node.id)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={t('common.remove')}
                    title={t('common.remove')}
                    onClick={() => void remove(node)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
