// @vitest-environment jsdom
import { act, memo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { api } from './api';
import {
  collectSource,
  finishCollections,
  setSourcePaused,
  testSource,
  useSourceInFlight,
} from './sourceActions';
import { useStableActions } from './useStableActions';
import type { Source } from './types';
vi.mock('./api', () => ({ api: vi.fn() }));

it('shares test/collect exclusion, completion and pause writes across consumers', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const source = { id: 'shared-source' } as Source;
  let finish!: (rows: never[]) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  function Probe() {
    const state = useSourceInFlight();
    return <output>{state[source.id] ?? 'idle'}</output>;
  }
  try {
    await act(async () =>
      root.render(
        <>
          <Probe />
          <Probe />
        </>,
      ),
    );
    let testing!: ReturnType<typeof testSource>;
    await act(async () => {
      testing = testSource(source.id);
    });
    expect(node.textContent).toBe('testtest');
    expect(await collectSource(source)).toBe(false);
    expect(await testSource(source.id)).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish([]);
      await testing;
    });
    expect(node.textContent).toBe('idleidle');
    vi.mocked(api).mockResolvedValue(undefined);
    await act(async () => {
      await collectSource(source);
    });
    expect(node.textContent).toBe('collectcollect');
    expect(await testSource(source.id)).toBeUndefined();
    await act(async () => finishCollections([source.id]));
    expect(node.textContent).toBe('collectcollect');
    await act(async () => finishCollections([]));
    await act(async () => {
      await setSourcePaused(source, true);
      await setSourcePaused(source, false);
    });
    expect(api).toHaveBeenCalledWith('/sources/shared-source', { enabled: false }, 'PUT');
    expect(api).toHaveBeenLastCalledWith('/sources/shared-source', { enabled: true }, 'PUT');
  } finally {
    await act(async () => root.unmount());
    node.remove();
    vi.unstubAllGlobals();
  }
});
it('keeps row actions stable across parent updates while reading current state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node = document.createElement('div');
  const root = createRoot(node);
  let renders = 0;
  const seen = vi.fn();
  const Row = memo(function Row({ actions }: { actions: { open: () => void } }) {
    renders++;
    return <button onClick={actions.open}>Open</button>;
  });
  function Example() {
    const [value, setValue] = useState(1);
    const actions = useStableActions({ open: () => seen(value) });
    return (
      <>
        <button onClick={() => setValue(2)}>Update</button>
        <Row actions={actions} />
      </>
    );
  }
  try {
    await act(async () => root.render(<Example />));
    await act(async () => node.querySelector('button')!.click());
    await act(async () => node.querySelectorAll('button')[1].click());
    expect(seen).toHaveBeenCalledWith(2);
    expect(renders).toBe(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
