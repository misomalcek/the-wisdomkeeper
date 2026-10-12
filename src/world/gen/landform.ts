/**
 * Landforms: the large-scale shape of the Wilds. The land is divided into warped Voronoi provinces about 1.4 km
 * across. Each province carries one landform archetype, and neighbouring provinces blend over a few hundred metres
 * (soft-min weights), so walking or flying out of a region crosses real landscapes:
 *
 *  - Range:   eroded mountains. Derivative-damped fBm (each octave weakened where the land is already steep,
 *             Quilez), so ridges stay sharp and valleys flatten out, cut by branching gullies that follow the steepest
 *             descent at three scales (an erosion filter evaluated per point, no simulation).
 *  - Mesa:    canyonlands. Plateaus of stacked strata with cliff risers, sliced by meandering canyons (the zero set of
 *             a domain-warped noise).
 *  - Dunes:   a sand sea. Asymmetric crescent ridges (long windward slope, steep slip face) across a prevailing wind,
 *             broken into barchans by a crosswise wave.
 *  - Karst:   a pillar forest. Sheer towers on a jittered lattice (Zhangjiajie-like), their outlines frayed by noise.
 *  - Caldera: volcanic fields. Cones with summit craters and radial gullies.
 *  - Basin:   the gentle rolling land (and Orbit Isles) the Wilds had before.
 *
 * Pure TypeScript, deterministic per point: the chunk workers, physics and `heightAt` all evaluate the same field.
 */
import { makeNoise2D, makeNoise2DD, type Noise2D, type Noise2DD } from '../../util/rng';
import { clamp, smoothstep } from '../../util/math';
import type { Genome } from '../genome';

export enum Form {
  Basin = 0,
  Range = 1,
  Mesa = 2,
  Dunes = 3,
  Karst = 4,
  Caldera = 5,
}
export const FORM_COUNT = 6;

/** Landform sample: height (m) to add, the province weights and the cues the ground shader needs. */
export interface FormSample {
  h: number;
  /** Weight of each landform here (sums to 1). */
  w: Float32Array;
  /** Signed erosion detail (−1 gully floor … +1 spur), for shading. */
  ero: number;
  /** 0..1 how much the province shape is in effect (0 near a region's authored core). */
  amp: number;
}

