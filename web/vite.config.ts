import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Optional build-time UI plugins: a module whose default export is a WebPlugin[].
const plugins = process.env.COMPUTEDECK_WEB_PLUGINS
  ? path.resolve(process.env.COMPUTEDECK_WEB_PLUGINS)
  : fileURLToPath(new URL('./src/no-plugins.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { 'computedeck:plugins': plugins },
    dedupe: ['react', 'react-dom', 'lucide-react'],
  },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8710' } },
});
