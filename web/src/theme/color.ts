// OKLCH -> linear sRGB (CSS Color 4 matrices), WCAG 2 relative luminance,
// and Euclidean distance in OKLab. No gamut mapping: clipping is a test failure.
export function linearRGB([l, c, h]: number[]) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}
export function luminance(color: number[]) {
  const [r, g, b] = linearRGB(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function compositeRGB(foreground: number[], backgroundRGB: number[]) {
  const alpha = foreground[3] ?? 1;
  const encode = (value: number) =>
    value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  const decode = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const under = backgroundRGB.map(encode);
  return linearRGB(foreground).map((value, i) =>
    decode(encode(value) * alpha + under[i] * (1 - alpha)),
  );
}
export function contrast(foreground: number[], background: number[], underlay?: number[]) {
  const backgroundRGB = underlay
    ? compositeRGB(background, linearRGB(underlay))
    : linearRGB(background);
  const [r, g, b] = backgroundRGB;
  const bg = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const blended = compositeRGB(foreground, backgroundRGB);
  const fg = 0.2126 * blended[0] + 0.7152 * blended[1] + 0.0722 * blended[2];
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

export function deltaE(first: number[], second: number[]) {
  const lab = ([l, c, h]: number[]) => [
    l,
    c * Math.cos((h * Math.PI) / 180),
    c * Math.sin((h * Math.PI) / 180),
  ];
  const a = lab(first);
  const b = lab(second);
  return Math.hypot(...a.map((value, index) => value - b[index]));
}
export function cssColor([l, c, h, alpha]: number[]) {
  return `oklch(${l} ${c} ${h}${alpha === undefined ? '' : ` / ${alpha}`})`;
}

// APCA 0.0.98G-4g, advisory only (never an acceptance threshold).
// The signed Lc preserves polarity: positive is dark text on a light background.
export function apca(foreground: number[], background: number[]) {
  const Y = (color: number[]) => {
    const rgb = linearRGB(color).map((channel) => {
      const value = Math.max(0, channel);
      return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    });
    const y = 0.2126729 * rgb[0] ** 2.4 + 0.7151522 * rgb[1] ** 2.4 + 0.072175 * rgb[2] ** 2.4;
    return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
  };
  const text = Y(foreground);
  const bg = Y(background);
  if (Math.abs(bg - text) < 0.0005) return 0;
  if (bg > text) {
    const sapc = (bg ** 0.56 - text ** 0.57) * 1.14;
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
  }
  const sapc = (bg ** 0.65 - text ** 0.62) * 1.14;
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100;
}