const hash2 = (x: number, y: number, s: number) => {
  let h = Math.imul(x | 0, 0x2f6b2c39) ^ Math.imul(y | 0, 0x1b873593) ^ s;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const TAU = Math.PI * 2;
const PROVINCE = 1400;
/** Soft-min temperature (m): how wide the transition between provinces is. */
const BLEND = 170;
const _d = new Float64Array(3);

/** Which landforms a region's Wilds favour (weights, by Form index). */
const FLAVOUR_FORMS: Record<string, number[]> = {
  //          basin range mesa dunes karst caldera
  seedbed: [1.2, 1.0, 0.5, 0.4, 0.8, 0.3],
  river: [1.0, 0.7, 1.2, 0.3, 0.6, 0.2],
  canopy: [0.9, 0.9, 0.3, 0.2, 1.4, 0.3],
  mirror: [0.5, 0.8, 0.9, 1.3, 0.4, 0.9],
  return: [1.4, 0.8, 0.5, 0.4, 0.6, 0.2],
};

export class Landforms {
  private nA: Noise2DD;
  private nB: Noise2DD;
  private nW: Noise2D;
  private nC: Noise2D;
  private seed: number;
  private bias: number[];
  /** Per-province scratch: up to 9 candidates. */
  private cd = new Float64Array(9);
  private cf = new Int32Array(9);
  private ci = new Int32Array(9);
  private cj = new Int32Array(9);

  constructor(seed: number, flavour: string, g: Genome, private coreR: number) {
    this.seed = seed >>> 0;
    this.nA = makeNoise2DD(seed ^ 0x7a11);
    this.nB = makeNoise2DD(seed ^ 0x3e5a);
    this.nW = makeNoise2D(seed ^ 0x51de);
    this.nC = makeNoise2D(seed ^ 0xca1d);
    const base = FLAVOUR_FORMS[flavour] ?? FLAVOUR_FORMS.seedbed;
    // the genome leans the mix: ridged regions grow ranges, terraced ones mesas, warped ones dunes and calderas
    this.bias = base.map((b, k) =>
      b * (k === Form.Range ? 0.6 + g.ridge * 0.6 : k === Form.Mesa ? 0.6 + g.terrace * 0.9 : k === Form.Karst ? 0.7 + g.growth * 0.4 : k === Form.Dunes ? 0.5 + (g.warp - 1) * 0.3 : 1),
    );
  }

  /** The archetype of province (i, j). The province holding the region's centre is always a basin. */
  private formOf(i: number, j: number) {
    if (i === 0 && j === 0) return Form.Basin;
    let tot = 0;
    for (const b of this.bias) tot += b;
    let r = hash2(i, j, this.seed ^ 0x9a7e) * tot;
    for (let k = 0; k < FORM_COUNT; k++) {
      r -= this.bias[k];
      if (r <= 0) return k as Form;
    }
    return Form.Basin;
  }

  /** Province weights at a point (soft-min over the warped Voronoi distances). */
  weights(x: number, z: number, w: Float32Array) {
    w.fill(0);
    const wx = x + this.nW(x * 0.0007, z * 0.0007) * 380;
    const wz = z + this.nW(x * 0.0007 + 17.3, z * 0.0007 - 9.1) * 380;
    // offset the lattice so the region centre sits deep inside province (0, 0)
    const ox = wx + PROVINCE / 2;
    const oz = wz + PROVINCE / 2;
    const cx = Math.floor(ox / PROVINCE);
    const cz = Math.floor(oz / PROVINCE);
    let dmin = 1e9;
    let n = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gi = cx + i;
        const gj = cz + j;
        const centre = gi === 0 && gj === 0;
        const px = (gi + (centre ? 0.5 : 0.2 + 0.6 * hash2(gi, gj, this.seed))) * PROVINCE;
        const pz = (gj + (centre ? 0.5 : 0.2 + 0.6 * hash2(gi, gj, this.seed ^ 0x77))) * PROVINCE;
        const d = Math.hypot(px - ox, pz - oz);
        this.cd[n] = d;
        this.cf[n] = this.formOf(gi, gj);
        this.ci[n] = gi;
        this.cj[n] = gj;
        if (d < dmin) dmin = d;
        n++;
      }
    }
    let tot = 0;
    for (let k = 0; k < n; k++) {
      const e = Math.exp(-(this.cd[k] - dmin) / BLEND);
      if (e < 0.01) continue;
      w[this.cf[k]] += e;
      tot += e;
    }
    for (let k = 0; k < FORM_COUNT; k++) w[k] /= tot;
    return w;
  }

  /** The province a point belongs to (nearest warped centre): lattice index, archetype and centre (world m). */
  province(x: number, z: number) {
    const wx = x + this.nW(x * 0.0007, z * 0.0007) * 380;
    const wz = z + this.nW(x * 0.0007 + 17.3, z * 0.0007 - 9.1) * 380;
    const ox = wx + PROVINCE / 2;
    const oz = wz + PROVINCE / 2;
    const cx = Math.floor(ox / PROVINCE);
    const cz = Math.floor(oz / PROVINCE);
    let best = { i: 0, j: 0, form: Form.Basin, x: 0, z: 0 };
    let bd = Infinity;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gi = cx + i;
        const gj = cz + j;
        const centre = gi === 0 && gj === 0;
        const px = (gi + (centre ? 0.5 : 0.2 + 0.6 * hash2(gi, gj, this.seed))) * PROVINCE;
        const pz = (gj + (centre ? 0.5 : 0.2 + 0.6 * hash2(gi, gj, this.seed ^ 0x77))) * PROVINCE;
        const d = Math.hypot(px - ox, pz - oz);
        if (d < bd) {
          bd = d;
          best = { i: gi, j: gj, form: this.formOf(gi, gj), x: px - PROVINCE / 2, z: pz - PROVINCE / 2 };
        }
      }
    }
    return best;
  }

  /** How strongly the provinces shape the land here: none near the authored core, full a few hundred metres out. */
  amplitude(x: number, z: number) {
    const r = Math.hypot(x, z);
    return smoothstep(this.coreR * 1.7 + 60, this.coreR * 1.7 + 560, r);
  }

  sample(x: number, z: number, out: FormSample): FormSample {
    const w = this.weights(x, z, out.w);
    const amp = this.amplitude(x, z);
    out.amp = amp;
    out.ero = 0;
    let h = 0;
    if (amp <= 0) {
      out.h = 0;
      return out;
    }
    if (w[Form.Range] > 0.005) h += w[Form.Range] * this.range(x, z, out);
    if (w[Form.Mesa] > 0.005) h += w[Form.Mesa] * this.mesa(x, z);
    if (w[Form.Dunes] > 0.005) h += w[Form.Dunes] * this.dunes(x, z);
    if (w[Form.Karst] > 0.005) h += w[Form.Karst] * this.karst(x, z);
    if (w[Form.Caldera] > 0.005) h += w[Form.Caldera] * this.caldera(x, z);
    out.h = h * amp;
    out.ero *= amp;
    return out;
  }

  // ---------------------------------------------------------------------------------------------- archetypes

  /**
   * Eroded range. Derivative-damped fBm: each octave is divided by 1 + |Σ∇|², so detail piles up on gentle ground and
   * stays off steep flanks, which reads as weathered rock. Then branching gullies along the steepest descent.
   */
  private range(x: number, z: number, out: FormSample) {
    const s = 1 / 1500;
    // a gentle warp bends the ridgelines so they curve like real chains
    let px = x * s + this.nW(x * 0.00045, z * 0.00045) * 0.45;
    let pz = z * s + this.nW(x * 0.00045 + 5.7, z * 0.00045 - 2.2) * 0.45;
    let a = 0.5;
    let v = 0;
    let dx = 0;
    let dz = 0;
    for (let o = 0; o < 8; o++) {
      this.nA(px, pz, _d);
      // ridged: fold the noise so crests are sharp
      const sgn = _d[0] < 0 ? -1 : 1;
      const n = 1 - Math.abs(_d[0]);
      dx += -sgn * _d[1] * a;
      dz += -sgn * _d[2] * a;
      v += (a * n * n) / (1 + dx * dx + dz * dz);
      // rotate and scale the next octave (removes lattice alignment)
      const nx = 1.6 * px - 1.2 * pz;
      pz = 1.2 * px + 1.6 * pz;
      px = nx;
      a *= 0.48;
    }
    // massif mask: ranges come in chains, not uniform noise
    const chain = smoothstep(-0.35, 0.45, this.nC(x * 0.0011, z * 0.0011));
    const H = 380 * (0.35 + 0.65 * chain);
    let h = H * Math.pow(Math.max(0, v - 0.05) / 0.75, 1.6);
    // erosion: gullies cut along the gradient of the big shape, three octaves, strongest mid-slope
    const e = 6;
    const hx = this.rangeCoarse(x + e, z) - this.rangeCoarse(x - e, z);
    const hz = this.rangeCoarse(x, z + e) - this.rangeCoarse(x, z - e);
    const sl = Math.hypot(hx, hz) / (2 * e);
    if (sl > 0.02) {
      const tx = -hz / (sl * 2 * e);
      const tz = hx / (sl * 2 * e);
      const m = smoothstep(0.05, 0.35, sl) * (1 - 0.5 * smoothstep(0.9, 1.6, sl));
      const g1 = this.gully(x, z, tx, tz, 1 / 85, 0x1a1);
      const g2 = this.gully(x, z, tx, tz, 1 / 36, 0x2b2);
      const g3 = this.gully(x, z, tx, tz, 1 / 15, 0x3c3);
      const ero = g1 * 0.55 + g2 * 0.3 + g3 * 0.15;
      h += m * (14 * g1 + 5 * g2 + 1.6 * g3) * (0.3 + 0.7 * smoothstep(10, 60, h));
      out.ero += ero * m;
    }
    return h;
  }

  /** Two-octave version of the range shape (for the erosion direction; cheap finite differences). */
  private rangeCoarse(x: number, z: number) {
    const s = 1 / 1500;
    const px = x * s + this.nW(x * 0.00045, z * 0.00045) * 0.45;
    const pz = z * s + this.nW(x * 0.00045 + 5.7, z * 0.00045 - 2.2) * 0.45;
    this.nA(px, pz, _d);
    let n = 1 - Math.abs(_d[0]);
    let h = n * n;
    this.nA(1.6 * px - 1.2 * pz, 1.2 * px + 1.6 * pz, _d);
    n = 1 - Math.abs(_d[0]);
    h += 0.48 * n * n;
    return 240 * h;
  }

  /** Steered stripe kernel: valleys (−) and spurs (+) running down the slope (tx, tz is the contour direction). */
  private gully(x: number, z: number, tx: number, tz: number, freq: number, salt: number) {
    const px = x * freq;
    const pz = z * freq;
    const ix = Math.floor(px);
    const iz = Math.floor(pz);
    let v = 0;
    let wt = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = ix + i;
        const cz = iz + j;
        const ox = px - (cx + hash2(cx, cz, this.seed ^ salt));
        const oz = pz - (cz + hash2(cx, cz, this.seed ^ (salt + 0x1d)));
        const q = 1 - (ox * ox + oz * oz) * 0.64;
        if (q <= 0) continue;
        const k = q * q;
        v += k * Math.cos(TAU * (ox * tx + oz * tz));
        wt += k;
      }
    }
    return wt > 0 ? v / wt : 0;
  }

  /** Canyonlands: strata plateaus with cliff risers, cut by meandering canyons. */
  private mesa(x: number, z: number) {
    this.nB(x / 900, z / 900, _d);
    const base = clamp(_d[0] * 0.75 + 0.55, 0, 1);
    // stacked strata: flat treads, a steep riser over the last 12% of each step
    const STEPS = 4;
    const q = base * STEPS;
    const f = q - Math.floor(q);
    const level = (Math.floor(q) + smoothstep(0.84, 0.97, f)) / STEPS;
    let h = level * 120;
    // ledges: small sub-steps in the cliff band so faces read as layered rock
    h += smoothstep(0.84, 0.97, f) * 3 * Math.sin(h * 0.9);
    // canyons: the zero set of warped noise, a winding slot cut down to the floor
    const wx = x + this.nW(x * 0.002, z * 0.002) * 160;
    const wz = z + this.nW(x * 0.002 + 4.1, z * 0.002 - 2.7) * 160;
    const c = Math.abs(this.nC(wx * 0.0016, wz * 0.0016));
    const wall = smoothstep(0.035, 0.11, c);
    // a second, finer side-canyon network
    const c2 = Math.abs(this.nC(wx * 0.0042 + 9.3, wz * 0.0042 - 3.1));
    const wall2 = 1 - (1 - smoothstep(0.03, 0.09, c2)) * smoothstep(40, 90, h);
    return h * wall * (0.35 + 0.65 * wall2) - 6 * (1 - wall);
  }

  /** Sand sea: crescent ridges across a prevailing wind, broken into barchans. */
  private dunes(x: number, z: number) {
    const a = hash2(Math.floor(x / 4000), Math.floor(z / 4000), this.seed ^ 0xd1) * TAU * 0.25 + 0.6;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    const warp = this.nW(x * 0.003, z * 0.003) * 30 + this.nW(x * 0.011, z * 0.011) * 6;
    const along = (x * ux + z * uz + warp) / 92;
    const across = (-x * uz + z * ux) / 140;
    const s = along - Math.floor(along);
    // windward slope rises over 72% of the wavelength, the slip face drops over the rest
    const prof = s < 0.72 ? Math.pow(s / 0.72, 1.6) : 1 - smoothstep(0.72, 1, s);
    const barchan = 0.55 + 0.45 * Math.sin(across * TAU + this.nW(x * 0.004, z * 0.004) * 3);
    const A = 10 + 20 * (0.5 + 0.5 * this.nC(x * 0.0018, z * 0.0018));
    // long draa underneath
    const draa = 22 * this.nC(x * 0.0009 + 3.3, z * 0.0009);
    return A * prof * barchan + draa + 6;
  }

  /** Pillar forest: sheer towers on a jittered 64 m lattice. */
  private karst(x: number, z: number) {
    const S = 64;
    const ix = Math.floor(x / S);
    const iz = Math.floor(z / S);
    let h = 0;
    const fray = this.nW(x * 0.09, z * 0.09) * 4 + this.nW(x * 0.031, z * 0.031) * 6;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = ix + i;
        const gz = iz + j;
        const p = hash2(gx, gz, this.seed ^ 0xca5);
        if (p > 0.5) continue;
        const cx = (gx + 0.25 + 0.5 * hash2(gx, gz, this.seed ^ 0x11)) * S;
        const cz = (gz + 0.25 + 0.5 * hash2(gx, gz, this.seed ^ 0x22)) * S;
        const r = 9 + 15 * hash2(gx, gz, this.seed ^ 0x33);
        const H = 35 + 95 * hash2(gx, gz, this.seed ^ 0x44) ** 1.5;
        const d = Math.hypot(x - cx, z - cz) + fray;
        // a vertical wall with a slight talus at the foot, and a domed, weathered top
        const body = 1 - smoothstep(r - 3, r + 1.5, d);
        const talus = (1 - smoothstep(r, r + 10, d)) * 0.08;
        const top = 1 - 0.12 * (d / r) ** 2;
        h = Math.max(h, H * (body * top + talus));
      }
    }
    // the floor between towers: low, with sinkholes
    const floor = 3 * this.nC(x * 0.02, z * 0.02) - 4 * smoothstep(0.55, 0.8, this.nW(x * 0.013 + 7, z * 0.013));
    return h + floor;
  }

  /** Volcanic field: cones with summit craters and radial gullies, one per 520 m cell. */
  private caldera(x: number, z: number) {
    const S = 520;
    const ix = Math.floor(x / S);
    const iz = Math.floor(z / S);
    let h = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = ix + i;
        const gz = iz + j;
        if (hash2(gx, gz, this.seed ^ 0xc0) > 0.7) continue;
        const cx = (gx + 0.3 + 0.4 * hash2(gx, gz, this.seed ^ 0xc1)) * S;
        const cz = (gz + 0.3 + 0.4 * hash2(gx, gz, this.seed ^ 0xc2)) * S;
        const R0 = 45 + 70 * hash2(gx, gz, this.seed ^ 0xc3);
        const H = 60 + 110 * hash2(gx, gz, this.seed ^ 0xc4);
        const dx = x - cx;
        const dz = z - cz;
        const d = Math.hypot(dx, dz);
        if (d > R0 * 4.5) continue;
        const ang = Math.atan2(dz, dx);
        // radial gullies on the flank
        const rib = 1 - 0.12 * Math.pow(Math.abs(Math.sin(ang * 11 + this.nW(dx * 0.02, dz * 0.02) * 2)), 0.5) * smoothstep(R0, R0 * 2, d);
        const flank = Math.pow(1 - smoothstep(R0, R0 * 4.5, d), 1.6);
        const crater = smoothstep(R0 * 0.95, R0 * 0.55, d);
        h = Math.max(h, H * flank * rib - H * 0.55 * crater);
      }
    }
    return h + 4 * this.nC(x * 0.01, z * 0.01);
  }
}

export const newFormSample = (): FormSample => ({ h: 0, w: new Float32Array(FORM_COUNT), ero: 0, amp: 0 });
