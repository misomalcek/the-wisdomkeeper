import { makeNoise2D, makeNoise2DD, type Noise2D, type Noise2DD } from '../../util/rng';
import { smoothstep, clamp } from '../../util/math';
import { neutralGenome, type Genome } from '../genome';
import { OrbitIsles, isleLake, isleProfile, type IsleSample } from './orbit';
import { Form, Landforms, newFormSample } from './landform';

/** Which P1 shape features a field grows (copied from the flags so module workers build the identical land). */
export interface ShapeFeatures {
  erosion: boolean;
  terrace: boolean;
  orbit: boolean;
  /** Landform provinces (ranges, mesas, dunes, karst, calderas) beyond the region's near Wilds. */
  landforms?: boolean;
}
export const NO_FEATURES: ShapeFeatures = { erosion: false, terrace: false, orbit: false, landforms: false };

const TAU = Math.PI * 2;
/** Scratch for derivative noise (fields are single-threaded per worker). */
const _n = new Float64Array(3);

/** Biomes of the Wilds beyond a region's authored core. */
export enum Biome {
  /** Open spore meadows: phyllotactic mushroom rings, tufts. */
  Meadow = 0,
  /** Fractal forests: L-system trees on rolling ground. */
  Forest = 1,
  /** Crystal highlands: ridged multifractal peaks and quartz outcrops. */
  Crystal = 2,
  /** Null blight: corroded, sunken ground where the Void has taken root. */
  Blight = 3,
}

export interface BiomeSample {
  biome: Biome;
  /** 0 at a cell border, 1 deep inside the cell. */
  core: number;
  /** 0..1 Null corruption of the ground. */
  blight: number;
}

/** Everything the chunk builder needs at one point, from a single pass through the field. */
export interface WildSample {
  h: number;
  biome: Biome;
  core: number;
  blight: number;
  /** 0..1 lake of light (Orbit Isle interiors). */
  lake: number;
  /** Signed distance to the nearest isle's Julia boundary (m), 1e4 when none. */
  isleSd: number;
  /** Landform cues for shading, each 0..1 (rock: ranges, calderas, karst; strata: mesas; sand: dunes) and ero −1..1. */
  rock: number;
  strata: number;
  sand: number;
  ero: number;
}

