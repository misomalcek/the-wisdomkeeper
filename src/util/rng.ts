import { lerp } from './math';

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small, fast, seedable PRNG (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number) {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p: number) {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
  /** Approximate standard normal. */
  gauss() {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
  fork(label: string) {
    return new Rng((this.s ^ hashString(label)) >>> 0);
  }
}

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export type Noise2D = (x: number, y: number) => number;

/** Seeded 2D gradient noise, roughly in [-1, 1]. */
export function makeNoise2D(seed: number): Noise2D {
  const rng = new Rng(seed);
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const h = p[p[ix & 255] + (iy & 255)] & 7;
    return GRAD[h][0] * dx + GRAD[h][1] * dy;
  };
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = fade(xf);
    const v = fade(yf);
    return (
      lerp(
        lerp(g(xi, yi, xf, yf), g(xi + 1, yi, xf - 1, yf), u),
        lerp(g(xi, yi + 1, xf, yf - 1), g(xi + 1, yi + 1, xf - 1, yf - 1), u),
        v,
      ) * 1.41
    );
  };
}

export function fbm(n: Noise2D, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += n(x, y) * amp;
    norm += amp;
    x *= lacunarity;
    y *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

/** Value and analytic gradient of a 2D noise sample: [v, dv/dx, dv/dy]. */
export type NoiseD = Float64Array;
export type Noise2DD = (x: number, y: number, out: NoiseD) => NoiseD;
const dfade = (t: number) => 30 * t * t * (t - 1) * (t - 1);

/**
 * The same seeded gradient noise as `makeNoise2D` (identical values for the same seed) with its exact gradient, so
 * fields built from it know their own slope without extra samples (erosion filters, flow directions).
 */
export function makeNoise2DD(seed: number): Noise2DD {
  const rng = new Rng(seed);
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  const gi = (ix: number, iy: number) => p[p[ix & 255] + (iy & 255)] & 7;
  return (x, y, out) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = fade(xf);
    const v = fade(yf);
    const du = dfade(xf);
    const dv = dfade(yf);
    const g00 = GRAD[gi(xi, yi)], g10 = GRAD[gi(xi + 1, yi)], g01 = GRAD[gi(xi, yi + 1)], g11 = GRAD[gi(xi + 1, yi + 1)];
    const a = g00[0] * xf + g00[1] * yf;
    const b = g10[0] * (xf - 1) + g10[1] * yf;
    const c = g01[0] * xf + g01[1] * (yf - 1);
    const d = g11[0] * (xf - 1) + g11[1] * (yf - 1);
    const k = a - b - c + d;
    out[0] = (a + (b - a) * u + (c - a) * v + k * u * v) * 1.41;
    out[1] = (g00[0] + (g10[0] - g00[0]) * u + (g01[0] - g00[0]) * v + (g00[0] - g10[0] - g01[0] + g11[0]) * u * v + du * (b - a + k * v)) * 1.41;
    out[2] = (g00[1] + (g10[1] - g00[1]) * u + (g01[1] - g00[1]) * v + (g00[1] - g10[1] - g01[1] + g11[1]) * u * v + dv * (c - a + k * u)) * 1.41;
    return out;
  };
}
