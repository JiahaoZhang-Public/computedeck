import { createContext, useContext } from 'react';
import { t } from './i18n';

export type CopyKind = 'command' | 'link' | 'text';
export type CopyOptions = { kind?: CopyKind; message?: string };
export type Copy = (text: string, options?: CopyOptions) => Promise<void>;

/** One clipboard path and one announcement for buttons, panels and keyboard actions. */
export function createCopy(
  example: boolean,
  notify: (text: string, tone?: 'ok' | 'error') => void,
): Copy {
  return async (text, { kind = 'text', message } = {}) => {
    try {
      await navigator.clipboard.writeText(
        example && kind === 'command' ? `${text}\n# example data` : text,
      );
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
