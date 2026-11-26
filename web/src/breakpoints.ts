/** C4 bands. Keep layers.css media queries in sync with these edges. */
export const breakpoints = { phone: 600, desktop: 1200 } as const;
export const phoneMedia = `(max-width: ${breakpoints.phone - 1}px)`;
export const desktopMedia = `(min-width: ${breakpoints.desktop}px)`;
