/**
 * Orbit Isles: the Wilds' macro landforms, shaped "outside-in" by complex dynamics.
 *
 * A jittered 1.1 km lattice holds, per cell and with the genome's probability, one isle: the filled Julia set of the
 * region's constant c (z → z² + c), laid on the ground, rotated and scaled per isle. Its interior (bounded orbits)
 * sinks into a lake of light; its fractal boundary rises as a rim of hills; outside, the rim falls back to the Wilds.
 *
 * Blueprint lineage: "Inverse Fractal Topology" proposes macro terrain from orbit densities; we keep the mathematics
 * and drop the GPU-only accumulation. Each isle bakes a small signed-distance grid once (exterior: the Julia distance
 * estimate 0.5·|z|·ln|z|/|z'|; interior: a chamfer distance transform), sampled bicubically. That smooth field is the
 * "u" of the blueprint's f = u + v split and feeds `heightAt` (physics-safe, deterministic, a few µs). The ground shader
 * draws the full-resolution boundary as light: the oscillating "v".
 */
import { clamp, smoothstep } from '../../util/math';
import { juliaConstant, type Genome } from '../genome';

const CELL = 1100;
/** Grid resolution of an isle's baked SDF and the z-plane window it covers (|Re z|, |Im z| ≤ SPAN). */
const G = 128;
const SPAN = 1.8;
/** World radius (m) that |z| = 1.6 maps to, before the genome's isleSize. */
const BASE_R = 300;
const MAX_IT = 48;
/** Keep isles clear of a region's authored core (story arena + its blend into the Wilds). */
const CORE_CLEAR = 320;

export interface Isle {
  /** Centre in world metres. */
  x: number;
  z: number;
  /** World radius that |z| = 1.6 maps to. */
  R: number;
  /** cos/sin of the isle's rotation, and its mirror sign. */
  cr: number;
  sr: number;
  flip: number;
  c: [number, number];
  /** Signed distance grid in metres (+ outside the filled Julia set, − inside). */
  sd: Float32Array;
  /** Direction lakes circulate (±1). */
  spin: number;
}

export interface IsleSample {
  /** Signed distance to the Julia boundary in metres (+ outside). Large when no isle is near. */
  sd: number;
  /** 0..1 influence of the isle (fades out at its disk's edge). */
  mask: number;
  isle: Isle | null;
}

const h2 = (x: number, y: number, s: number) => {
  let h = Math.imul(x | 0, 0x2c1b3c6d) ^ Math.imul(y | 0, 0x297a2d39) ^ s;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Bakes the signed-distance grid of the filled Julia set of c over [−SPAN, SPAN]², in z-plane units. */
export function bakeJuliaSDF(cx: number, cy: number, n = G, span = SPAN): Float32Array {
  const out = new Float32Array(n * n);
  const inside = new Uint8Array(n * n);
  const px = (2 * span) / n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let x = -span + (i + 0.5) * px;
      let y = -span + (j + 0.5) * px;
      let dx = 1;
      let dy = 0;
      let m2 = x * x + y * y;
      let k = 0;
      for (; k < MAX_IT && m2 < 1e6; k++) {
        // z' ← 2 z z', z ← z² + c
        const ndx = 2 * (x * dx - y * dy);
        dy = 2 * (x * dy + y * dx);
        dx = ndx;
        const nx = x * x - y * y + cx;
        y = 2 * x * y + cy;
        x = nx;
        m2 = x * x + y * y;
      }
      const idx = j * n + i;
      if (m2 >= 1e6) {
        const m = Math.sqrt(m2);
        out[idx] = (0.5 * m * Math.log(m)) / Math.sqrt(dx * dx + dy * dy);
      } else inside[idx] = 1;
    }
  }
  // interior: chamfer (3-4) distance to the nearest exterior texel, two passes
  const D = new Float32Array(n * n);
  const INF = 1e9;
  for (let k = 0; k < n * n; k++) D[k] = inside[k] ? INF : 0;
  const a = 1;
  const b = Math.SQRT2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!inside[k]) continue;
      let d = D[k];
      if (i > 0) d = Math.min(d, D[k - 1] + a);
      if (j > 0) {
        d = Math.min(d, D[k - n] + a);
        if (i > 0) d = Math.min(d, D[k - n - 1] + b);
        if (i < n - 1) d = Math.min(d, D[k - n + 1] + b);
      }
      D[k] = d;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      if (!inside[k]) continue;
      let d = D[k];
      if (i < n - 1) d = Math.min(d, D[k + 1] + a);
      if (j < n - 1) {
        d = Math.min(d, D[k + n] + a);
        if (i < n - 1) d = Math.min(d, D[k + n + 1] + b);
        if (i > 0) d = Math.min(d, D[k + n - 1] + b);
      }
      D[k] = d;
    }
  }
  for (let k = 0; k < n * n; k++) if (inside[k]) out[k] = -(Math.min(D[k], 4 * n) - 0.5) * px;
  return out;
}

/** Catmull-Rom weights. */
const cr = (t: number, w: Float64Array) => {
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
};
const wx = new Float64Array(4);
const wy = new Float64Array(4);

export class OrbitIsles {
  private cells = new Map<number, Isle | null>();
  private order: number[] = [];
  private last: { key: number; isle: Isle | null } = { key: NaN, isle: null };
  private readonly prob: number;
  private readonly size: number;

