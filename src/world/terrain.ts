import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, Loop, uniform, uniformArray, attribute, positionWorld, positionView, normalWorld, float, vec2, vec3, color, mix, sin,
  fract, abs, max, min, clamp, fwidth, exp, dot, distance, atan, smoothstep as sstep, pow,
} from 'three/tsl';
import { worldTime, fbm2, conduction, type N } from '../engine/materials';
import { WildField } from './gen/field';
import { fbm, makeNoise2D, type Noise2D } from '../util/rng';
import { smoothstep } from '../util/math';
import type { Palette } from '../story/strata';

export interface TerrainOpts {
  radius: number;
  amp: number;
  freq: number;
  river: boolean;
  seed: number;
  palette: Palette;
  /** 0..1 how strongly the circuit-grid shows through. */
  grid: number;
  /** Open the region into the infinite Wilds (false keeps the bowl rim, for boss arenas). */
  wild: boolean;
  flavour: 'seedbed' | 'river' | 'canopy' | 'mirror' | 'return';
}

export const MAX_LIGHTS = 10;
export const MAX_CORRUPT = 8;

/**
 * Ground of a region: an authored core (the story arena) that blends, past its Veil seam, into the
 * infinite fractal Wilds. Height, river mask, flow and blight are analytic so entities, physics and the
 * chunk streamer all read the same surface every frame without touching any mesh.
 */
