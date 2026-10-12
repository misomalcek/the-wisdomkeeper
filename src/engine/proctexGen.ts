/**
 * Pure generators for the procedural surface textures (engine/proctex): periodic noise and the ground, stone and
 * bark recipes. No three.js here so it runs in the texture worker, in tests and on the main thread alike.
 */

// ---------------------------------------------------------------------------------------------
// Periodic noise (period P lattice cells on the tile)
// ---------------------------------------------------------------------------------------------

let SEED = 1;
const hash2 = (x: number, y: number) => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ SEED;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const wrap = (i: number, p: number) => ((i % p) + p) % p;
const fade = (t: number) => t * t * (3 - 2 * t);

function vnoise(x: number, y: number, px: number, py = px) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const x0 = wrap(ix, px), x1 = wrap(ix + 1, px), y0 = wrap(iy, py), y1 = wrap(iy + 1, py);
  const a = hash2(x0, y0), b = hash2(x1, y0), c = hash2(x0, y1), d = hash2(x1, y1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Periodic fBm in [0,1): the tile holds `p` cells at the first octave. */
function fbm(u: number, v: number, p: number, oct = 5, py = p) {
  let s = 0, a = 0.5, n = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    s += vnoise(u * p * f, v * py * f, p * f, py * f) * a;
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return s / n;
}

/** Periodic Worley: F1, F2 and the winning cell's random id, on a p×py grid. */
const _w = { f1: 0, f2: 0, id: 0 };
function worley(u: number, v: number, p: number, py = p, jitter = 0.85) {
  const x = u * p, y = v * py;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = wrap(ix + i, p), cy = wrap(iy + j, py);
      const fx = ix + i + 0.5 + (hash2(cx, cy) - 0.5) * jitter;
      const fy = iy + j + 0.5 + (hash2(cy + 917, cx + 311) - 0.5) * jitter;
      const d = Math.hypot(fx - x, fy - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(cx + 71, cy + 13);
      } else if (d < f2) f2 = d;
    }
  }
  _w.f1 = f1;
  _w.f2 = f2;
  _w.id = id;
  return _w;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

type Gen = (u: number, v: number, out: number[]) => void;

function fill(data: Uint8Array, S: number, gen: Gen) {
  const o = [0, 0, 0, 0];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      gen(x / S, y / S, o);
      const i = (y * S + x) * 4;
      data[i] = clamp01(o[0]) * 255;
      data[i + 1] = clamp01(o[1]) * 255;
      data[i + 2] = clamp01(o[2]) * 255;
      data[i + 3] = clamp01(o[3]) * 255;
    }
  }
}

/** Cracked soil with pebbles and moss, styled per seed (crack scale, pebble size, moss coverage). */
function groundGen(r: () => number): Gen {
  const crackCells = 4 + Math.floor(r() * 4);
  const pebbleCells = 18 + Math.floor(r() * 14);
  const moss = 0.42 + r() * 0.16;
  return (u, v, o) => {
    const warp = fbm(u, v, 4, 3) - 0.5;
    const c = worley(u + warp * 0.06, v - warp * 0.06, crackCells);
    const crackMask = sstep(0.35, 0.6, fbm(u + 0.31, v + 0.17, 3, 3));
    o[0] = sstep(0.07, 0.0, c.f2 - c.f1) * (0.4 + 0.6 * crackMask);
    const p = worley(u, v, pebbleCells, pebbleCells, 1);
    const pebMask = sstep(0.45, 0.62, fbm(u + 0.7, v + 0.2, 5, 3));
    o[1] = Math.pow(clamp01(1 - p.f1 * 1.7), 0.6) * pebMask * (0.6 + 0.4 * p.id);
    o[2] = fbm(u, v, 8, 6);
    o[3] = sstep(moss, moss + 0.18, fbm(u + warp * 0.2, v, 5, 5));
  };
}

