import { createElement, lazy } from 'react';
import type { FunctionComponent } from 'react';
import { LoadError } from './LoadState';

/** A failed import needs a fresh module request; resetting a React error boundary cannot retry it. */
export function lazyView<Props>(
  load: () => Promise<{ default: FunctionComponent<Props> }>,
  titleId?: string,
) {
  return lazy<FunctionComponent<Props>>(() =>
    load().catch(() => ({
      default: () => createElement(LoadError, { id: titleId }),
    })),
  );
}
