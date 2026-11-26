import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import compatMap from './src/theme/compat-map.json';
import { deprecatedPluginTokens } from './src/theme/lint';

// Optional build-time UI plugins: a module whose default export is a WebPlugin[].
const plugins = process.env.COMPUTEDECK_WEB_PLUGINS
  ? path.resolve(process.env.COMPUTEDECK_WEB_PLUGINS)
  : fileURLToPath(new URL('./src/no-plugins.ts', import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'plugin-compat-map',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'tokens-compat.json',
          source: JSON.stringify(compatMap, null, 2) + '\n',
        });
      },
    },
    {
      name: 'deprecated-plugin-tokens',
      apply: 'serve',
      transform(code, id) {
        const used = deprecatedPluginTokens(
          code,
          id,
          fileURLToPath(new URL('./src', import.meta.url)),
        );
        if (used.length)
          this.warn(
            `${id}: legacy tokens remain supported; prefer semantic names: ${used.join(', ')}`,
          );
      },
    },
  ],
  define: {
    __TEST_PLUGIN_SLOTS__: JSON.stringify(process.env.COMPUTEDECK_TEST_PLUGIN_SLOTS === '1'),
  },
  test: { setupFiles: ['./src/test-locales.ts'] },
  resolve: {
    alias: {
      'computedeck:plugins': plugins,
      'computedeck:hello':
        process.env.COMPUTEDECK_HELLO_EXAMPLE ??
        fileURLToPath(new URL('./src/no-plugins.ts', import.meta.url)),
      'computedeck:tokens': fileURLToPath(
        new URL(
          process.env.COMPUTEDECK_FALLBACK_TOKENS === '1'
            ? './src/theme/tokens.fallback-only.css'
            : './src/theme/tokens.css',
          import.meta.url,
        ),
      ),
    },
    dedupe: ['react', 'react-dom', 'lucide-react'],
  },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8710' } },
});
