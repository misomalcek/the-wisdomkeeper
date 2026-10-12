/**
 * Perceptual colour (Ottosson's OKLab / OKLCH) for procedural palettes, on the CPU (palette generation, per-vertex
 * biome tints in the chunk workers) and in TSL (`mixOklab` for blends in shaders). Inputs and outputs are linear sRGB.
 * The TSL twins live in `colorNodes.ts` (kept apart so the chunk workers do not bundle three.js).
 * Interpolating in OKLab keeps lightness and saturation even across a blend: no muddy grey midpoints between a cyan
 * meadow and a magenta blight, no brightness dip at biome borders.
 */

export type RGB = [number, number, number];

export function linearToOklab(r: number, g: number, b: number, out: RGB = [0, 0, 0]): RGB {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return out;
}

export function oklabToLinear(L: number, a: number, b: number, out: RGB = [0, 0, 0]): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return out;
}

/** OKLCH (L 0..1, C ≈ 0..0.37, h degrees) → linear sRGB, chroma reduced until it fits the gamut. */
export function oklch(L: number, C: number, h: number, out: RGB = [0, 0, 0]): RGB {
  const hr = (h * Math.PI) / 180;
  let c = C;
  for (let i = 0; i < 24; i++) {
    oklabToLinear(L, c * Math.cos(hr), c * Math.sin(hr), out);
    if (out[0] >= -1e-4 && out[1] >= -1e-4 && out[2] >= -1e-4 && out[0] <= 1.0001 && out[1] <= 1.0001 && out[2] <= 1.0001) break;
    c *= 0.9;
  }
  out[0] = Math.min(1, Math.max(0, out[0]));
  out[1] = Math.min(1, Math.max(0, out[1]));
  out[2] = Math.min(1, Math.max(0, out[2]));
  return out;
}

export function toOklch(r: number, g: number, b: number): [number, number, number] {
  const [L, a, bb] = linearToOklab(r, g, b);
  return [L, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360];
}

const _a: RGB = [0, 0, 0];
const _b: RGB = [0, 0, 0];
/** Blend two linear colours in OKLab. */
export function mixOklab(x: RGB, y: RGB, t: number, out: RGB = [0, 0, 0]): RGB {
  linearToOklab(x[0], x[1], x[2], _a);
  linearToOklab(y[0], y[1], y[2], _b);
  return oklabToLinear(_a[0] + (_b[0] - _a[0]) * t, _a[1] + (_b[1] - _a[1]) * t, _a[2] + (_b[2] - _a[2]) * t, out);
}

/** sRGB hex → linear RGB triple. */
export function hexLinear(hex: number): RGB {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
}

/** Quilez cosine palette a + b·cos(2π(c·t + d)) (all linear RGB triples). */
export function cosinePalette(t: number, a: RGB, b: RGB, c: RGB, d: RGB, out: RGB = [0, 0, 0]): RGB {
  for (let i = 0; i < 3; i++) out[i] = a[i] + b[i] * Math.cos(2 * Math.PI * (c[i] * t + d[i]));
  return out;
}
