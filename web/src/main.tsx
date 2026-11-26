import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installHost } from './host';
import { loadLocale, startupLocale } from './i18n';
import { initializeAppearance } from './theme/preferences';
import 'computedeck:tokens';
import './theme/components.css';
import './theme/tokens-compat.css';
import './theme/compat.css';
import './styles.css';
import './layers/layers.css';

initializeAppearance();

// Plugin bundles loaded later find the host API on window.ComputeDeck.
installHost();

// Overlap the first dictionary request with React startup; the gate handles errors/retry.
void loadLocale(startupLocale()).catch(() => {});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
