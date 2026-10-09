import { makeNoise2D, type Noise2D } from '../../util/rng';
import { smoothstep, clamp } from '../../util/math';

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
  private seed: number;
  /** Biome weights per region flavour: which biomes appear and how often. */
  private table: Biome[];

  constructor(seed: number, flavour: 'seedbed' | 'river' | 'canopy' | 'mirror' | 'return') {
    this.seed = seed >>> 0;
    this.n1 = makeNoise2D(seed ^ 0xa11ce);
    this.n2 = makeNoise2D(seed ^ 0xb0b);
    this.n3 = makeNoise2D(seed ^ 0xc0ffee);
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

  /** Raw wild height (metres) at a point, before blending with a region's authored core. */
  height(x: number, z: number) {
    // domain warping: q = fbm(p), h = fbm(p + k·q)
    const s = 0.0055;
    const qx = this.fbm(this.n1, x * s, z * s, 3);
    const qz = this.fbm(this.n1, x * s + 5.2, z * s + 1.3, 3);
    const rolling = this.fbm(this.n2, x * s + 2.2 * qx, z * s + 2.2 * qz, 4, 0.42) * 18;
    const b = this.biomeAt(x, z);
    let h = rolling;
    if (b.biome === Biome.Crystal) h += this.ridged(x * 0.004, z * 0.004) * 30 * b.core;
    else if (b.biome === Biome.Forest) h += this.fbm(this.n3, x * 0.015, z * 0.015, 2) * 4 * b.core;
    else if (b.biome === Biome.Blight) h -= 6 * b.core;
    else h *= 1 - 0.45 * b.core; // meadows are gentler
    return h;
  }
}
