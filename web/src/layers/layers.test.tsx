// @vitest-environment jsdom
import { act, StrictMode, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextPanel, FocusView } from './Surface';
import { ConfirmDialog } from './ConfirmDialog';
import { useConfirm } from './useConfirm';
import { useLayer } from './stack';
import { MenuButton } from './Popover';
import { Toasts } from './Toasts';
import type { Toast } from './Toasts';
import { openLayer, closeLayer, replaceLayer } from './routes';
import { setRouteParams } from '../useRouteParam';
import { SourceForm } from '../forms';
import { ToolboxPage } from '../pages/Toolbox';
import type { Ctx } from '../pages/shared';
import { setLocale, t } from '../i18n';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/?demo=true&remote=1#/jobs?state=pending');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocale('en');
});
async function render(node: ReactNode) {
  await act(async () => root.render(<StrictMode>{node}</StrictMode>));
}
async function click(selector: string) {
  const node = container.querySelector<HTMLElement>(selector);
  expect(node).not.toBeNull();
  await act(async () => node!.click());
}
async function key(key: string, options = {}) {
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, ...options })),
  );
}

it.each(['en', 'zh-CN'] as const)(
  'confirmation in %s defaults to Keep, returns a decision once and restores focus',
  async (locale) => {
    setLocale(locale);
    const remove = vi.fn();
    function Example() {
      const [confirm, dialog] = useConfirm();
      return (
        <>
          <button
            onClick={async () => {
              if (await confirm(t('layer.confirm'), t('layer.removeSource'))) remove();
            }}
          >
            {t('common.remove')}
          </button>
          {dialog}
        </>
      );
    }
    await render(<Example />);
    const opener = container.querySelector('button')!;
    opener.focus();
    await click('button');
    expect(document.activeElement?.textContent).toBe(t('layer.keep'));
    expect(container.querySelector('dialog')?.open).toBe(true);
    await click('dialog [data-safe]');
    expect(remove).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    await click('button');
    await key('Escape');
    expect(remove).not.toHaveBeenCalled();
    await click('button');
    await click('dialog button:last-child');
    expect(remove).toHaveBeenCalledOnce();
  },
);

it('only the top layer closes and restores the nested opener', async () => {
  function Example() {
    const [open, setOpen] = useState(false);
    const [confirm, dialog] = useConfirm();
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && (
          <FocusView labelledBy="title" close={() => setOpen(false)}>
            <h2 id="title">Form</h2>
            <button onClick={() => void confirm('Remove?', 'Remove')}>Remove</button>
            {dialog}
          </FocusView>
        )}
      </>
    );
  }
  await render(<Example />);
  const opener = container.querySelector('button')!;
  opener.focus();
  await click('button');
  const nested = container.querySelector<HTMLButtonElement>('dialog button')!;
  nested.focus();
  await click('dialog button');
  expect(container.querySelectorAll('dialog[open]')).toHaveLength(2);
  await key('Escape');
  expect(container.querySelectorAll('dialog[open]')).toHaveLength(1);
  expect(document.activeElement).toBe(nested);
  await key('Escape');
  expect(container.querySelectorAll('dialog')).toHaveLength(0);
  expect(document.activeElement).toBe(opener);
});

it('desktop panels are nonmodal and j/k replaces their subject, ignoring fields and composition', async () => {
  const media = window.matchMedia('unused');
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...media,
    media: query,
    matches: query.includes('1200'),
  }));
  const step = vi.fn();
  const close = vi.fn();
  await render(
    <ContextPanel labelledBy="panel-title" close={close} onStep={step}>
      <h2 id="panel-title">Job</h2>
      <input />
    </ContextPanel>,
  );
  const panel = container.querySelector('aside')!;
  expect(container.querySelector('dialog')).toBeNull();
  expect(panel.getAttribute('aria-modal')).toBeNull();
  expect(document.activeElement?.id).toBe('panel-title');
  await act(async () =>
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })),
  );
  expect(step).toHaveBeenCalledWith(1);
  await act(async () =>
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })),
  );
  expect(step).toHaveBeenCalledWith(-1);
  await act(async () =>
    panel
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })),
  );
  await act(async () =>
    panel.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'j', bubbles: true, isComposing: true }),
    ),
  );
  expect(step).toHaveBeenCalledTimes(2);
  await key('Escape');
  expect(close).toHaveBeenCalledOnce();
});