export class Terrain {
  /** Shared ground material; the chunk streamer draws every chunk with it. */
  readonly material: MeshStandardNodeMaterial;
  /** Infinite Wilds beyond the authored core (null for bounded boss arenas). */
  readonly wild: WildField | null;
  readonly radius: number;
  private noise: Noise2D;
  private amp: number;
  private freq: number;
  private river: boolean;
  private riverA: number;
  private riverF: number;
  private riverP: number;
  private riverW: number;
  private u: Record<string, N>;
  private lightArr: THREE.Vector4[] = Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, -9999, 0, 0));
  private corruptArr: THREE.Vector4[] = Array.from({ length: MAX_CORRUPT }, () => new THREE.Vector4(0, 0, 1, 0));

  constructor(o: TerrainOpts) {
    this.radius = o.radius;
    this.noise = makeNoise2D(o.seed);
    this.amp = o.amp;
    this.freq = o.freq;
    this.river = o.river;
    this.riverA = o.radius * 0.2;
    this.riverF = 0.032;
    this.riverP = (o.seed % 628) / 100;
    this.riverW = 9;

    this.wild = o.wild ? new WildField(o.seed, o.flavour) : null;

    const c = (hex: number) => new THREE.Color(hex);
    this.u = {
      base: uniform(c(o.palette.groundBase)),
      high: uniform(c(o.palette.groundHigh)),
      accent: uniform(c(o.palette.accent)),
      accent2: uniform(c(o.palette.accent2)),
      river: uniform(c(o.palette.river)),
      grid: uniform(o.grid),
      radius: uniform(o.radius),
      stream: uniform(o.grid > 0.8 ? 0.35 : 1),
      nullCol: uniform(new THREE.Color(0xff0055)),
    };
    this.material = this.buildMaterial();
  }

  /**
   * Ground as a lit PBR node material. Albedo carries height/slope banding and Null staining (the blueprint
   * Corrosion mask also drives roughness/metalness); emission carries the circuit grid, data streams,
   * footfall conduction, corruption veins, the river of light and the arena rim — and only emission blooms.
   */
  private buildMaterial() {
    const u = this.u;
    const lights = uniformArray(this.lightArr, 'vec4');
    const corrupt = uniformArray(this.corruptArr, 'vec4');
    const riverAttr = attribute('aRiver', 'float');
    const blightAttr: N = attribute('aBlight', 'float');
    const w = positionWorld;
    const dist = positionView.length();
    const t = worldTime;
    const m = new MeshStandardNodeMaterial();

    const gridLine = (scale: number) => {
      const q = w.xz.mul(scale);
      const g = abs(fract(q.sub(0.5)).sub(0.5)).div(max(fwidth(q), vec2(1e-4)));
      return float(1).sub(clamp(min(g.x, g.y), 0, 1));
    };

    const glowF = Fn(() => {
      const acc = float(0).toVar();
      Loop(MAX_LIGHTS, ({ i }: { i: N }) => {
        const L: N = lights.element(i);
        const d = w.xz.sub(L.xz);
        acc.addAssign(L.w.mul(exp(dot(d, d).negate().div(90))));
      });
      return clamp(acc, 0, 1.6);
    });
    const corF = Fn(() => {
      const acc = float(0).toVar();
      Loop(MAX_CORRUPT, ({ i }: { i: N }) => {
        const C: N = corrupt.element(i);
        const d = distance(w.xz, C.xy);
        const wob = float(1).add(sin(atan(w.z.sub(C.y), w.x.sub(C.x)).mul(5).add(t.mul(0.4))).mul(0.18));
        acc.assign(max(acc, float(1).sub(sstep(C.z.mul(0.55).mul(wob), C.z.mul(wob), d)).mul(C.w)));
      });
      return acc;
    });
    const glow: N = glowF();
    const cor: N = max(corF(), blightAttr);

    // ---- albedo: height banding, slope rock, eye-level mottling, Null stain
    const h = sstep(-2, 7, w.y);
    const slope = sstep(0.92, 0.72, normalWorld.y);
    const mott = sin(w.x.mul(0.37).add(sin(w.z.mul(0.23)).mul(2))).mul(sin(w.z.mul(0.31).add(sin(w.x.mul(0.19)).mul(2))));
    const grain = fbm2(w.xz.mul(0.45));
    let albedo: N = mix(u.base, u.high, h);
    albedo = mix(albedo, u.base.mul(0.55).add(vec3(0.03, 0.03, 0.035)), slope.mul(0.75));
    albedo = albedo.mul(mott.mul(mott).mul(0.35).add(0.8).add(grain.sub(0.5).mul(0.35)));
    albedo = mix(albedo, color(0x0a0003), cor.mul(0.75));

    // ---- emission
    const fadeNear = float(1).sub(sstep(26, 70, dist));
    const lines = gridLine(0.25).mul(0.25).add(gridLine(0.05).mul(0.55)).mul(u.grid).mul(glow.mul(1.5).add(0.3)).mul(fadeNear);
    let emit: N = mix(u.accent, u.accent2, sin(w.x.mul(0.05).add(t.mul(0.2))).mul(0.5).add(0.5)).mul(lines);
    emit = emit.add(u.accent.mul(glow).mul(0.05));

    // bioluminescent data streams threading the ground, pulsing along their length
    const w1 = w.x.mul(0.11).add(sin(w.z.mul(0.07)).mul(3)).add(sin(w.z.mul(0.19).add(1.3)).mul(1.3));
    const w2 = w.z.mul(0.09).add(sin(w.x.mul(0.08).add(2)).mul(2.6)).add(sin(w.x.mul(0.21)).mul(1.1));
    const f1 = sstep(0.018, 0, abs(fract(w1).sub(0.5)));
    const f2 = sstep(0.016, 0, abs(fract(w2).sub(0.5)));
    const l1 = f1.mul(sin(w.z.mul(0.9).sub(t.mul(2.2)).add(w1.mul(6))).mul(0.5).add(0.5));
    const l2 = f2.mul(sin(w.x.mul(0.8).add(t.mul(1.9)).add(w2.mul(5))).mul(0.5).add(0.5));
    const nearF = float(1).sub(sstep(35, 95, dist));
    const runs = sstep(0.38, 0.6, fbm2(w.xz.mul(0.06))); // streams surface in runs, not everywhere
    emit = emit.add(mix(u.accent, u.accent2, sin(w1).mul(0.5).add(0.5)).mul(l1.add(l2.mul(0.7))).mul(runs.mul(0.6).add(0.15)).mul(u.stream).mul(nearF));
    // footfalls conduct along the filaments (Fractal-Neural "Terrain Conduction Interface")
    emit = emit.add(conduction(vec3(0), color(0x3a6bff), max(f1, f2).add(lines.mul(0.5))).mul(float(1).sub(cor)));

    // Null corruption: creeping veins
    const vv = abs(sin(w.x.mul(0.9).add(sin(w.z.mul(0.7).add(t.mul(0.3))).mul(2.2)))).mul(abs(sin(w.z.mul(0.8).add(sin(w.x.mul(0.5)).mul(1.7)))));
    const veins = pow(float(1).sub(vv), float(16)).mul(sstep(0.42, 0.62, fbm2(w.xz.mul(0.11).add(t.mul(0.02))))); // broken into creeping patches
    const cpulse = sin(t.mul(1.6).add(w.x.mul(0.1))).mul(0.4).add(0.6);
    emit = mix(emit, emit.mul(0.25), cor).add(u.nullCol.mul(veins.mul(0.5).mul(cpulse).add(0.02)).mul(cor));

    // river of light
    const flow = sin(w.z.mul(0.7).sub(t.mul(2.2)).add(sin(w.x.mul(0.6)).mul(1.5))).mul(0.5).add(0.5);
    const flow2 = sin(w.z.mul(1.9).sub(t.mul(3.4)).add(w.x.mul(0.8))).mul(0.5).add(0.5);
    const rk = sstep(0, 0.7, riverAttr);
    const rc = u.river.mul(flow.mul(flow2).mul(0.9).add(0.55)).add(u.accent2.mul(0.12).mul(glow));
    emit = mix(emit, rc, rk);
    albedo = mix(albedo, u.river.mul(0.25), rk);

    // arena rim: a thin bright seam where the playable bowl ends
    const r = w.xz.length();
    const rd = abs(r.sub(u.radius));
    const rim = float(1).sub(sstep(0, 0.35, rd)).mul(sin(atan(w.z, w.x).mul(40).add(t)).mul(0.45).add(0.55));
    emit = emit.add(u.accent2.mul(rim).mul(0.45)).add(u.accent2.mul(exp(rd.mul(rd).mul(-0.08))).mul(0.05));

    m.colorNode = albedo;
    m.emissiveNode = emit;
    m.roughnessNode = mix(float(0.86).sub(grain.mul(0.12)), float(0.4), max(cor, rk.mul(0.9)));
    m.metalnessNode = mix(float(0.05), float(0.55), cor);
    return m;
  }

  private centerX(z: number) {
    return this.riverA * Math.sin(z * this.riverF + this.riverP) + this.riverA * 0.4 * Math.sin(z * this.riverF * 2.3 + 1.7);
  }

  /** 0 outside the river, 1 in the channel's core. */
  riverAt(x: number, z: number) {
    if (!this.river) return 0;
    const d = Math.abs(x - this.centerX(z));
    return 1 - smoothstep(this.riverW * 0.35, this.riverW, d);
  }

  /** Writes the current's direction (xz plane, +z downstream) scaled by strength. */
  flowAt(x: number, z: number, out: THREE.Vector2) {
    const r = this.riverAt(x, z);
    if (r <= 0) return out.set(0, 0);
    const dx = (this.centerX(z + 1) - this.centerX(z - 1)) / 2;
    out.set(dx, 1).normalize().multiplyScalar(r * 5.5);
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
    const r = Math.hypot(x, z);
    let h = this.coreHeight(x, z, r);
    if (!this.wild) {
      h += smoothstep(this.radius * 0.94, this.radius * 1.35, r) * (14 + this.radius * 0.3);
    } else {
      const t = smoothstep(this.radius * 0.92, this.radius * 1.7, r);
      if (t > 0) {
        let wh = this.wild.height(x, z);
        // rivers keep flowing through the Wilds and carve their own valleys
        if (this.river) wh *= smoothstep(this.riverW, this.riverW * 5, this.riverDist(x, z));
        h += (wh - h) * t;
      }
    }
    if (this.river) h -= this.riverAt(x, z) * 1.6;
    return h;
  }

  /** Null corruption baked into the ground of Blight biomes (0..1). */
  blightAt(x: number, z: number) {
    if (!this.wild) return 0;
    const t = this.wildness(x, z);
    return t > 0 ? this.wild.biomeAt(x, z).blight * t : 0;
  }

  /** Terrain steepness |∇h| (1 ≈ 45°). */
  slopeAt(x: number, z: number) {
    const e = 0.6;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.hypot(dx, dz);
  }

  /** Surface height of the river of light (valid where riverAt is high). */
  waterY(x: number, z: number) {
    return this.heightAt(x, z) + 0.35;
  }

  /** Stain the ground around a Null camp. strength 0 removes it. */
  setCorruption(i: number, x: number, z: number, radius: number, strength: number) {
    if (i >= MAX_CORRUPT) return;
    this.corruptArr[i].set(x, z, radius, strength);
  }
  getCorruption(i: number) {
    return this.corruptArr[i];
  }

  /** Feed up to MAX_LIGHTS glow sources (x, z, strength). */
  setGlow(i: number, x: number, z: number, strength: number) {
    if (i >= MAX_LIGHTS) return;
    this.lightArr[i].set(x, 0, z, strength);
    // y flag: > -9000 marks the slot as live
  }
  clearGlowFrom(i: number) {
    for (let k = i; k < MAX_LIGHTS; k++) this.lightArr[k].set(0, -9999, 0, 0);
  }

  update(_t: number) {}

  dispose() {
    this.material.dispose();
  }
}
