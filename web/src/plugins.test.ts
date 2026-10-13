import { describe, expect, it } from 'vitest';
import { activePlugins, pagesOf, registerWebPlugin } from './plugins';
import type { WebPlugin } from './plugins';
import type { Tool } from './types';

const tool = (id: string, enabled: boolean) => ({ id, enabled }) as Tool;

describe('web plugins', () => {
  it('hides a plugin while its server plugin is off', () => {
    const plugins: WebPlugin[] = [{ id: 'free' }, { id: 'tied', requires: 'notify' }];
    expect(activePlugins(plugins, [tool('notify', false)]).map((item) => item.id)).toEqual([
      'free',
    ]);
    expect(activePlugins(plugins, [tool('notify', true)])).toHaveLength(2);
    expect(activePlugins(plugins, [])).toHaveLength(1);
  });
  it('registers each plugin once and lists its pages', () => {
    const page = { id: 'demo-page', label: 'Demo', icon: () => null, render: () => null };
    registerWebPlugin({ id: 'demo', pages: [page] } as unknown as WebPlugin);
    registerWebPlugin({ id: 'demo', pages: [] });
    registerWebPlugin(null as unknown as WebPlugin);
    expect(pagesOf([{ id: 'demo', pages: [page] } as unknown as WebPlugin])).toEqual([page]);
  });
});
