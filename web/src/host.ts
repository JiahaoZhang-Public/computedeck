import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { api } from './api';
import { dateTime, relativeTime } from './domain';
import { routeHash } from './routes';
import { locale, localized } from './i18n';
import { registerWebPlugin } from './plugins';
import type { WebPlugin } from './plugins';
import { BrandMark, Chips, Empty, Meter, Panel, Stat, Status, Switch } from './ui';

/** The plugin web API version; a bundle written for a newer one is refused. */
export const WEB_API = 1;

/**
 * What a plugin bundle may use, on `window.ComputeDeck`. Bundles are built with React and
 * react/jsx-runtime as externals mapped to `ComputeDeck.React` and `ComputeDeck.jsxRuntime`,
 * so they share this page's React. See docs/plugins.md.
 */
export interface Host {
  api: number;
  React: typeof React;
  jsxRuntime: typeof jsxRuntime;
  components: {
    BrandMark: typeof BrandMark;
    Chips: typeof Chips;
    Empty: typeof Empty;
    Meter: typeof Meter;
    Panel: typeof Panel;
    Stat: typeof Stat;
    Status: typeof Status;
    Switch: typeof Switch;
  };
  request: typeof api;
  /** Times and links formatted the way the rest of the page does. */
  format: { relativeTime: typeof relativeTime; dateTime: typeof dateTime };
  routeHash: typeof routeHash;
  locale: typeof locale;
  localized: typeof localized;
  register: (plugin: WebPlugin & { api?: number }) => void;
}

declare global {
  interface Window {
    ComputeDeck?: Host;
  }
}

export function installHost() {
  window.ComputeDeck = {
    api: WEB_API,
    React,
    jsxRuntime,
    components: { BrandMark, Chips, Empty, Meter, Panel, Stat, Status, Switch },
    request: api,
    format: { relativeTime, dateTime },
    routeHash,
    locale,
    localized,
    register: (plugin) => {
      if ((plugin.api ?? 1) > WEB_API) {
        console.error(`Plugin ${plugin.id} needs web API ${plugin.api}; this app has ${WEB_API}.`);
        return;
      }
      registerWebPlugin(plugin);
    },
  };
}
