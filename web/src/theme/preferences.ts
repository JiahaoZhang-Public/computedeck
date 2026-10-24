export type Theme = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem('computedeck.theme');
    if (value === 'light' || value === 'dark') return value;
  } catch {
    /* Device storage may be blocked. */
  }
  return 'system';
}
export function readDensity(): Density {
  try {
    if (localStorage.getItem('computedeck.density') === 'compact') return 'compact';
  } catch {
    /* Device storage may be blocked. */
  }
  return 'comfortable';
}
export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem('computedeck.theme', theme);
  } catch {
    /* Keep the choice for this page even without storage. */
  }
}
export function saveDensity(density: Density) {
  document.documentElement.dataset.density = density;
  try {
    localStorage.setItem('computedeck.density', density);
  } catch {
    /* Keep the choice for this page even without storage. */
  }
}
export function initializeAppearance() {
  applyTheme(readTheme());
  document.documentElement.dataset.density = readDensity();
}