/** Coursed ashlar: rows of blocks of jittered width, chipped arrises, fissures and lichen. */
function stoneGen(r: () => number): Gen {
  const rows = 6 + Math.floor(r() * 3);
  return (u, v, o) => {
    const ry = v * rows;
    const row = Math.floor(ry);
    const fy = ry - row;
    const cols = 3 + Math.floor(hash2(row, 7) * 3);
    const off = hash2(row, 11);
    const rx = (u + off) * cols;
    const col = Math.floor(rx);
    const fx = rx - col;
    const edge = Math.min(fx, 1 - fx, (fy * cols) / rows, ((1 - fy) * cols) / rows);
    const chip = fbm(u, v, 16, 3) * 0.06;
    o[0] = sstep(0.05 + chip, 0.015, edge);
    o[1] = clamp01(0.35 + hash2(wrap(col, cols) + row * 13, row) * 0.4 + (fbm(u, v, 24, 3) - 0.5) * 0.5);
    const c = worley(u, v, 5);
    o[2] = sstep(0.05, 0.0, c.f2 - c.f1) * sstep(0.5, 0.65, fbm(u + 0.4, v, 3, 3));
    o[3] = sstep(0.55, 0.75, fbm(u + 0.1, v + 0.9, 6, 4));
  };
}

/** Bark: long fibres, furrowed plates, moss. U runs around the trunk, V along it. */
function barkGen(r: () => number): Gen {
  const plates = 5 + Math.floor(r() * 4);
  return (u, v, o) => {
    const warp = fbm(u, v, 3, 2) - 0.5;
    o[0] = Math.pow(1 - Math.abs(fbm(u + warp * 0.1, v, 48, 2, 3) * 2 - 1), 3);
    const c = worley(u + warp * 0.05, v, plates, Math.max(2, Math.round(plates / 2.5)));
    o[1] = sstep(0.18, 0.02, c.f2 - c.f1);
    o[2] = fbm(u, v, 8, 5, 4);
    o[3] = sstep(0.5, 0.7, fbm(u, v + warp * 0.2, 4, 4, 2));
  };
}

export interface SurfaceData {
  size: number;
  ground: Uint8Array;
  stone: Uint8Array;
  bark: Uint8Array;
}

/** Generate the three surface textures for a world seed. */
export function generateSurfaces(seed: number, size: number): SurfaceData {
  let s = seed >>> 0 || 1;
  const r = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  SEED = seed | 0;
  const out = { size, ground: new Uint8Array(size * size * 4), stone: new Uint8Array(size * size * 4), bark: new Uint8Array(size * size * 4) };
  fill(out.ground, size, groundGen(r));
  fill(out.stone, size, stoneGen(r));
  fill(out.bark, size, barkGen(r));
  return out;
}

/**
 * The region's own Julia glyph (R: boundary line from the distance estimate, G: soft interior), for the genome's
 * constant c. Written into the soil in light, so every seed draws different sigils. z spans [−1.6, 1.6]².
 */
export function juliaGlyph(cx: number, cy: number, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const span = 1.6;
  const px = (2 * span) / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let x = -span + (i + 0.5) * px;
      let y = -span + (j + 0.5) * px;
      let dx = 1;
      let dy = 0;
      let m2 = x * x + y * y;
      let k = 0;
      for (; k < 64 && m2 < 1e6; k++) {
        const ndx = 2 * (x * dx - y * dy);
        dy = 2 * (x * dy + y * dx);
        dx = ndx;
        const nx = x * x - y * y + cx;
        y = 2 * x * y + cy;
        x = nx;
        m2 = x * x + y * y;
      }
      const o = (j * size + i) * 4;
      if (m2 >= 1e6) {
        const m = Math.sqrt(m2);
        const de = (0.5 * m * Math.log(m)) / Math.hypot(dx, dy) / px; // in texels
        out[o] = Math.round(255 * Math.exp(-de * 0.9));
      } else {
        out[o] = 255;
        out[o + 1] = 160;
      }
    }
  }
  return out;
}