it('URLs push once, preserve filters and connection query, replace steps, and cold links close locally', () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  const length = history.length;
  openLayer({ add: 'ssh', step: '1' });
  expect(history.length).toBe(length + 1);
  replaceLayer({ step: '2' });
  expect(history.length).toBe(length + 1);
  expect(location.search).toBe('?demo=true&remote=1');
  closeLayer(['add', 'step']);
  expect(back).toHaveBeenCalledOnce();
  setRouteParams({ q: 'alice' });
  closeLayer(['add', 'step']);
  expect(location.hash).toBe('#/jobs?state=pending&q=alice');
  expect(back).toHaveBeenCalledOnce();
  history.replaceState(null, '', '#/sources?group=a&edit=example-1&step=2');
  closeLayer(['edit', 'step']);
  expect(location.hash).toBe('#/sources?group=a');
  expect(back).toHaveBeenCalledOnce();
});

it.each([
  { hash: '', key: 'event', openedHash: '#/overview?event=example-event' },
  { hash: '#/jobs?q=a%20b', key: 'job', openedHash: '#/jobs?q=a+b&job=example-job' },
])(
  'closing a layer from "$hash" normalizes both hashes and goes Back',
  ({ hash, key, openedHash }) => {
    history.replaceState(null, '', `/?demo=true${hash}`);
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    const length = history.length;
    openLayer({ [key]: `example-${key}` });
    expect(history.length).toBe(length + 1);
    expect(location.hash).toBe(openedHash);
    expect(history.state.layerBase).toBe(hash);
    const replace = vi.spyOn(history, 'replaceState');
    closeLayer([key]);
    expect(back).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  },
);

it('menu arrows, Home/End, typeahead and disabled items follow the APG contract', async () => {
  const action = vi.fn();
  await render(
    <MenuButton
      label="Actions"
      items={[
        { label: 'Alpha', action },
        { label: 'Beta', action, disabled: true },
        { label: 'Charlie', action },
      ]}
    />,
  );
  await click('button');
  const menu = container.querySelector('[role="menu"]')!;
  const items = menu.querySelectorAll<HTMLButtonElement>('button');
  expect(document.activeElement).toBe(items[0]);
  async function press(value: string) {
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      ),
    );
  }
  await press('End');
  expect(document.activeElement).toBe(items[2]);
  await press('Home');
  expect(document.activeElement).toBe(items[0]);
  await press('b');
  expect(document.activeElement).toBe(items[1]);
  await act(async () => items[1].click());
  expect(action).not.toHaveBeenCalled();
  await press('ArrowDown');
  await act(async () => items[2].click());
  expect(action).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="menu"]')).toBeNull();
});

it('Undo pauses on hover and focus, errors persist, Escape dismisses toasts before the layer', async () => {
  vi.useFakeTimers();
  const undo = vi.fn();
  const close = vi.fn();
  function Example() {
    const [items, setItems] = useState<Toast[]>([
      { id: 1, text: 'Saved', tone: 'ok', action: { label: 'Undo', undo: true, run: undo } },
      { id: 2, text: 'Error', tone: 'error' },
    ]);
    return (
      <>
        <FocusView labelledBy="title" close={close}>
          <h2 id="title">Form</h2>
          <button>Safe</button>
        </FocusView>
        <Toasts
          items={items}
          dismiss={(id) =>
            setItems((rows) => (id === undefined ? [] : rows.filter((row) => row.id !== id)))
          }
        />
      </>
    );
  }
  await render(<Example />);
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(container.querySelector('dialog .toasts')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(9000));
  const toast = container.querySelector('.toast')!;
  await act(async () => toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(30000));
  expect(container.querySelectorAll('.toast')).toHaveLength(2);
  await act(async () => toast.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(999));
  expect(container.querySelectorAll('.toast')).toHaveLength(2);
  await key('z', { metaKey: true });
  expect(undo).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTime(60000));
  expect(container.querySelector('.toast.error')).not.toBeNull();
  const focused = document.activeElement;
  await key('Escape');
  expect(container.querySelectorAll('.toast')).toHaveLength(0);
  expect(document.activeElement).toBe(focused);
  expect(close).not.toHaveBeenCalled();
  await key('Escape');
  expect(close).toHaveBeenCalledOnce();
});

