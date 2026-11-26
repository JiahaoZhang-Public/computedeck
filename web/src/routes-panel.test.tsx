// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SourceForm } from './forms';
import { api } from './api';
import { driverInfo } from './drivers';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { RoutesPanel } from './pages/RoutesPanel';
import type { Ctx } from './pages/shared';
import { serverDemo } from './test-server';
import type { CollectionNode, DriverField } from './types';

vi.mock('./api', () => ({ api: vi.fn(), upload: vi.fn(), download: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(api).mockReset().mockResolvedValue([]);
  setLocale('en');
  history.replaceState(null, '', '#/sources');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function node(patch: Partial<CollectionNode>): CollectionNode {
  return {
    id: 'bastion',
    name: 'Campus bastion',
    ssh_alias: 'campus-bastion',
    command: 'computedeck',
    status: 'ok',
    version: null,
    drivers: [],
    checked_at: null,
    error: null,
    ...patch,
  };
}
function context(nodes: CollectionNode[], patch: Partial<Ctx> = {}) {
  const data = serverDemo();
  // Two logins of one cluster through the jump host; everything else stays direct.
  for (const source of data.sources)
    source.node = source.cluster_id === data.sources[0].cluster_id ? 'bastion' : '';
  return {
    data,
    groups: groupsOf(data),
    nodes,
    demo: false,
    remote: false,
    serverName: 'Example server',
    notify: vi.fn(),
    ...patch,
  } as unknown as Ctx;
}
const field = (key: string, required = true): DriverField => ({
  key,
  label: { en: key },
  hint: {},
  placeholder: '',
  default: '',
  required,
  pattern: null,
  choices: null,
  identity: false,
});
const rows = () => [...container.querySelectorAll('.routes > li')];

it('shows each route as a path and names a cluster once however many logins use it', async () => {
  const ctx = context([node({ mode: 'jump' }), node({ id: 'legacy', name: 'Lab gateway' })]);
  await act(async () => root.render(<RoutesPanel ctx={ctx} onChange={vi.fn()} />));
  const [direct, jump, legacy] = rows();
  expect(direct.textContent).toContain(t('routes.here'));
  expect(direct.textContent).toContain(t('routes.kind.direct'));
  const cluster = ctx.groups.find((group) => group.key === ctx.data.sources[0].cluster_id)!;
  expect(cluster.sources.length).toBeGreaterThan(1);
  expect(jump.querySelector('.hop.end')!.textContent).toBe(cluster.label);
  expect(direct.querySelector('.hop.end')!.textContent).not.toContain(cluster.label);
  expect(jump.textContent).toContain(t('routes.kind.jump'));
  // A service older than 0.8 sends no mode: that is a collection machine.
  expect(legacy.textContent).toContain(t('routes.kind.collect'));
  expect(legacy.querySelector('.hop.end')!.textContent).toBe(t('routes.unused'));
  // The hops are an ordered list, so the path reads in order without the arrows.
  expect([...jump.querySelectorAll('.route-path > .hop')].map((hop) => hop.textContent)).toEqual([
    t('routes.here'),
    'Campus bastion',
    cluster.label,
  ]);
});

it('names the server instead of this computer when viewed remotely', async () => {
  const ctx = context([], { remote: true });
  await act(async () => root.render(<RoutesPanel ctx={ctx} onChange={vi.fn()} />));
  expect(rows()[0].textContent).toContain('Example server');
  expect(rows()[0].textContent).not.toContain(t('routes.here'));
});

it('saves a new route with its kind, then checks it', async () => {
  history.replaceState(null, '', '#/sources?route=new');
  const saved = node({ mode: 'jump', status: 'unchecked' });
  vi.mocked(api).mockImplementation(async (path, _body, method) => {
    if (path === '/nodes' && method === 'POST') return saved;
    if (path === '/nodes/bastion/check') return { ...saved, status: 'ok' };
    return [];
  });
  const ctx = context([]);
  const reload = vi.fn(async () => {});
  await act(async () => root.render(<RoutesPanel ctx={ctx} onChange={reload} />));
  const form = container.querySelector('form')!;
  // A jump host needs nothing installed, so there is no command to ask for.
  expect(form.querySelector('[name="command"]')).toBeNull();
  form.querySelector<HTMLInputElement>('[name="name"]')!.value = 'Campus bastion';
  form.querySelector<HTMLInputElement>('[name="ssh_alias"]')!.value = 'campus-bastion';
  await act(async () =>
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(api).toHaveBeenCalledWith(
    '/nodes',
    { name: 'Campus bastion', ssh_alias: 'campus-bastion', command: 'computedeck', mode: 'jump' },
    'POST',
  );
  expect(api).toHaveBeenCalledWith('/nodes/bastion/check', {});
  expect(ctx.notify).toHaveBeenCalledWith(
    t('routes.checkedJump', { name: 'Campus bastion' }),
    'ok',
  );
  expect(window.location.hash).toBe('#/sources');
});

it('asks for the command only for a collection machine and locks the kind while in use', async () => {
  history.replaceState(null, '', '#/sources?route=bastion');
  const ctx = context([node({ mode: 'collect' })]);
  await act(async () => root.render(<RoutesPanel ctx={ctx} onChange={vi.fn()} />));
  expect(container.querySelector('[name="command"]')).not.toBeNull();
  expect(container.querySelector<HTMLFieldSetElement>('.route-kinds')!.disabled).toBe(true);
  expect(container.textContent).toContain(t('routes.form.kindLocked'));
});

it('offers no editing in example mode', async () => {
  history.replaceState(null, '', '#/sources?route=new');
  const ctx = context([node({ mode: 'jump' })], { demo: true });
  await act(async () => root.render(<RoutesPanel ctx={ctx} onChange={vi.fn()} />));
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
});

it('lets a source pick a route, without a jump host for sources that do not use SSH', async () => {
  const data = serverDemo();
  const nodes = [node({ mode: 'jump' }), node({ id: 'gateway', name: 'Lab gateway' })];
  const form = (driver: string, fields: DriverField[]) => {
    const info = driverInfo([], driver);
    info.fields = fields;
    return (
      <SourceForm
        preset={{ driver }}
        sources={[]}
        groups={groupsOf(data)}
        drivers={[info]}
        nodes={nodes}
        where="this computer"
        busy={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onManual={vi.fn()}
        onDelete={vi.fn()}
      />
    );
  };
  await act(async () => root.render(form('slurm', [field('username'), field('ssh_alias')])));
  const options = () => [...container.querySelectorAll<HTMLOptionElement>('[name="node"] option')];
  expect(options().map((option) => [option.textContent, option.disabled])).toEqual([
    [t('source.form.routeDirect', { where: 'this computer' }), false],
    [t('source.form.routeVia.jump', { name: 'Campus bastion' }), false],
    [t('source.form.routeVia.collect', { name: 'Lab gateway' }), false],
  ]);
  // Host suggestions come from this computer's SSH configuration.
  expect(container.querySelector('[name="field:ssh_alias"]')!.getAttribute('list')).toBe(
    'ssh-hosts',
  );
  await act(async () => root.render(form('runpod', [field('credential')])));
  expect(options().map((option) => option.disabled)).toEqual([false, true, false]);
});
