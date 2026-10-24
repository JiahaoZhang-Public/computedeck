/** Shared by inline StatusShape SVGs and the generated WEB_API 1 pill masks. */
export const shapes = {
  ok: '<circle cx="6" cy="6" r="4.8" fill="currentColor"/>',
  wait: '<circle cx="6" cy="6" r="4.1" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  warn: '<path d="M6 .9 11.3 10.7H.7Z" fill="currentColor"/>',
  error: '<path d="M6 .5 11.5 6 6 11.5.5 6Z" fill="currentColor"/>',
  unknown:
    '<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="4.4 2.2" transform="rotate(-20 6 6)"/>',
  off: '<rect x="1" y="1" width="10" height="10" rx=".5" fill="currentColor"/>',
} as const;
export type StatusKind = keyof typeof shapes;
export function shapeSvg(kind: StatusKind) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">${shapes[kind]}</svg>`;
}
