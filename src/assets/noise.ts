/**
 * Deterministic 3D noise for sculpt surface detail (bark fibres, flesh wrinkles, plate wear, crystal facets).
 * Gradient noise on a hashed lattice plus cellular (Worley) distances; plain numbers, no allocation per call.
 */

const PERM = new Uint8Array(512);
{
  let s = 1337;
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

const G = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1];
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (h: number, x: number, y: number, z: number) => {
  const g = (h % 12) * 3;
  return G[g] * x + G[g + 1] * y + G[g + 2] * z;
};

/** Perlin gradient noise, roughly in [-1, 1]. */
export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  x -= X; y -= Y; z -= Z;
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const u = fade(x), v = fade(y), w = fade(z);
  const A = PERM[xi] + yi, AA = PERM[A] + zi, AB = PERM[A + 1] + zi;
  const B = PERM[xi + 1] + yi, BA = PERM[B] + zi, BB = PERM[B + 1] + zi;
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(grad(PERM[AA], x, y, z), grad(PERM[BA], x - 1, y, z), u), l(grad(PERM[AB], x, y - 1, z), grad(PERM[BB], x - 1, y - 1, z), u), v),
    l(l(grad(PERM[AA + 1], x, y, z - 1), grad(PERM[BA + 1], x - 1, y, z - 1), u), l(grad(PERM[AB + 1], x, y - 1, z - 1), grad(PERM[BB + 1], x - 1, y - 1, z - 1), u), v),
    w,
  );
}

/** Fractal sum of `oct` octaves. */
export function fbm(x: number, y: number, z: number, oct = 4, lac = 2.03, gain = 0.5): number {
  let s = 0, a = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += noise3(x, y, z) * a;
    n += a;
    x *= lac; y *= lac; z *= lac;
    a *= gain;
  }
  return s / n;
}

/** Ridged multifractal in [0, 1]: sharp creases (veins, bark ridges). */
export function ridged(x: number, y: number, z: number, oct = 4): number {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    const r = 1 - Math.abs(noise3(x, y, z));
    s += r * r * a;
    n += a;
    x *= 2.1; y *= 2.1; z *= 2.1;
    a *= 0.5;
  }
  return s / n;
}

const hash3 = (i: number, j: number, k: number, c: number) => {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647 + c * 974634411) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Worley cellular noise: returns F1 and F2 distances (in cell units) via `out`. */
export function cellular(x: number, y: number, z: number, out: { f1: number; f2: number }) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  let f1 = 9, f2 = 9;
  for (let k = -1; k <= 1; k++) {
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = X + i, cy = Y + j, cz = Z + k;
        const dx = cx + hash3(cx, cy, cz, 0) - x, dy = cy + hash3(cx, cy, cz, 1) - y, dz = cz + hash3(cx, cy, cz, 2) - z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
    }
  }
  out.f1 = f1;
  out.f2 = f2;
  return out;
}
