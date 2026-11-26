import { createContext, useContext } from 'react';
import { t } from './i18n';

export type CopyKind = 'command' | 'link' | 'text';
export type CopyOptions = { kind?: CopyKind; message?: string };
export type Copy = (text: string, options?: CopyOptions) => Promise<void>;

/**
 * The Clipboard API exists only on https and localhost. A service opened over plain http from
 * another machine falls back to copying a selection, which works there too.
 */
async function write(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // No Clipboard API, or it refused: try the selection below.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  const focused = document.activeElement;
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy refused');
  } finally {
    area.remove();
    if (focused instanceof HTMLElement) focused.focus();
  }
}

/** One clipboard path and one announcement for buttons, panels and keyboard actions. */
export function createCopy(
  example: boolean,
  notify: (text: string, tone?: 'ok' | 'error') => void,
): Copy {
  return async (text, { kind = 'text', message } = {}) => {
    try {
      await write(example && kind === 'command' ? `${text}\n# example data` : text);
      notify(message ?? t('display.copied'));
    } catch {
      notify(t('toast.clipboard'), 'error');
    }
  };
}
export const CopyContext = createContext<Copy | null>(null);
export function useCopy() {
  return useContext(CopyContext);
}
