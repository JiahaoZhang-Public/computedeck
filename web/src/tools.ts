import type { LucideIcon } from 'lucide-react';
import { BellRing, MessagesSquare } from 'lucide-react';
import type { MessageKey } from './i18n';
import type { CorePage } from './routes';
import type { Tool } from './types';

/** A page of a tool shipped with the core; listed while its server plugin is on. */
export interface ToolPage {
  id: CorePage;
  plugin: string;
  label: MessageKey;
  icon: LucideIcon;
}

export const toolPages: ToolPage[] = [
  { id: 'notify', plugin: 'notify', label: 'nav.notify', icon: BellRing },
  { id: 'chat', plugin: 'chat', label: 'nav.chat', icon: MessagesSquare },
];

export function enabledToolPages(tools: Tool[]): ToolPage[] {
  return toolPages.filter((page) => tools.some((tool) => tool.id === page.plugin && tool.enabled));
}
