// @vitest-environment jsdom
import { act, StrictMode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHash, corePages, readRoute, routeAliases, routeHash, useHash } from './routes';
import { routeParams, setRouteParams, useRouteParam } from './useRouteParam';
import { installHost } from './host';

const aliases = [
  ['clusters', '#/resources', 'resources', null],
  ['nodes', '#/resources?tab=nodes', 'resources', 'nodes'],
  ['marketplace', '#/toolbox?tab=market', 'toolbox', 'market'],
] as const;

describe.each(['native', 'unavailable'])('URLSearchParams.size %s', (size) => {
  const sizeDescriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size')!;
  beforeEach(() => {
    if (size === 'unavailable') {
      Object.defineProperty(URLSearchParams.prototype, 'size', {
        configurable: true,
        get: () => undefined,
      });
    }
  });
  afterEach(() => {
    Object.defineProperty(URLSearchParams.prototype, 'size', sizeDescriptor);
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    delete window.ComputeDeck;
    vi.unstubAllGlobals();
  });

  it.each(aliases)(
    'resolves %s identically for bookmarks, core links and plugin links',
    (alias, hash, page, tab) => {
      installHost();
      expect(routeHash(alias)).toBe(hash);
      expect(canonicalHash(`#/${alias}`)).toBe(hash);
      expect(readRoute(corePages, `#/${alias}`)).toEqual({ page, group: 'all' });
      expect(routeParams(`#/${alias}`).get('tab')).toBe(tab);
      expect(window.ComputeDeck!.routeHash(alias)).toBe(hash);
      expect(window.ComputeDeck!.routeAliases).toBe(routeAliases);
      expect(routeAliases[alias]).toBe(hash.slice(2));
      const grouped = routeHash(alias, 'cluster a&b');
      expect(readRoute(corePages, grouped)).toEqual({ page, group: 'cluster a&b' });
      expect(routeParams(grouped).get('tab')).toBe(tab);
    },
  );

  it.each([
    ['#/resources?nodes=abnormal', { nodes: 'abnormal', tab: 'nodes' }],
    ['#/resources?nodes=idle&group=cluster-a', { nodes: 'idle', group: 'cluster-a', tab: 'nodes' }],
    [
      '#/clusters?nodes=all&provider=cluster-a',
      { nodes: 'all', provider: 'cluster-a', tab: 'nodes' },
    ],
    [
      '#/nodes?tab=overview&q=two%20words&node=a%26b',
      { tab: 'nodes', q: 'two words', node: 'a&b' },
    ],
    ['#/marketplace?tab=installed&market-q=hello', { tab: 'market', 'market-q': 'hello' }],
    ['#/resources?nodes=idle&tab=qos', { nodes: 'idle', tab: 'qos' }],
  ])(
    'canonicalizes %s without dropping filters or changing explicit canonical tabs',
    (hash, params) => {
      const canonical = canonicalHash(hash);
      expect(Object.fromEntries(routeParams(canonical))).toEqual(params);
      expect(canonicalHash(canonical)).toBe(canonical);
    },
  );

  it('preserves all core and plugin ids, unknown parameters and provider precedence', () => {
    for (const page of [...corePages, '__gallery', 'example-plugin']) {
      const hash = `#/${page}?custom=two%20words&group=a&provider=b`;
      expect(canonicalHash(hash)).toBe(hash);
      expect(readRoute([...corePages, '__gallery', 'example-plugin'], hash)).toEqual({
        page,
        group: 'a',
      });
    }
    expect(readRoute(corePages, '#/jobs?provider=b')).toEqual({ page: 'jobs', group: 'b' });
    expect(readRoute(corePages, '#/jobs?group=&provider=b').group).toBe('all');
    for (const page of ['unknown', 'constructor', 'toString']) {
      expect(canonicalHash(`#/${page}`)).toBe(`#/${page}`);
      expect(readRoute(corePages, `#/${page}`).page).toBe('overview');
    }
  });

  it.each([
    'scope',
    'reason',
    'attention',
    'node',
    'source',
    'add',
    'edit',
    'repair',
    'step',
    'section',
    'plugin',
    'rule',
    'rate',
    'tab',
  ])('round-trips the new %s key through an alias and filter changes', (key) => {
    window.history.replaceState(null, '', '/?remote=1&device=example&demo=true#/clusters?group=a');
    const length = window.history.length;
    setRouteParams({ [key]: 'example a&b' }, true);
    expect(window.history.length).toBe(length + 1);
    expect(window.history.state).toEqual({ detail: true });
    setRouteParams({ q: 'filter' });
    expect(routeParams().get(key)).toBe('example a&b');
    expect(routeParams().get('group')).toBe('a');
    expect(window.location.hash.split('?')[0]).toBe('#/resources');
    expect(window.location.search).toBe('?remote=1&device=example&demo=true');
    setRouteParams({ [key]: null });
    expect(routeParams().has(key)).toBe(false);
  });

  it('reads a hash change between render and subscription, and replaces aliases without a Back stop', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState({ detail: true }, '', '/?demo=true#/resources');
    const length = window.history.length;
    const container = document.createElement('div');
    const root = createRoot(container);
    function Probe() {
      const hash = useHash();
      const [tab] = useRouteParam('tab');
      useLayoutEffect(() => {
        window.history.replaceState(window.history.state, '', '#/marketplace?market-q=hello');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }, []);
      return (
        <output>
          {readRoute(corePages, hash).page}:{tab}
        </output>
      );
    }
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <Probe />
          </StrictMode>,
        ),
      );
      expect(container.textContent).toBe('toolbox:market');
      expect(window.location.hash).toBe('#/toolbox?market-q=hello&tab=market');
      expect(window.history.length).toBe(length);
      expect(window.history.state).toEqual({ detail: true });
      expect(window.location.search).toBe('?demo=true');
      await act(async () => {
        window.history.replaceState(null, '', '#/resources');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      expect(container.textContent).toBe('resources:');
      await act(async () => {
        window.history.replaceState(null, '', '#/overview');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(container.textContent).toBe('overview:');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps the Nodes tab in grouped links', () => {
    expect(routeHash('nodes', 'g')).toBe('#/resources?tab=nodes&group=g');
  });

  it('preserves filters when updating an alias and removes an empty query', () => {
    window.history.replaceState(null, '', '/?demo=true#/clusters?group=x');
    setRouteParams({ q: 'two words', nodes: 'abnormal' });
    expect(window.location.hash).toBe('#/resources?group=x&q=two+words&nodes=abnormal&tab=nodes');
    setRouteParams({ q: null });
    expect(Object.fromEntries(routeParams())).toEqual({
      group: 'x',
      nodes: 'abnormal',
      tab: 'nodes',
    });
    setRouteParams({ group: null, nodes: null, tab: null });
    expect(window.location.hash).toBe('#/resources');
    expect(window.location.search).toBe('?demo=true');
  });
});