it('confirmation never dismisses from its backdrop and cancels on browser Back', async () => {
  const close = vi.fn();
  const confirm = vi.fn();
  await render(
    <ConfirmDialog title="Remove?" outcome="Remove source" close={close} confirm={confirm} />,
  );
  await act(async () =>
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
  );
  expect(close).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'tool settings close on success and stay open on failure=%s',
  async (fails) => {
    const updateTool = fails
      ? vi.fn().mockRejectedValue(new Error('Save failed'))
      : vi.fn().mockResolvedValue({});
    const tool = {
      id: 'example-tool',
      name: { en: 'Example tool' },
      description: {},
      origin: { kind: 'builtin' },
      enabled: true,
      permissions: [],
      errors: {},
      values: { enabled: true },
      settings: [
        { key: 'enabled', label: { en: 'Enabled' }, kind: 'boolean', required: false, hint: {} },
      ],
    };
    const ctx = { tools: [tool], updateTool, notify: vi.fn(), demo: false } as unknown as Ctx;
    history.replaceState(null, '', '#/toolbox?plugin=example-tool&edit=example-tool&step=1');
    await render(<ToolboxPage ctx={ctx} />);
    expect(container.querySelector('.context-panel, dialog.drawer')).not.toBeNull();
    expect(container.querySelector('dialog.focus-view input')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe(t('common.cancel'));
    expect(container.querySelector('.drawer form')).toBeNull();
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(updateTool).toHaveBeenCalledWith('example-tool', { settings: { enabled: true } });
    if (fails) {
      expect(container.querySelector('dialog.focus-view .form-error')?.textContent).toContain(
        'Save failed',
      );
      expect(location.hash).toContain('edit=example-tool');
      await key('Escape');
    }
    expect(location.hash).toBe('#/toolbox?plugin=example-tool');
    expect(container.querySelector('dialog.focus-view')).toBeNull();
    expect(document.activeElement?.id).toBe('tool-settings-example-tool');
  },
);

it('returns focus after React restores an outside selection on closing a layer', async () => {
  await render(
    <>
      <MenuButton label="Open menu" items={[{ label: 'Item', action: () => {} }]} />
      <button id="outside">Outside</button>
    </>,
  );
  const opener = container.querySelector<HTMLButtonElement>('button')!;
  opener.focus();
  await click('button');
  container.querySelector<HTMLElement>('#outside')!.focus();
  await key('Escape');
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('a closing layer does not steal focus from a newer layer in the same commit', async () => {
  function Example() {
    const [view, setView] = useState(0);
    return (
      <>
        <button onClick={() => setView(1)}>Open</button>
        {view === 1 && (
          <FocusView key="first" labelledBy="first" close={() => setView(2)}>
            <h2 id="first">First</h2>
          </FocusView>
        )}
        {view === 2 && (
          <FocusView key="second" labelledBy="second" close={() => setView(0)}>
            <h2 id="second">Second</h2>
          </FocusView>
        )}
      </>
    );
  }
  await render(<Example />);
  await click('button');
  await key('Escape');
  expect(document.activeElement?.id).toBe('second');
});

it('owns every modal Tab in DOM order, including from a middle button', async () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  await render(
    <FocusView labelledBy="tab-title" close={() => {}}>
      <h2 id="tab-title">Form</h2>
      <button id="first">First</button>
      <button disabled>Disabled</button>
      <input id="middle" />
      <details>
        <summary id="summary" tabIndex={0}>
          Details
        </summary>
        More information
      </details>
      <button id="last">Last</button>
    </FocusView>,
  );
  const press = async (shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  };
  for (const id of ['first', 'middle', 'summary', 'last', 'first']) {
    await press();
    expect(document.activeElement?.id).toBe(id);
  }
  for (const id of ['last', 'summary', 'middle', 'first', 'last']) {
    await press(true);
    expect(document.activeElement?.id).toBe(id);
  }
});

it('makes the lower focus view inert until its confirmation closes and returns focus', async () => {
  function Example() {
    const [confirm, confirmation] = useConfirm();
    return (
      <FocusView labelledBy="lower-title" close={() => {}}>
        <h2 id="lower-title">Form</h2>
        <button id="confirm-opener" onClick={() => void confirm('Remove?', 'Remove')}>
          Remove
        </button>
        {confirmation}
      </FocusView>
    );
  }
  await render(<Example />);
  const lower = container.querySelector('dialog')!;
  const opener = container.querySelector<HTMLButtonElement>('#confirm-opener')!;
  expect(lower.hasAttribute('inert')).toBe(false);
  opener.focus();
  await click('#confirm-opener');
  expect(lower.hasAttribute('inert')).toBe(true);
  expect(container.querySelector('dialog.confirm-dialog')!.hasAttribute('inert')).toBe(false);
  await key('Escape');
  expect(container.querySelector('dialog.confirm-dialog')).toBeNull();
  expect(lower.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(opener);
});

it.each([false, true])(
  'restores prior inert=%s with out-of-order modal closes and leaves nonmodal layers alone',
  async (initialInert) => {
    function Probe({ id, modal = true }: { id: string; modal?: boolean }) {
      const ref = useLayer({ modal, close: () => {} });
      return modal ? (
        <dialog ref={ref as Ref<HTMLDialogElement>} id={id}>
          <h2>{id}</h2>
        </dialog>
      ) : (
        <aside ref={ref} id={id}>
          <h2>{id}</h2>
        </aside>
      );
    }
    const tree = (middle: boolean, upper: boolean) => (
      <>
        <Probe key="plain" id="plain" modal={false} />
        <Probe key="lower" id="lower" />
        {middle && <Probe key="middle" id="middle" />}
        {upper && <Probe key="upper" id="upper" />}
      </>
    );
    await render(tree(false, false));
    const lower = container.querySelector('#lower')!;
    // Preserve the state immediately before the first covering modal opens.
    lower.toggleAttribute('inert', initialInert);
    await render(tree(true, true));
    const middle = container.querySelector('#middle')!;
    expect(lower.hasAttribute('inert')).toBe(true);
    expect(middle.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('#upper')!.hasAttribute('inert')).toBe(false);
    expect(container.querySelector('#plain')!.hasAttribute('inert')).toBe(false);
    await render(tree(false, true));
    expect(middle.hasAttribute('inert')).toBe(false);
    expect(lower.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('#upper')!.hasAttribute('inert')).toBe(false);
    await render(tree(false, false));
    expect(lower.hasAttribute('inert')).toBe(initialInert);
    expect(container.querySelector('#plain')!.hasAttribute('inert')).toBe(false);
  },
);

it.each(['blank', 'input', 'label'] as const)(
  'outside dismissal preserves the default focus behaviour for %s',
  async (target) => {
    const clicked = vi.fn();
    await render(
      <>
        <MenuButton label="Open menu" items={[{ label: 'Item', action: () => {} }]} />
        <p onClick={clicked}>
          <span id="blank">Selectable text</span>
        </p>
        <input id="input" />
        <label htmlFor="input">
          <span id="label">Field label</span>
        </label>
      </>,
    );
    const opener = container.querySelector<HTMLButtonElement>('button')!;
    const outside = container.querySelector<HTMLElement>(`#${target}`)!;
    const input = container.querySelector<HTMLInputElement>('#input')!;
    opener.focus();
    await click('button');
    const pointer = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      isPrimary: true,
      pointerType: 'mouse',
    });
    await act(async () => {
      outside.dispatchEvent(pointer);
      // jsdom does not supply mousedown's native focus default; browser coverage does.
      if (target !== 'blank') input.focus();
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(pointer.defaultPrevented).toBe(target === 'blank');
    expect(document.activeElement).toBe(target === 'blank' ? opener : input);
    if (target === 'blank') {
      await act(async () => outside.click());
      expect(clicked).toHaveBeenCalledOnce();
    }
    const next = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      isPrimary: true,
      pointerType: 'mouse',
    });
    outside.dispatchEvent(next);
    expect(next.defaultPrevented, 'No focus or text-selection suppression after dismissal').toBe(
      false,
    );
  },
);

it('hash navigation resolves a pending confirmation as Keep exactly once', async () => {
  const decision = vi.fn();
  function Example() {
    const [confirm, confirmation] = useConfirm();
    return (
      <>
        <button
          onClick={() => {
            void confirm('Remove?', 'Remove').then(decision);
          }}
        >
          Remove
        </button>
        {confirmation}
      </>
    );
  }
  await render(<Example />);
  await click('button');
  expect(container.querySelector('dialog')).not.toBeNull();
  await act(async () => {
    history.replaceState(null, '', '#/__gallery');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(container.querySelector('dialog')).toBeNull();
  expect(decision).toHaveBeenCalledExactlyOnceWith(false);
  await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(decision).toHaveBeenCalledOnce();
});

it('hash navigation also cancels tool-enable consent without enabling the tool', async () => {
  const updateTool = vi.fn();
  const ctx = {
    tools: [
      {
        id: 'example-tool',
        name: { en: 'Example tool' },
        description: {},
        origin: { kind: 'builtin' },
        enabled: false,
        permissions: [{ en: 'Read example data' }],
        settings: [],
        values: {},
        health: {},
        errors: {},
      },
    ],
    demo: false,
    updateTool,
  } as unknown as Ctx;
  history.replaceState(null, '', '#/toolbox');
  await render(<ToolboxPage ctx={ctx} />);
  await click('input[role="switch"]');
  expect(container.querySelector('dialog.focus-view')).not.toBeNull();
  await act(async () => {
    history.replaceState(null, '', '#/toolbox?q=example');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(container.querySelector('dialog.focus-view')).toBeNull();
  expect(updateTool).not.toHaveBeenCalled();
});

it.each(['source', 'ssh'])(
  'unsaved add=%s step 3 explains why the check is unavailable',
  async (kind) => {
    history.replaceState(null, '', `#/sources?add=${kind}&step=3`);
    await render(
      <SourceForm
        drivers={[]}
        sources={[]}
        groups={[]}
        where="local"
        busy={false}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onManual={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(t('layer.unavailable'));
    expect(container.querySelector('.spin, .checklist')).toBeNull();
  },
);

it.each(['hover', 'focus'])(
  'Undo expires after the remaining window when %s ends',
  async (pause) => {
    vi.useFakeTimers();
    function Example() {
      const [items, setItems] = useState<Toast[]>([
        {
          id: 1,
          text: 'Undoable',
          tone: 'ok',
          action: { label: 'Undo', undo: true, run: vi.fn() },
        },
        { id: 2, text: 'Plain', tone: 'ok' },
        { id: 3, text: 'Error', tone: 'error' },
      ]);
      return (
        <>
          <button id="outside">Outside</button>
          <Toasts
            items={items}
            dismiss={(id) => setItems((rows) => rows.filter((row) => row.id !== id))}
          />
        </>
      );
    }
    await render(<Example />);
    await act(async () => vi.advanceTimersByTime(4499));
    expect(container.querySelectorAll('.toast')).toHaveLength(3);
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelectorAll('.toast')).toHaveLength(2);
    const toast = container.querySelector('.toast')!;
    await act(async () => {
      if (pause === 'hover') toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      else toast.querySelector('button')!.focus();
    });
    await act(async () => vi.advanceTimersByTime(30000));
    expect(container.querySelectorAll('.toast')).toHaveLength(2);
    await act(async () => {
      if (pause === 'hover') toast.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      else container.querySelector<HTMLElement>('#outside')!.focus();
    });
    await act(async () => vi.advanceTimersByTime(5499));
    expect(container.querySelectorAll('.toast')).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelectorAll('.toast')).toHaveLength(1);
    expect(container.querySelector('.toast.error')).not.toBeNull();
  },
);

it.each(['body', 'dialog', 'aside', 'section'])(
  'toasts ignore overlapping %s focus and move only for a control',
  async (tag) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 800,
      width: 400,
      height: 800,
      toJSON: () => ({}),
    });
    await render(
      <>
        <button id="control">Control</button>
        <Toasts items={[{ id: 1, text: 'Error', tone: 'error' }]} dismiss={vi.fn()} />
      </>,
    );
    const region = container.querySelector<HTMLElement>('.toasts')!;
    const target = tag === 'body' ? document.body : document.createElement(tag);
    if (tag !== 'body') {
      target.tabIndex = -1;
      container.append(target);
    }
    await act(async () => container.querySelector<HTMLElement>('#control')!.focus());
    expect(region.style.top).toBe('12px');
    await act(async () => {
      if (tag === 'body') container.querySelector<HTMLElement>('#control')!.blur();
      else target.focus();
      target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(region.style.top).toBe('');
    expect(region.style.bottom).toBe('');
    if (tag !== 'body') target.remove();
  },
);

it('uses the current subject for focus return and falls back when its row is removed', async () => {
  function Example({ removeRow = false }: { removeRow?: boolean }) {
    const [subject, setSubject] = useState('first');
    const [open, setOpen] = useState(false);
    return (
      <>
        <button id="first" onClick={() => setOpen(true)}>
          First
        </button>
        {!removeRow && <button id="second">Second</button>}
        {open && (
          <ContextPanel
            labelledBy="subject"
            close={() => setOpen(false)}
            returnFocus={() => document.getElementById(subject)}
          >
            <h2 id="subject">{subject}</h2>
            <button id="step" onClick={() => setSubject('second')}>
              Next
            </button>
          </ContextPanel>
        )}
      </>
    );
  }
  for (const removeRow of [false, true]) {
    await render(<Example key={String(removeRow)} removeRow={removeRow} />);
    container.querySelector<HTMLElement>('#first')!.focus();
    await click('#first');
    await click('#step');
    await key('Escape');
    expect(document.activeElement?.id).toBe(removeRow ? 'first' : 'second');
  }
});

it.each(['plain', 'hover', 'focus'])(
  'toast lifetime and %s pause survive moving into and out of a modal',
  async (pause) => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const items: Toast[] = [
      {
        id: 1,
        text: 'Notice',
        tone: 'ok',
        ...(pause === 'plain' ? {} : { action: { label: 'Undo', undo: true, run: vi.fn() } }),
      },
    ];
    const tree = (modal: boolean) => (
      <>
        {modal && (
          <FocusView labelledBy="form-title" close={() => {}}>
            <h2 id="form-title">Form</h2>
          </FocusView>
        )}
        <Toasts items={items} dismiss={dismiss} />
      </>
    );
    await render(tree(false));
    await act(async () => vi.advanceTimersByTime(2000));
    const toast = container.querySelector('.toast')!;
    if (pause !== 'plain')
      await act(async () =>
        toast.dispatchEvent(
          pause === 'hover'
            ? new MouseEvent('mouseover', { bubbles: true })
            : new FocusEvent('focusin', { bubbles: true }),
        ),
      );
    await render(tree(true));
    expect(container.querySelector('dialog .toast')).toBe(toast);
    await act(async () => vi.advanceTimersByTime(pause === 'plain' ? 2000 : 20000));
    expect(dismiss).not.toHaveBeenCalled();
    await render(tree(false));
    expect(container.querySelector('.toast')).toBe(toast);
    if (pause !== 'plain')
      await act(async () =>
        toast.dispatchEvent(
          pause === 'hover'
            ? new MouseEvent('mouseout', { bubbles: true })
            : new FocusEvent('focusout', { bubbles: true }),
        ),
      );
    await act(async () => vi.advanceTimersByTime(pause === 'plain' ? 499 : 7999));
    expect(dismiss).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(1);
  },
);