  constructor(private seed: number, private genome: Genome) {
    this.prob = genome.isles;
    this.size = genome.isleSize;
  }

  /** The isle of lattice cell (i, j), or null (deterministic; baked on first use, the last 12 kept). */
  isleAt(i: number, j: number): Isle | null {
    const key = (i + 32768) * 65536 + (j + 32768);
    if (key === this.last.key) return this.last.isle;
    let isle = this.cells.get(key);
    if (isle === undefined) {
      isle = this.make(i, j);
      this.cells.set(key, isle);
      this.order.push(key);
      if (this.order.length > 12) {
        const old = this.order.shift()!;
        if (old !== key) this.cells.delete(old);
      }
    }
    this.last = { key, isle };
    return isle;
  }

  /** The nearest isle around (x, z) among those already baked (never bakes: safe to call every frame). */
  nearestBaked(x: number, z: number): Isle | null {
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    let best: Isle | null = null;
    let bd = Infinity;
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        const isle = this.cells.get((i + 32768) * 65536 + (j + 32768));
        if (!isle) continue;
        const d = Math.hypot(x - isle.x, z - isle.z) - isle.R;
        if (d < bd) {
          bd = d;
          best = isle;
        }
      }
    }
    return best;
  }

  private make(i: number, j: number): Isle | null {
    const s = this.seed >>> 0;
    if (h2(i, j, s ^ 0x15e1) > this.prob) return null;
    const R = BASE_R * this.size * (0.8 + 0.4 * h2(i, j, s ^ 0x5a1e));
    const reach = R * 1.15;
    const slack = Math.max(0, CELL / 2 - reach);
    const x = (i + 0.5) * CELL + (h2(i, j, s ^ 0x7e57) - 0.5) * 2 * slack;
    const z = (j + 0.5) * CELL + (h2(i, j, s ^ 0x0b17) - 0.5) * 2 * slack;
    if (Math.hypot(x, z) - reach < CORE_CLEAR) return null;
    const rot = h2(i, j, s ^ 0x9071) * Math.PI * 2;
    // each isle a sibling of the region's set: its constant wanders a little around the genome's
    const c = juliaConstant({ juliaA: this.genome.juliaA + (h2(i, j, s ^ 0xa11e) - 0.5) * 0.08, juliaB: clamp(this.genome.juliaB + (h2(i, j, s ^ 0xbeef) - 0.5) * 0.35, 0, 1) });
    // bake in z-units, then convert to metres
    const sd = bakeJuliaSDF(c[0], c[1]);
    const k = R / 1.6;
    for (let n = 0; n < sd.length; n++) sd[n] *= k;
    return { x, z, R, cr: Math.cos(rot), sr: Math.sin(rot), flip: h2(i, j, s ^ 0xf11b) < 0.5 ? 1 : -1, c, sd, spin: h2(i, j, s ^ 0x5b17) < 0.5 ? 1 : -1 };
  }

  /** Signed distance (m) to the nearest isle's Julia boundary and the isle's influence at a world point. */
  sample(x: number, z: number, out: IsleSample): IsleSample {
    const isle = this.isleAt(Math.floor(x / CELL), Math.floor(z / CELL));
    out.isle = isle;
    if (!isle) {
      out.sd = 1e4;
      out.mask = 0;
      return out;
    }
    const dx = x - isle.x;
    const dz = z - isle.z;
    const r = Math.hypot(dx, dz) / isle.R;
    out.mask = 1 - smoothstep(0.92, 1.12, r);
    if (out.mask <= 0) {
      out.sd = 1e4;
      return out;
    }
    // world → z-plane (rotated, mirrored, scaled so |z| = 1.6 at R) → grid texels
    const k = 1.6 / isle.R;
    const zx = (dx * isle.cr - dz * isle.sr) * k;
    const zy = (dx * isle.sr + dz * isle.cr) * k * isle.flip;
    const gx = ((zx + SPAN) / (2 * SPAN)) * G - 0.5;
    const gy = ((zy + SPAN) / (2 * SPAN)) * G - 0.5;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    cr(gx - ix, wx);
    cr(gy - iy, wy);
    let v = 0;
    const sd = isle.sd;
    for (let b = 0; b < 4; b++) {
      const yy = clamp(iy - 1 + b, 0, G - 1) * G;
      let row = 0;
      for (let a = 0; a < 4; a++) row += wx[a] * sd[yy + clamp(ix - 1 + a, 0, G - 1)];
      v += wy[b] * row;
    }
    out.sd = v;
    return out;
  }
}

/**
 * Height profile of an isle as a function of signed distance: a rim cresting just outside the Julia boundary, falling
 * gently outward and more steeply into the lake basin. `rim` and `depth` in metres. Continuous and C1.
 */
export function isleProfile(sd: number, rim: number, depth: number) {
  const r0 = 6;
  const w = sd > r0 ? 46 : 28;
  const u = (sd - r0) / w;
  return rim * Math.exp(-u * u) - depth * smoothstep(r0, r0 - 34, sd);
}

/** 0..1 lake of light: deep inside the filled Julia set. */
export const isleLake = (sd: number) => smoothstep(-4, -14, sd);
