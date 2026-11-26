// Source of truth for generated CSS. Values are [L, C, h, optional alpha].
export const tokens: Record<string, { light: number[]; dark: number[] }> = {
  'bg-canvas': {
    light: [1.0, 0.0, 0.0],
    dark: [0.245, 0.0, 0.0],
  },
  'bg-surface': {
    light: [1.0, 0.0, 0.0],
    dark: [0.245, 0.0, 0.0],
  },
  'bg-sunken': {
    light: [0.965, 0.0, 0.0],
    dark: [0.2, 0.0, 0.0],
  },
  'bg-raised': {
    light: [1.0, 0.0, 0.0],
    dark: [0.275, 0.0, 0.0],
  },
  'bg-overlay': {
    light: [1.0, 0.0, 0.0],
    dark: [0.285, 0.0, 0.0],
  },
  'bg-hover': {
    light: [0.97, 0.001, 260.0],
    dark: [0.285, 0.0, 0.0],
  },
  'bg-selected': {
    light: [0.94, 0.002, 260.0],
    dark: [0.32, 0.0, 0.0],
  },
  'fg-default': {
    light: [0.2, 0.004, 260.0],
    dark: [0.955, 0.002, 260.0],
  },
  'fg-muted': {
    light: [0.47, 0.006, 260.0],
    dark: [0.78, 0.004, 260.0],
  },
  'fg-subtle': {
    light: [0.5, 0.006, 260.0],
    dark: [0.74, 0.004, 260.0],
  },
  'fg-on-ink': {
    light: [1.0, 0.0, 0.0],
    dark: [0.17, 0.003, 260.0],
  },
  ink: {
    light: [0.2, 0.004, 260.0],
    dark: [0.955, 0.002, 260.0],
  },
  'border-muted': {
    light: [0.93, 0.002, 260.0],
    dark: [0.3, 0.0, 0.0],
  },
  'border-default': {
    light: [0.9, 0.003, 260.0],
    dark: [0.34, 0.0, 0.0],
  },
  'border-strong': {
    light: [0.62, 0.008, 260.0],
    dark: [0.62, 0.0, 0.0],
  },
  'status-ok-fg': {
    light: [0.5, 0.13, 150.0],
    dark: [0.78, 0.14, 150.0],
  },
  'status-ok-bg': {
    light: [0.965, 0.025, 150.0],
    dark: [0.315, 0.04, 150.0],
  },
  'status-wait-fg': {
    light: [0.5, 0.15, 255.0],
    dark: [0.79, 0.1, 255.0],
  },
  'status-wait-bg': {
    light: [0.965, 0.014, 255.0],
    dark: [0.315, 0.045, 255.0],
  },
  'status-warn-fg': {
    light: [0.52, 0.115, 65.0],
    dark: [0.82, 0.13, 80.0],
  },
  'status-warn-bg': {
    light: [0.97, 0.028, 85.0],
    dark: [0.325, 0.04, 75.0],
  },
  // Chroma .13 clips blue by -0.00002774 in linear sRGB; .1299 stays in gamut.
  'status-warn-shape': {
    light: [0.6, 0.1299, 70.0],
    dark: [0.82, 0.13, 80.0],
  },
  'status-error-fg': {
    light: [0.52, 0.185, 27.0],
    dark: [0.78, 0.115, 25.0],
  },
  'status-error-bg': {
    light: [0.965, 0.016, 25.0],
    dark: [0.325, 0.055, 25.0],
  },
  'status-unknown-fg': {
    light: [0.5, 0.01, 260.0],
    dark: [0.74, 0.01, 260.0],
  },
  'status-unknown-bg': {
    light: [0.955, 0.003, 260.0],
    dark: [0.295, 0.005, 260.0],
  },
  'id-1': {
    light: [0.56, 0.09, 195.0],
    dark: [0.75, 0.085, 195.0],
  },
  'id-2': {
    light: [0.52, 0.13, 288.0],
    dark: [0.72, 0.12, 290.0],
  },
  'id-3': {
    light: [0.57, 0.15, 350.0],
    dark: [0.75, 0.12, 345.0],
  },
  'id-4': {
    light: [0.56, 0.095, 112.0],
    dark: [0.76, 0.095, 112.0],
  },
  'id-5': {
    light: [0.46, 0.07, 42.0],
    dark: [0.66, 0.07, 42.0],
  },
  'id-6': {
    light: [0.42, 0.14, 330.0],
    dark: [0.62, 0.126, 330.0],
  },
  'id-tint-1': {
    light: [0.955, 0.02, 195.0],
    dark: [0.315, 0.032, 195.0],
  },
  'id-tint-2': {
    light: [0.955, 0.02, 288.0],
    dark: [0.315, 0.032, 288.0],
  },
  'id-tint-3': {
    light: [0.955, 0.02, 350.0],
    dark: [0.315, 0.032, 350.0],
  },
  'id-tint-4': {
    light: [0.955, 0.02, 112.0],
    dark: [0.315, 0.032, 112.0],
  },
  'id-tint-5': {
    light: [0.955, 0.02, 42.0],
    dark: [0.315, 0.032, 42.0],
  },
  'id-tint-6': {
    light: [0.955, 0.02, 330.0],
    dark: [0.315, 0.032, 330.0],
  },
  hatch: {
    light: [0.51, 0.01, 260.0, 0.55],
    dark: [0.74, 0.008, 260.0, 0.45],
  },
  'hatch-strong': {
    light: [0.32, 0.01, 260.0, 0.72],
    dark: [0.84, 0.005, 260.0, 0.52],
  },
  'grid-others': {
    light: [0.66, 0.006, 260.0],
    dark: [0.58, 0.007, 260.0],
  },
  'chart-bar': {
    light: [0.215, 0.01, 260.0, 0.62],
    dark: [0.955, 0.003, 260.0, 0.6],
  },
  'chart-area': {
    light: [0.215, 0.01, 260.0, 0.07],
    dark: [0.955, 0.003, 260.0, 0.1],
  },
  scrim: {
    light: [0.2, 0.01, 260.0, 0.32],
    dark: [0.0, 0.0, 0.0, 0.56],
  },
  'status-ok-shape': {
    light: [0.5, 0.13, 150.0],
    dark: [0.78, 0.14, 150.0],
  },
  'status-wait-shape': {
    light: [0.5, 0.15, 255.0],
    dark: [0.79, 0.1, 255.0],
  },
  'status-error-shape': {
    light: [0.52, 0.185, 27.0],
    dark: [0.78, 0.115, 25.0],
  },
  'status-unknown-shape': {
    light: [0.5, 0.01, 260.0],
    dark: [0.74, 0.01, 260.0],
  },
  'status-off-fg': {
    light: [0.5, 0.01, 260.0],
    dark: [0.74, 0.01, 260.0],
  },
  'status-off-bg': {
    light: [0.955, 0.003, 260.0],
    dark: [0.24, 0.005, 260.0],
  },
  'status-off-shape': {
    light: [0.5, 0.01, 260.0],
    dark: [0.74, 0.01, 260.0],
  },
  'focus-ring': {
    light: [0.2, 0.004, 260.0],
    dark: [0.955, 0.002, 260.0],
  },
  // Monochrome: the accent names stay for plugins, with ink and neutral values.
  'accent-fill': {
    light: [0.2, 0.004, 260.0],
    dark: [0.955, 0.002, 260.0],
  },
  'fg-on-accent': {
    light: [1.0, 0.0, 0.0],
    dark: [0.17, 0.003, 260.0],
  },
  'accent-fg': {
    light: [0.2, 0.004, 260.0],
    dark: [0.955, 0.002, 260.0],
  },
  'accent-bg': {
    light: [0.94, 0.002, 260.0],
    dark: [0.255, 0.004, 260.0],
  },
  'chart-line': {
    light: [0.215, 0.01, 260.0],
    dark: [0.955, 0.003, 260.0],
  },
  'chart-grid': {
    light: [0.922, 0.004, 260.0],
    dark: [0.255, 0.006, 260.0],
  },
  'hatch-edge': {
    light: [0.215, 0.01, 260.0],
    dark: [0.955, 0.003, 260.0],
  },
  'brand-top': {
    light: [0.58756353, 0.215203306, 273.850162004],
    dark: [0.58756353, 0.215203306, 273.850162004],
  },
  'brand-middle': {
    light: [0.709592773, 0.146892894, 274.744506827],
    dark: [0.709592773, 0.146892894, 274.744506827],
  },
  'brand-base': {
    light: [0.375200593, 0.126635143, 271.039070246],
    dark: [0.485477273, 0.178487547, 270.972517838],
  },
};

export const contrastMore: Record<string, string> = {
  'fg-muted': 'fg-default',
  'fg-subtle': 'fg-default',
  'border-muted': 'border-strong',
  'border-default': 'border-strong',
  'chart-grid': 'border-strong',
  hatch: 'hatch-strong',
};