const hash2 = (x: number, y: number, s: number) => {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ s;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * The infinite height field of the Wilds. Built from fractal principles:
 * - domain-warped fBm (Quilez) for organic, flowing landforms,
 * - ridged multifractal (Musgrave) for crystal highlands,
 * - a Voronoi biome lattice whose cells blend smoothly at their borders.
 * Fully analytic and deterministic, so physics, AI and rendering all read the same ground.
 */
export class WildField {
  private n1: Noise2D;
  private n2: Noise2D;
  private n3: Noise2D;
  private d1: Noise2DD;
  private d2: Noise2DD;
  private d4: Noise2DD;
  private seed: number;
  /** Biome weights per region flavour: which biomes appear and how often. */
  private table: Biome[];
  readonly isles: OrbitIsles | null;
  readonly forms: Landforms | null;
  private fs = newFormSample();
  private iso: IsleSample = { sd: 1e4, mask: 0, isle: null };

  constructor(
    seed: number,
    flavour: 'seedbed' | 'river' | 'canopy' | 'mirror' | 'return',
    readonly genome: Genome = neutralGenome(),
    readonly features: ShapeFeatures = NO_FEATURES,
    coreR = 120,
  ) {
    this.seed = seed >>> 0;
    this.n1 = makeNoise2D(seed ^ 0xa11ce);
    this.n2 = makeNoise2D(seed ^ 0xb0b);
    this.n3 = makeNoise2D(seed ^ 0xc0ffee);
    this.d1 = makeNoise2DD(seed ^ 0xa11ce);
    this.d2 = makeNoise2DD(seed ^ 0xb0b);
    this.d4 = makeNoise2DD(seed ^ 0x6e11);
    this.isles = features.orbit ? new OrbitIsles(seed ^ 0x0b17, genome) : null;
    this.forms = features.landforms ? new Landforms(seed ^ 0x1a4d, flavour, genome, coreR) : null;
    const T: Record<string, Biome[]> = {
      seedbed: [Biome.Meadow, Biome.Meadow, Biome.Forest, Biome.Crystal, Biome.Blight],
      river: [Biome.Meadow, Biome.Forest, Biome.Forest, Biome.Crystal, Biome.Blight],
      canopy: [Biome.Forest, Biome.Forest, Biome.Forest, Biome.Meadow, Biome.Blight],
      mirror: [Biome.Crystal, Biome.Crystal, Biome.Blight, Biome.Meadow],
      return: [Biome.Meadow, Biome.Forest, Biome.Meadow, Biome.Crystal],
    };
    this.table = T[flavour];
  }

  /** fBm with gain < 0.5 so fine octaves add texture without steepening the ground. */
  private fbm(n: Noise2D, x: number, z: number, oct: number, gain = 0.5) {
    let s = 0;
    let a = 0.5;
    let f = 1;
    for (let i = 0; i < oct; i++) {
      s += n(x * f, z * f) * a;
      f *= 2.02;
      a *= gain;
    }
    return s;
  }

  /** Ridged multifractal: sharp crests where the noise crosses zero, weighted by the previous octave. */
  private ridged(x: number, z: number) {
    let s = 0;
    let w = 1;
    let f = 1;
    let a = 0.5;
    for (let i = 0; i < 3; i++) {
      let v = 1 - Math.abs(this.n3(x * f, z * f));
      v *= v;
      v *= w;
      w = clamp(v * 2, 0, 1);
      s += v * a;
      f *= 2.1;
      a *= 0.5;
    }
    return s;
  }

  /** Voronoi biome lookup on a jittered 170 m lattice. */
  biomeAt(x: number, z: number): BiomeSample {
    const S = 170;
    // warp the lattice so borders meander like real ecotones
    const wx = x + this.n2(x * 0.004, z * 0.004) * 60;
    const wz = z + this.n2(x * 0.004 + 31.7, z * 0.004 - 12.3) * 60;
    const cx = Math.floor(wx / S);
    const cz = Math.floor(wz / S);
    let d1 = 1e9;
    let d2 = 1e9;
    let best = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i;
        const gz = cz + j;
        const px = (gx + 0.15 + 0.7 * hash2(gx, gz, this.seed)) * S;
        const pz = (gz + 0.15 + 0.7 * hash2(gx, gz, this.seed ^ 0x9e37)) * S;
        const d = (px - wx) ** 2 + (pz - wz) ** 2;
        if (d < d1) {
          d2 = d1;
          d1 = d;
          best = Math.floor(hash2(gx, gz, this.seed ^ 0x51ed) * this.table.length);
        } else if (d < d2) d2 = d;
      }
    }
    const edge = Math.sqrt(d2) - Math.sqrt(d1);
    const core = smoothstep(0, 150, edge);
    const biome = this.table[best];
    let blight = 0;
    if (biome === Biome.Blight) {
      const veins = Math.abs(this.n1(x * 0.05, z * 0.05));
      blight = core * clamp(0.55 + 0.6 * (0.35 - veins), 0, 1);
    }
    return { biome, core, blight };
  }

  /**
   * fBm with its gradient (Σ aᵢ·fᵢ·∇n): writes value, d/dx, d/dy into `o`. Same octave law as `fbm`.
   */
  private fbmD(n: Noise2DD, x: number, z: number, oct: number, gain: number, o: Float64Array) {
    let s = 0;
    let gx = 0;
    let gz = 0;
    let a = 0.5;
    let f = 1;
    for (let i = 0; i < oct; i++) {
      n(x * f, z * f, _n);
      s += _n[0] * a;
      gx += _n[1] * a * f;
      gz += _n[2] * a * f;
      f *= 2.02;
      a *= gain;
    }
    o[0] = s;
    o[1] = gx;
    o[2] = gz;
  }
  private qa = new Float64Array(3);
  private qb = new Float64Array(3);
  private rr = new Float64Array(3);

  /**
   * Gullies: stripes running down the local slope, one per jittered lattice point, Gaussian-weighted (a Gabor-like
   * kernel steered by the field's own gradient). Returns roughly −1..1; valleys where it is negative.
   */
  private gully(x: number, z: number, tx: number, tz: number, freq: number, salt: number) {
    const px = x * freq;
    const pz = z * freq;
    const ix = Math.floor(px);
    const iz = Math.floor(pz);
    let v = 0;
    let w = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = ix + i;
        const cz = iz + j;
        const ox = px - (cx + hash2(cx, cz, this.seed ^ salt));
        const oz = pz - (cz + hash2(cx, cz, this.seed ^ (salt + 0x1d)));
        // compact polynomial bell (radius 1.25 cells) instead of a Gaussian: no exp, same look
        const q = 1 - (ox * ox + oz * oz) * 0.64;
        if (q <= 0) continue;
        const k = q * q;
        v += k * Math.cos(TAU * (ox * tx + oz * tz));
        w += k;
      }
    }
    return w > 0 ? v / w : 0;
  }

  /** The rolling base land and its analytic gradient (m, m/m): [h, ∂h/∂x, ∂h/∂z] (tests, flow fields). */
  rolling(x: number, z: number): [number, number, number] {
    const s = 0.0055;
    const k = this.genome.warp;
    this.fbmD(this.d1, x * s, z * s, 3, 0.5, this.qa);
    this.fbmD(this.d1, x * s + 5.2, z * s + 1.3, 3, 0.5, this.qb);
    this.fbmD(this.d2, x * s + k * this.qa[0], z * s + k * this.qb[0], 4, 0.42, this.rr);
    const [qa, qb, rr] = [this.qa, this.qb, this.rr];
    return [rr[0] * 18, 18 * s * (rr[1] * (1 + k * qa[1]) + rr[2] * k * qb[1]), 18 * s * (rr[1] * k * qa[2] + rr[2] * (1 + k * qb[2]))];
  }

  /** Raw wild height (metres) at a point, before blending with a region's authored core. */
  height(x: number, z: number) {
    return this.sample(x, z, this.scratch).h;
  }
  private scratch: WildSample = { h: 0, biome: Biome.Meadow, core: 0, blight: 0, lake: 0, isleSd: 1e4, rock: 0, strata: 0, sand: 0, ero: 0 };

  /** Height, biome and lake in one pass (the chunk builder's hot path). */
  sample(x: number, z: number, out: WildSample): WildSample {
    const g = this.genome;
    const F = this.features;
    // domain warping: q = fbm(p), h = fbm(p + k·q), carried with its gradient through the chain rule
    const s = 0.0055;
    const px = x * s;
    const pz = z * s;
    const qa = this.qa;
    const qb = this.qb;
    const rr = this.rr;
    this.fbmD(this.d1, px, pz, 3, 0.5, qa);
    this.fbmD(this.d1, px + 5.2, pz + 1.3, 3, 0.5, qb);
    const k = g.warp;
    this.fbmD(this.d2, px + k * qa[0], pz + k * qb[0], 4, 0.42, rr);
    const AMP = 18;
    let h = rr[0] * AMP;
    // ∇h (m/m) = AMP · s · ∇r(u) · (I + k·J_q)
    const gx = AMP * s * (rr[1] * (1 + k * qa[1]) + rr[2] * k * qb[1]);
    const gz = AMP * s * (rr[1] * k * qa[2] + rr[2] * (1 + k * qb[2]));
    const b = this.biomeAt(x, z);
    if (F.erosion && g.erosion > 0.01) {
      // erosion look without simulation: gullies cut along the steepest descent, only where the land has slope
      const sl = Math.hypot(gx, gz);
      // fade in with slope, back out where the land is already steep (keeps it walkable)
      const m = smoothstep(0.06, 0.35, sl) * (1 - smoothstep(0.5, 0.85, sl)) * g.erosion * (b.biome === Biome.Blight ? 0.4 : 1);
      if (m > 0.001) {
        const tx = -gz / sl;
        const tz = gx / sl;
        h += m * (1.5 * this.gully(x, z, tx, tz, 1 / 32, 0x3e1) + 0.45 * this.gully(x, z, tx, tz, 1 / 13, 0x7a9));
      }
    }
    if (b.biome === Biome.Crystal) h += this.ridged(x * 0.004, z * 0.004) * 30 * g.ridge * b.core;
    else if (b.biome === Biome.Forest) h += this.fbm(this.n3, x * 0.015, z * 0.015, 2) * 4 * b.core;
    else if (b.biome === Biome.Blight) h -= 6 * b.core;
    else {
      h *= 1 - 0.45 * b.core; // meadows are gentler
      if (F.terrace && g.terrace > 0.02) {
        // mushroom mesas: smooth stairs (flat treads, short risers) where a slow noise says so
        this.d4(x * 0.0025, z * 0.0025, _n);
        const t = g.terrace * b.core * smoothstep(-0.05, 0.3, _n[0]);
        if (t > 0.001) {
          const STEP = 3.2;
          const q = (h + 40) / STEP;
          const f = q - Math.floor(q);
          const ht = (Math.floor(q) + smoothstep(0.3, 0.7, f)) * STEP - 40;
          h += (ht - h) * t;
        }
      }
    }
    // landform provinces: the basin keeps the rolling land, every other province replaces it with its own shape
    let basin = 1;
    out.rock = out.strata = out.sand = out.ero = 0;
    if (this.forms) {
      const fs = this.forms.sample(x, z, this.fs);
      basin = 1 - fs.amp * (1 - fs.w[Form.Basin]);
      h = h * (0.25 + 0.75 * basin) + fs.h;
      const w = fs.w;
      out.rock = fs.amp * (w[Form.Range] + w[Form.Caldera] + 0.6 * w[Form.Karst]);
      out.strata = fs.amp * (w[Form.Mesa] + 0.4 * w[Form.Karst]);
      out.sand = fs.amp * w[Form.Dunes];
      out.ero = fs.ero;
    }
    let lake = 0;
    let isleSd = 1e4;
    if (this.isles && basin > 0.02) {
      const iso = this.isles.sample(x, z, this.iso);
      if (iso.mask > 0) {
        // isles live in basins: they fade out where another landform takes over
        const mask = iso.mask * smoothstep(0.02, 0.6, basin);
        isleSd = iso.sd;
        lake = isleLake(iso.sd) * mask;
        // lakes are flat-ish: the rolling land flattens toward the basin floor, then the rim profile adds on top
        h = h * (1 - 0.75 * lake) + mask * isleProfile(iso.sd, 3 + 11 * g.ridge, 4);
      }
    }
    out.h = h;
    out.biome = b.biome;
    out.core = b.core;
    out.blight = b.blight * (1 - lake);
    out.lake = lake;
    out.isleSd = isleSd;
    return out;
  }

  /** Lake of light (0..1) only: the isle lookup without the rest of the field. */
  lakeAt(x: number, z: number) {
    if (!this.isles) return 0;
    const iso = this.isles.sample(x, z, this.iso);
    return iso.mask > 0 ? isleLake(iso.sd) * iso.mask * this.basinAt(x, z) : 0;
  }

  /** 0..1 how much of the point is basin (where Orbit Isles may sit). */
  private basinAt(x: number, z: number) {
    if (!this.forms) return 1;
    const amp = this.forms.amplitude(x, z);
    if (amp <= 0) return 1;
    const w = this.forms.weights(x, z, this.fs.w);
    return smoothstep(0.02, 0.6, 1 - amp * (1 - w[Form.Basin]));
  }

  /** Lake of light (0..1) and its circulating current at a point: writes (fx, fz) ∝ strength into `f`. */
  lakeFlow(x: number, z: number, f: { x: number; y: number }) {
    f.x = 0;
    f.y = 0;
    if (!this.isles) return 0;
    const iso = this.isles.sample(x, z, this.iso);
    if (iso.mask <= 0 || !iso.isle) return 0;
    const lake = isleLake(iso.sd) * iso.mask * this.basinAt(x, z);
    if (lake <= 0) return 0;
    const spin = iso.isle.spin;
    const e = 1.5;
    const a = this.isles.sample(x + e, z, this.iso).sd;
    const b = this.isles.sample(x - e, z, this.iso).sd;
    const c = this.isles.sample(x, z + e, this.iso).sd;
    const d = this.isles.sample(x, z - e, this.iso).sd;
    const gx = a - b;
    const gz = c - d;
    const l = Math.hypot(gx, gz) || 1;
    // currents run along the shore (perpendicular to ∇sd), circling the lake
    f.x = (-gz / l) * spin;
    f.y = (gx / l) * spin;
    return lake;
  }
}
