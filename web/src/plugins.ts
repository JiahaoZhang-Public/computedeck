import { useSyncExternalStore } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import plugins from 'computedeck:plugins';
import type { Request } from './api';
import type { Locale } from './i18n';
import type { Health, Tool } from './types';

/** What the host passes to every plugin component. */
export interface PluginProps {
  request: Request;
  demo: boolean;
  remote: boolean;
  locale: Locale;
  page: string;
  health: Health | null;
  navigate: (page: string) => void;
}

export type Label = string | Partial<Record<Locale, string>>;

export interface PluginPage {
  id: string;
  label: Label;
  icon: LucideIcon;
  render: (props: PluginProps) => ReactNode;
}

/**
 * Optional UI contributed at build time. Point the COMPUTEDECK_WEB_PLUGINS environment
 * variable at a module whose default export is a WebPlugin[] when building the web app.
 */
export interface WebPlugin {
  id: string;
  /** The server plugin this UI belongs to; while that plugin is off the UI is hidden. */
  requires?: string;
  /** Extra pages, listed under "Tools" in the sidebar. */
  pages?: PluginPage[];
  /** Rendered beside the 24-hour chart at the bottom of the Overview. */
  overview?: ComponentType<PluginProps>;
  /** Rendered on the settings page below the data sources. */
  settings?: ComponentType<PluginProps>;
  /** Rendered above every page; return null when there is nothing to say. */
  banner?: ComponentType<PluginProps>;
}

export function labelText(label: Label, locale: Locale) {
  return typeof label === 'string'
    ? label
    : (label[locale] ?? label.en ?? Object.values(label)[0] ?? '');
}

/** Plugins compiled into this build (COMPUTEDECK_WEB_PLUGINS). */
export const buildTimePlugins: WebPlugin[] = plugins;

// Plugins whose bundle registered itself at run time (ComputeDeck.register).
let snapshot: WebPlugin[] = buildTimePlugins;
const listeners = new Set<() => void>();

export function registerWebPlugin(plugin: WebPlugin) {
  if (!plugin || typeof plugin.id !== 'string' || snapshot.some((item) => item.id === plugin.id))
    return;
  snapshot = [...snapshot, plugin];
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every web plugin known so far: built in, then registered at run time. */
export function useWebPlugins(): WebPlugin[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Plugins whose server plugin, if they name one, is switched on. */
export function activePlugins(plugins: WebPlugin[], tools: Tool[]): WebPlugin[] {
  return plugins.filter(
    (plugin) =>
      !plugin.requires || tools.some((tool) => tool.id === plugin.requires && tool.enabled),
  );
}

export function pagesOf(plugins: WebPlugin[]): PluginPage[] {
  return plugins.flatMap((plugin) => plugin.pages ?? []);
}

const loaded = new Set<string>();

/** Add the bundle (index.js, and index.css when present) of each plugin package once. */
export function loadBundles(urls: string[]) {
  for (const base of urls) {
    if (loaded.has(base)) continue;
    loaded.add(base);
    const script = document.createElement('script');
    script.src = `${base}index.js`;
    script.async = true;
    document.head.appendChild(script);
    void fetch(`${base}index.css`, { method: 'HEAD', credentials: 'omit' })
      .then((response) => {
        if (!response.ok) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${base}index.css`;
        document.head.appendChild(link);
      })
      .catch(() => undefined);
  }
}
