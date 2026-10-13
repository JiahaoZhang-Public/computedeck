import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installHost } from './host';
import './styles.css';

// Plugin bundles loaded later find the host API on window.ComputeDeck.
installHost();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
