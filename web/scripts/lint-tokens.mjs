import { readFileSync, readdirSync } from 'node:fs';
import { checkFallback, componentColorViolations } from '../src/theme/lint.ts';
const root = new URL('../src/', import.meta.url);
checkFallback(readFileSync(new URL('theme/tokens.css', root), 'utf8'));
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) check(url);
    else if (
      /\.(css|tsx)$/.test(entry.name) &&
      !entry.name.includes('.test.') &&
      !['tokens.css', 'tokens.fallback-only.css'].includes(entry.name)
    ) {
      const violations = componentColorViolations(readFileSync(url, 'utf8'));
      if (violations.length) throw new Error(`${url.pathname}: ${violations.join(', ')}`);
    }
  }
}
check(root);
console.log('Token lint: fallback contexts, parity and component colours passed');
