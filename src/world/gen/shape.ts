/**
 * The shape of a region's ground: pure TypeScript, no three.js, constructed from plain serialisable options. The game
 * (`Terrain`), the physics heightfields and the chunk-building module workers each construct their own copy from the
 * same `ShapeOpts`, so every thread reads the identical surface.
 */
import { fbm, makeNoise2D, type Noise2D } from '../../util/rng';
import { smoothstep } from '../../util/math';
import { Biome, NO_FEATURES, WildField, type ShapeFeatures, type WildSample } from './field';
import { neutralGenome, type Genome } from '../genome';

export type Flavour = 'seedbed' | 'river' | 'canopy' | 'mirror' | 'return';

export interface ShapeOpts {
  radius: number;
  amp: number;
  freq: number;
  river: boolean;
  seed: number;
  /** Open the region into the infinite Wilds (false keeps the bowl rim, for boss arenas). */
  wild: boolean;
  flavour: Flavour;
  genome?: Genome;
  features?: ShapeFeatures;
}

/** One-pass sample used by the chunk builder. */
export interface GroundSample {
  h: number;
  river: number;
  blight: number;
  biome: Biome;
  /** 0..1 depth into the biome cell (0 at its border). */
  core: number;
  /** 0..1 how far into the Wilds (0 in the authored core). */
  wild: number;
  /** Signed distance to the nearest Orbit Isle boundary (m); 1e4 when none. */
  isleSd: number;
}

export class GroundShape {
  readonly wild: WildField | null;
  readonly radius: number;
  private noise: Noise2D;
  private amp: number;
  private freq: number;
  private river: boolean;
  private riverA: number;
  private riverF: number;
  private riverP: number;
  readonly riverW: number;
  private ws: WildSample = { h: 0, biome: Biome.Meadow, core: 0, blight: 0, lake: 0, isleSd: 1e4 };
  private lf = { x: 0, y: 0 };

  constructor(readonly opts: ShapeOpts) {
    const o = opts;
    this.radius = o.radius;
    this.noise = makeNoise2D(o.seed);
    this.amp = o.amp;
    this.freq = o.freq;
    this.river = o.river;
    this.riverA = o.radius * 0.2;
    this.riverF = 0.032;
    this.riverP = (o.seed % 628) / 100;
    this.riverW = 9;
    this.wild = o.wild ? new WildField(o.seed, o.flavour, o.genome ?? neutralGenome(), o.features ?? NO_FEATURES) : null;
  }

  private centerX(z: number) {
    return this.riverA * Math.sin(z * this.riverF + this.riverP) + this.riverA * 0.4 * Math.sin(z * this.riverF * 2.3 + 1.7);
  }

  private channel(x: number, z: number) {
    if (!this.river) return 0;
    const d = Math.abs(x - this.centerX(z));
    return 1 - smoothstep(this.riverW * 0.35, this.riverW, d);
  }

  /** Lake of light from an Orbit Isle (0 outside the Wilds). */
  private lakeAt(x: number, z: number) {
    if (!this.wild?.isles) return 0;
    const t = this.wildness(x, z);
    return t > 0 ? this.wild.lakeAt(x, z) * t : 0;
  }

  /** 0 outside the river (or a lake of light), 1 in the channel's core. */
  riverAt(x: number, z: number) {
    const c = this.channel(x, z);
    return c >= 1 ? 1 : Math.max(c, this.lakeAt(x, z));
  }

  /** The current's direction (xz plane, +z downstream; circling on isle lakes) scaled by strength. */
  flowAt(x: number, z: number, out: { x: number; y: number }) {
    const r = this.channel(x, z);
    if (r > 0) {
      const dx = (this.centerX(z + 1) - this.centerX(z - 1)) / 2;
      const l = Math.hypot(dx, 1);
      out.x = (dx / l) * r * 5.5;
      out.y = (1 / l) * r * 5.5;
      return out;
    }
    const lake = this.wild ? this.wild.lakeFlow(x, z, this.lf) * this.wildness(x, z) : 0;
    out.x = this.lf.x * lake * 5.5;
    out.y = this.lf.y * lake * 5.5;
    return out;
  }

  /** Distance from the river's centre line (∞ when the region has no river). */
  riverDist(x: number, z: number) {
    return this.river ? Math.abs(x - this.centerX(z)) : Infinity;
  }

  /** 0 inside the authored core → 1 fully in the Wilds. */
  wildness(x: number, z: number) {
    if (!this.wild) return 0;
    return smoothstep(this.radius * 0.92, this.radius * 1.7, Math.hypot(x, z));
  }

  private coreHeight(x: number, z: number, r: number) {
    let h = fbm(this.noise, x * this.freq, z * this.freq, 4) * this.amp * 2;
    h *= 0.3 + 0.7 * smoothstep(5, 22, r);
    return h;
  }

  heightAt(x: number, z: number) {
    return this.sample(x, z, this.gs).h;
  }
  private gs: GroundSample = { h: 0, river: 0, blight: 0, biome: Biome.Meadow, core: 0, wild: 0, isleSd: 1e4 };

  /** Height, river/lake, blight and biome in one pass through the field. */
  sample(x: number, z: number, out: GroundSample): GroundSample {
    const r = Math.hypot(x, z);
    let h = this.coreHeight(x, z, r);
    let lake = 0;
    out.blight = 0;
    out.biome = Biome.Meadow;
    out.core = 0;
    out.wild = 0;
    out.isleSd = 1e4;
    if (!this.wild) {
      h += smoothstep(this.radius * 0.94, this.radius * 1.35, r) * (14 + this.radius * 0.3);
    } else {
      const t = smoothstep(this.radius * 0.92, this.radius * 1.7, r);
      out.wild = t;
      if (t > 0) {
        const w = this.wild.sample(x, z, this.ws);
        let wh = w.h;
        // rivers keep flowing through the Wilds and carve their own valleys
        if (this.river) wh *= smoothstep(this.riverW, this.riverW * 5, this.riverDist(x, z));
        h += (wh - h) * t;
        lake = w.lake * t;
        out.blight = w.blight * t;
        out.biome = w.biome;
        out.core = w.core;
        out.isleSd = w.isleSd;
      }
    }
    const ch = this.channel(x, z);
    if (this.river) h -= ch * 1.6;
    out.h = h;
    out.river = Math.max(ch, lake);
    return out;
  }

  /** Null corruption baked into the ground of Blight biomes (0..1). */
  blightAt(x: number, z: number) {
    if (!this.wild) return 0;
    const t = this.wildness(x, z);
    if (t <= 0) return 0;
    return this.wild.biomeAt(x, z).blight * t * (1 - this.wild.lakeAt(x, z));
  }

  /** Terrain steepness |∇h| (1 ≈ 45°). */
  slopeAt(x: number, z: number) {
    const e = 0.6;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.hypot(dx, dz);
  }
}
