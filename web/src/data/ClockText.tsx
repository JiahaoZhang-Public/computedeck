import { useClock } from '../ui/clock';
import type { ReactNode } from 'react';

/** Keep legacy age text ticking without rerendering the app or its rows. Adds no DOM. */
export function ClockText({ children }: { children: () => ReactNode }) {
  useClock();
  return children();
}
