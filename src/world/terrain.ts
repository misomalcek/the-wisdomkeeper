import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, Loop, uniform, uniformArray, attribute, positionWorld, positionView, normalWorld, float, vec2, vec3, color, mix, sin,
  fract, abs, max, min, clamp, fwidth, exp, dot, distance, atan, smoothstep as sstep, pow, texture, floor, cos, step,
  If, Break, sqrt, log,
} from 'three/tsl';
import { worldTime, fbm2, conduction, proceduralBump, hash21, type N } from '../engine/materials';
import { fractalTexture, surfaceDetail, surfaces } from '../engine/proctex';
import { GroundShape, type ShapeOpts } from './gen/shape';
import type { WildField } from './gen/field';
import type { Palette } from '../story/strata';
import { budget, flag } from '../engine/flags';
import type { Isle } from './gen/orbit';

export interface TerrainOpts extends ShapeOpts {
  palette: Palette;
  /** 0..1 how strongly the circuit-grid shows through. */
  grid: number;
}

export const MAX_LIGHTS = 10;
const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** A toroidal two-channel byte map the ground shader samples in world space (repeat-wrapped, linear). */
function rgTexture(size: number) {
  const data = new Uint8Array(size * size * 2);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, data, size };
}
export const MAX_CORRUPT = 8;

/**
 * Ground of a region: an authored core (the story arena) that blends, past its Veil seam, into the
 * infinite fractal Wilds. Height, river mask, flow and blight are analytic so entities, physics and the
 * chunk streamer all read the same surface every frame without touching any mesh.
 */
export class Terrain {
  /** Shared ground material; the chunk streamer draws every chunk with it. */
  readonly material: MeshStandardNodeMaterial;
  /** The pure ground shape (also rebuilt by the chunk workers from `shapeOpts`). */
  readonly shape: GroundShape;
  readonly shapeOpts: ShapeOpts;
  readonly radius: number;
  private u: Record<string, N>;
  /** Infinite Wilds beyond the authored core (null for bounded boss arenas). */
  get wild(): WildField | null {
    return this.shape.wild;
  }
  private lightArr: THREE.Vector4[] = Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, -9999, 0, 0));
  private corruptArr: THREE.Vector4[] = Array.from({ length: MAX_CORRUPT }, () => new THREE.Vector4(0, 0, 1, 0));
  /** Living-field texture (R corruption, G purification glow), written by the world's LivingField; null when off. */
  readonly living: { tex: THREE.DataTexture; data: Uint8Array; size: number; cell: number } | null = null;
  /** Physarum vein map (R strength, G distance along the veins from a food source), written by the world's Network. */
  readonly network: { tex: THREE.DataTexture; data: Uint8Array; size: number; cell: number } | null = null;
  /** The Orbit Isle whose full-resolution coastline the shader draws (the nearest one to the hero). */
  private coastIsle: Isle | null = null;

  constructor(o: TerrainOpts) {
    this.radius = o.radius;
    this.shapeOpts = { radius: o.radius, amp: o.amp, freq: o.freq, river: o.river, seed: o.seed, wild: o.wild, flavour: o.flavour, genome: o.genome, features: o.features };
    this.shape = new GroundShape(this.shapeOpts);

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
      // landform colours are authored as daylight earth; scale them to the region's own ground brightness
      lfL: uniform(Math.min(1, Math.max(0.12, luminance(c(o.palette.groundHigh)) * 4.5))),
      livCentre: uniform(new THREE.Vector2()),
      // far away until the first vein map arrives, so nothing shows before then
      netCentre: uniform(new THREE.Vector2(1e7, 1e7)),
      // x, z, k = 1.6/R (0: no isle), mirror; cos, sin of rotation, c
      isleA: uniform(new THREE.Vector4(0, 0, 0, 1)),
      isleB: uniform(new THREE.Vector4(1, 0, 0, 0)),
    };
    if (flag('living')) {
      this.living = { ...rgTexture(budget().living), cell: 1.5 };
    }
    if (o.wild && flag('network')) {
      const b = budget();
      this.network = { ...rgTexture(b.netSize), cell: b.netCell };
    }
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
    const tintAttr: N = attribute('aTint', 'vec3');
    const isleAttr: N = attribute('aIsle', 'float');
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
    // the living field: corruption fronts creeping out of the Blight and purification waves, on a window around the hero
    let livC: N = float(0);
    let livU: N = float(0);
    if (this.living) {
      const L = this.living;
      const lv: N = texture(L.tex, w.xz.div(L.size * L.cell));
      const off: N = abs(w.xz.sub(u.livCentre));
      const half = L.size * L.cell * 0.5;
      const fade: N = float(1).sub(sstep(half * 0.7, half * 0.92, max(off.x, off.y)));
      livC = lv.r.mul(fade);
      livU = lv.g.mul(fade);
    }
    const cor: N = max(max(corF(), blightAttr), livC);
    // the Physarum network: vein strength and the distance along the veins from the nearest food source
    let net: N = float(0);
    let netD: N = float(0);
    if (this.network) {
      const NW = this.network;
      const nv: N = texture(NW.tex, w.xz.div(NW.size * NW.cell));
      const off: N = abs(w.xz.sub(u.netCentre));
      const half = NW.size * NW.cell * 0.5;
      net = nv.r.mul(float(1).sub(sstep(half * 0.8, half * 0.97, max(off.x, off.y))));
      netD = nv.g;
    }

    // ---- albedo: height banding, slope rock, eye-level mottling, Null stain
    const h = sstep(-2, 7, w.y);
    const slope = sstep(0.92, 0.72, normalWorld.y);
    const mott = sin(w.x.mul(0.37).add(sin(w.z.mul(0.23)).mul(2))).mul(sin(w.z.mul(0.31).add(sin(w.x.mul(0.19)).mul(2))));
    const grain = fbm2(w.xz.mul(0.45));
    // biome tint from the World Genome (OKLab-blended per vertex by the chunk builder; 1 when off)
    let albedo: N = mix(u.base, u.high, h).mul(tintAttr);
    albedo = albedo.mul(mott.mul(mott).mul(0.35).add(0.8).add(grain.sub(0.5).mul(0.35)));

    // ---- procedural ground (engine/proctex): cracked soil, pebbles and moss at two scales, so it never tiles
    const near = float(1).sub(sstep(30, 90, dist));
    const gt: N = texture(surfaces.ground, w.xz.mul(0.16));
    const gm: N = texture(surfaces.ground, vec2(w.z.mul(0.029).add(0.37), w.x.mul(0.029).sub(0.11)));
    const cracks: N = gt.r.mul(sstep(0.35, 0.6, gm.b)).mul(near);
    const pebbles: N = gt.g.mul(near.mul(0.7).add(0.3));
    const moss: N = sstep(0.3, 0.75, gm.a.mul(0.7).add(gt.a.mul(0.4))).mul(sstep(0.82, 0.95, normalWorld.y));
    albedo = albedo.mul(gm.b.mul(0.45).add(0.78)).mul(gt.b.mul(0.25).add(0.88));
    albedo = mix(albedo, u.base.mul(0.5).add(u.accent.mul(0.07)).add(vec3(0.02, 0.05, 0.02)), moss.mul(0.6));
    albedo = mix(albedo, u.high.mul(1.15), pebbles.mul(0.3));
    albedo = albedo.mul(float(1).sub(cracks.mul(0.6)));
    // hills: layered rock strata on the slopes, the bands warped by noise and cut by the stone texture's joints
    const st: N = texture(surfaces.stone, vec2(w.x.add(w.z).mul(0.21), w.y.mul(0.32)));
    const strata: N = sin(w.y.mul(2.6).add(gm.b.mul(9))).mul(0.5).add(0.5);
    const rock: N = u.base.mul(0.55).add(vec3(0.035, 0.032, 0.04)).mul(strata.mul(0.45).add(0.7)).mul(st.g.mul(0.5).add(0.6)).mul(float(1).sub(st.b.mul(0.5)));
    albedo = mix(albedo, rock, slope.mul(0.85));
    // landforms: bare rock and frost on the ranges, banded strata in the canyonlands, rippled sand on the dunes
    const lf = this.landformLook(albedo, attribute('aForm', 'vec4'), dist);
    albedo = lf.albedo;
    // where the network runs the ground is trodden: darker, bare of moss, a faint sheen of the accent
    if (this.network) albedo = mix(albedo, albedo.mul(0.55).add(u.accent.mul(0.025)), sstep(0.25, 0.75, net).mul(0.8));
    albedo = mix(albedo, color(0x0a0003), cor.mul(0.75));
    if (surfaceDetail > 0) {
      const relief: N = pebbles.mul(0.5).sub(cracks.mul(0.9)).add(moss.mul(0.2)).add(slope.mul(strata.mul(0.8).sub(st.b.mul(0.6)))).add(lf.relief);
      m.normalNode = proceduralBump(relief.mul(float(1).sub(sstep(14, 45, dist))), 0.09);
    }

    // ---- emission
    const fadeNear = float(1).sub(sstep(26, 70, dist));
    // the grid and streams are drawn in plan (xz): keep them off cliffs, where they would smear into vertical streaks
    const flatM: N = sstep(0.55, 0.8, normalWorld.y);
    const lines = gridLine(0.25).mul(0.25).add(gridLine(0.05).mul(0.55)).mul(u.grid).mul(glow.mul(1.5).add(0.3)).mul(fadeNear).mul(flatM);
    let emit: N = mix(u.accent, u.accent2, sin(w.x.mul(0.05).add(t.mul(0.2))).mul(0.5).add(0.5)).mul(lines);
    emit = emit.add(u.accent.mul(glow).mul(0.05)).add(lf.emit);

    // fractal rings: here and there a Mandelbrot or Julia glyph is written into the soil in light, a pulse
    // running out from its heart; one candidate per 46 m cell, about a fifth of the cells carry one
    const cell: N = floor(w.xz.div(46));
    const hc: N = hash21(cell);
    const ctr: N = cell.add(vec2(hash21(cell.add(7.1)), hash21(cell.add(3.3))).mul(0.5).add(0.25)).mul(46);
    const rad: N = hc.mul(3).add(4.5);
    const ang: N = hash21(cell.add(11.7)).mul(6.283);
    const dl: N = w.xz.sub(ctr);
    const lp: N = vec2(dl.x.mul(cos(ang)).sub(dl.y.mul(sin(ang))), dl.x.mul(sin(ang)).add(dl.y.mul(cos(ang)))).div(rad.mul(2)).add(0.5);
    const fg: N = texture(fractalTexture(), lp);
    const glyphOn: N = step(hc, 0.21).mul(float(1).sub(sstep(0.42, 0.5, dl.length().div(rad.mul(2)))));
    // half the glyphs are the Mandelbrot set, half a Julia set: the region's own (its genome's c) when glyphs are on
    const julia: N = flag('glyphs') ? texture(surfaces.glyph, lp).r : fg.g;
    const glyphLine: N = pow(mix(fg.r, julia, step(0.5, hash21(cell.add(5.9)))), float(2.5));
    const ripple: N = sin(dl.length().mul(1.4).sub(t.mul(1.8))).mul(0.5).add(0.5);
    emit = emit.add(mix(u.accent, u.accent2, ripple).mul(glyphLine.mul(ripple.mul(0.6).add(0.4)).mul(glyphOn).mul(0.6)).mul(float(1).sub(sstep(60, 140, dist))));

    // bioluminescent data streams threading the ground, pulsing along their length
    const w1 = w.x.mul(0.11).add(sin(w.z.mul(0.07)).mul(3)).add(sin(w.z.mul(0.19).add(1.3)).mul(1.3));
    const w2 = w.z.mul(0.09).add(sin(w.x.mul(0.08).add(2)).mul(2.6)).add(sin(w.x.mul(0.21)).mul(1.1));
    const f1 = sstep(0.018, 0, abs(fract(w1).sub(0.5))).mul(flatM);
    const f2 = sstep(0.016, 0, abs(fract(w2).sub(0.5))).mul(flatM);
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
    if (this.network) {
      // veins: the trail's own iso-lines are drawn as hair-thin filaments, so every vein is a bundle of strands that
      // fan out into growth rings around the food it feeds on (as a plasmodium does); its crest burns brightest, and
      // packets of light run outward from every food source along the distance channel
      const lv: N = net.mul(5);
      const cw: N = max(fwidth(lv), float(1e-3));
      const strands: N = float(1).sub(sstep(cw.mul(0.6), cw.mul(1.8), abs(fract(lv.sub(0.5)).sub(0.5)))).mul(sstep(0.22, 0.42, net));
      // the crest: where a vein saturates into a plateau (around a food source) only its rim lights, like a tube wall
      const crest: N = sstep(0.8, 0.9, net).mul(float(1).sub(sstep(0.95, 0.995, net)));
      const halo: N = sstep(0.2, 0.8, net);
      const fine: N = float(1).sub(sstep(120, 420, dist));
      const pk: N = pow(sin(netD.mul(Math.PI * 2 * 8).sub(t.mul(2.4))).mul(0.5).add(0.5), float(8));
      const nc: N = mix(u.accent, u.accent2, pk.mul(0.7));
      const lit: N = strands.mul(fine).mul(0.4).add(crest.mul(0.18)).add(halo.mul(0.035)).add(strands.mul(fine).add(crest).mul(pk).mul(0.6));
      // the authored heart of the region has its own streams: the network only whispers there
      const heart: N = sstep(u.radius.mul(0.5), u.radius.mul(1.4), w.xz.length()).mul(0.7).add(0.3);
      emit = emit.add(nc.mul(lit).mul(heart).mul(float(1).sub(cor)));
    }
    // purification waves: rings of living light running over the ground, burning the corruption they cross
    if (this.living) emit = emit.add(mix(u.accent, vec3(0.55, 1, 0.85), 0.5).mul(livU.mul(livU).mul(1.3)));

    // river of light
    const flow = sin(w.z.mul(0.7).sub(t.mul(2.2)).add(sin(w.x.mul(0.6)).mul(1.5))).mul(0.5).add(0.5);
    const flow2 = sin(w.z.mul(1.9).sub(t.mul(3.4)).add(w.x.mul(0.8))).mul(0.5).add(0.5);
    const rk = sstep(0, 0.7, riverAttr);
    // lakes of light inside Orbit Isles ripple along iso-lines of the Julia boundary, drifting toward the heart
    const sd: N = isleAttr;
    const lakeM: N = sstep(-3, -12, sd);
    const iso: N = sin(sd.mul(0.42).add(t.mul(1.3))).mul(0.5).add(0.5);
    const rc = u.river.mul(flow.mul(flow2).mul(0.9).add(0.55)).mul(mix(float(1), iso.mul(1.1).add(0.75), lakeM)).add(u.accent2.mul(lakeM.mul(iso).mul(0.18).add(glow.mul(0.12))));
    emit = mix(emit, rc, rk);
    albedo = mix(albedo, u.river.mul(0.25), rk);
    // the shore: a soft band of light where the rim meets the lake
    emit = emit.add(u.accent2.mul(exp(sd.mul(sd).mul(-0.015)).mul(0.22)));
    if (flag('coast')) emit = emit.add(mix(u.river, u.accent2, 0.5).mul(this.coastNode(sd)));

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

  /**
   * Shading of the landforms, shared by the near chunks and the far horizon. `f` is the per-vertex form cue
   * (rock, strata, sand, signed erosion). Ranges: bare stone streaked along the fall line, gully floors darker and
   * spurs lighter, a pale frost of light on the high crests. Mesas: three-tone sediment bands warped by noise with
   * thin laminae, pale caprock on the flats. Dunes: sand with wind ripples (near only) and shaded slip faces.
   */
  private landformLook(albedo: N, f: N, dist: N): { albedo: N; emit: N; relief: N } {
    const u = this.u;
    const w = positionWorld;
    const ny = normalWorld.y;
    const L: N = u.lfL;
    const steep: N = sstep(0.9, 0.55, ny);
    const big: N = fbm2(w.xz.mul(0.013));
    const mid: N = fbm2(w.xz.mul(0.07).add(w.y.mul(0.05)));
    const near: N = float(1).sub(sstep(25, 80, dist));
    // rock: weathered stone with fall-line streaks; erosion cue darkens gully floors, lights the spurs
    const streak: N = fbm2(vec2(w.x.add(w.z).mul(0.09), w.y.mul(0.015)));
    const rockC: N = mix(u.base.mul(0.42), vec3(0.3, 0.29, 0.33).mul(L), 0.6)
      .mul(big.mul(0.5).add(0.75))
      .mul(streak.mul(0.55).add(0.72))
      .mul(clamp(f.w.mul(0.4).add(1), 0.55, 1.4));
    let a: N = mix(albedo, rockC, clamp(f.x.mul(steep.mul(0.7).add(0.45)), 0, 1));
    // frost of light on high crests (flat enough to hold it)
    const frost: N = sstep(85, 160, w.y.add(big.mul(40))).mul(sstep(0.55, 0.85, ny)).mul(sstep(0.05, 0.3, f.x.add(f.y)));
    a = mix(a, vec3(0.8, 0.84, 0.93).mul(L), frost.mul(0.85));
    // strata: three sediments in ~9 m beds, laminae inside, warped so the bands wander across cliff faces
    const sy: N = w.y.add(big.mul(7)).add(mid.mul(2.5));
    const bed: N = fract(sy.div(9));
    const lam: N = sin(sy.mul(2.3)).mul(0.5).add(0.5);
    const bandC: N = mix(mix(vec3(0.5, 0.26, 0.17).mul(L), vec3(0.68, 0.52, 0.36).mul(L), sstep(0.3, 0.37, bed)), vec3(0.34, 0.2, 0.25).mul(L), sstep(0.7, 0.77, bed))
      .mul(lam.mul(0.22).add(0.82));
    const strataC: N = mix(mix(vec3(0.72, 0.6, 0.45).mul(L), u.high, 0.15), mix(bandC, u.high, 0.12), clamp(steep.mul(1.3).add(0.1), 0, 1));
    a = mix(a, strataC, clamp(f.y.mul(1.25), 0, 1));
    // sand: wind ripples across the dune flanks, slip faces in shade
    const rp: N = sin(w.x.mul(1.35).add(w.z.mul(1.0)).add(mid.mul(7)).add(big.mul(11)));
    const sandC: N = mix(vec3(0.74, 0.57, 0.4).mul(L), u.high, 0.15).mul(float(1).sub(steep.mul(0.25))).mul(rp.mul(0.07).mul(near).add(1));
    const sand: N = clamp(f.z.mul(1.3), 0, 1);
    a = mix(a, sandC, sand);
    // gully floors hold damp, darker ground; a thread of light trickles down the deepest ones
    a = a.mul(float(1).add(min(f.w, 0).mul(0.35)));
    const trickle: N = sstep(-0.45, -0.85, f.w).mul(sin(w.y.mul(0.8).add(worldTime.mul(2.2))).mul(0.3).add(0.7));
    const emit: N = u.river.mul(trickle.mul(0.12)).add(u.accent2.mul(frost.mul(0.04)));
    const relief: N = rp.mul(sand).mul(near).mul(0.35).add(lam.mul(f.y).mul(steep).mul(0.5)).add(streak.mul(f.x).mul(steep).mul(0.4));
    return { albedo: a, emit, relief };
  }

  private hzMat: MeshStandardNodeMaterial | null = null;
  /** Cheap material for the far land: palette and biome tint, slope rock, landform look, rivers and Blight. */
  get horizonMaterial(): MeshStandardNodeMaterial {
    if (this.hzMat) return this.hzMat;
    const u = this.u;
    const w = positionWorld;
    const tint: N = attribute('aTint', 'vec3');
    const misc: N = attribute('aMisc', 'vec2');
    const dist = positionView.length();
    let albedo: N = mix(u.base, u.high, sstep(-2, 7, w.y)).mul(tint).mul(fbm2(w.xz.mul(0.004)).mul(0.3).add(0.85));
    const rock: N = u.base.mul(0.55).add(vec3(0.035, 0.032, 0.04));
    albedo = mix(albedo, rock, sstep(0.92, 0.72, normalWorld.y).mul(0.85));
    const lf = this.landformLook(albedo, attribute('aForm', 'vec4'), dist);
    const rk: N = sstep(0, 0.7, misc.x).mul(0.7);
    albedo = mix(mix(lf.albedo, u.river.mul(0.25), rk), color(0x0a0003), misc.y.mul(0.75));
    const m = new MeshStandardNodeMaterial();
    m.colorNode = albedo;
    m.emissiveNode = lf.emit.add(u.river.mul(rk).mul(0.8)).add(u.nullCol.mul(misc.y.mul(0.03)));
    m.roughnessNode = float(0.9);
    m.metalnessNode = float(0.03);
    this.hzMat = m;
    return m;
  }

  /**
   * The full-resolution Julia coastline of the nearest Orbit Isle (the oscillating "v" over the smooth "u" the height
   * field uses): fragments within ~24 m of the boundary iterate z → z² + c and draw the distance estimate as light,
   * a crisp line on the true fractal edge with filaments pulsing outward from it.
   */
  private coastNode(sd: N): N {
    const u = this.u;
    const w = positionWorld;
    const px: N = max(fwidth(w.x), float(0.02)); // pixel footprint (m), taken outside the branch
    return Fn(() => {
      const out = float(0).toVar();
      If(abs(sd).lessThan(24).and(u.isleA.z.greaterThan(0)), () => {
        const k: N = u.isleA.z;
        const d: N = w.xz.sub(u.isleA.xy);
        const zx = d.x.mul(u.isleB.x).sub(d.y.mul(u.isleB.y)).mul(k).toVar();
        const zy = d.x.mul(u.isleB.y).add(d.y.mul(u.isleB.x)).mul(k).mul(u.isleA.w).toVar();
        const dx = float(1).toVar();
        const dy = float(0).toVar();
        const m2 = zx.mul(zx).add(zy.mul(zy)).toVar();
        Loop(24, () => {
          If(m2.greaterThan(1e4), () => {
            Break();
          });
          const ndx = zx.mul(dx).sub(zy.mul(dy)).mul(2).toVar();
          dy.assign(zx.mul(dy).add(zy.mul(dx)).mul(2));
          dx.assign(ndx);
          const nx = zx.mul(zx).sub(zy.mul(zy)).add(u.isleB.z).toVar();
          zy.assign(zx.mul(zy).mul(2).add(u.isleB.w));
          zx.assign(nx);
          m2.assign(zx.mul(zx).add(zy.mul(zy)));
        });
        If(m2.greaterThan(1e4), () => {
          const m: N = sqrt(m2);
          const de: N = m.mul(log(m)).mul(0.5).div(max(sqrt(dx.mul(dx).add(dy.mul(dy))), 1e-6)).div(k); // metres
          const line: N = float(1).sub(sstep(0, px.mul(1.5).add(0.25), de));
          const pulse: N = pow(sin(de.mul(2.2).sub(worldTime.mul(2.4))).mul(0.5).add(0.5), float(6));
          out.assign(line.mul(1.1).add(pulse.mul(exp(de.mul(-0.22))).mul(0.6)));
        });
      });
      return out;
    })();
  }

  /** Point the coastline shader at an isle (null: none near). */
  setCoastIsle(isle: Isle | null) {
    if (isle === this.coastIsle) return;
    this.coastIsle = isle;
    const u = this.u;
    if (!isle) {
      (u.isleA.value as THREE.Vector4).set(0, 0, 0, 1);
      return;
    }
    (u.isleA.value as THREE.Vector4).set(isle.x, isle.z, 1.6 / isle.R, isle.flip);
    (u.isleB.value as THREE.Vector4).set(isle.cr, isle.sr, isle.c[0], isle.c[1]);
  }

  /** The Null's glow colour (linear RGB), from the World Genome. */
  setNullColour(rgb: [number, number, number]) {
    (this.u.nullCol.value as THREE.Color).setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
  }

  /** Live Null-camp corruption slots (x, z, radius, strength). */
  get corruptions(): readonly THREE.Vector4[] {
    return this.corruptArr;
  }

  /** Upload a new vein map centred on (cx, cz). */
  setNetwork(cx: number, cz: number) {
    if (!this.network) return;
    (this.u.netCentre.value as THREE.Vector2).set(cx, cz);
    this.network.tex.needsUpdate = true;
  }

  /** Upload the living field's current state (call after it steps). */
  setLiving(cx: number, cz: number) {
    if (!this.living) return;
    (this.u.livCentre.value as THREE.Vector2).set(cx, cz);
    this.living.tex.needsUpdate = true;
  }

  /** 0 outside the river (or a lake of light), 1 in the channel's core. */
  riverAt(x: number, z: number) {
    return this.shape.riverAt(x, z);
  }

  /** Writes the current's direction (xz plane, +z downstream; circling on isle lakes) scaled by strength. */
  flowAt(x: number, z: number, out: THREE.Vector2) {
    this.shape.flowAt(x, z, out);
    return out;
  }

  /** Distance from the river's centre line (∞ when the region has no river). */
  riverDist(x: number, z: number) {
    return this.shape.riverDist(x, z);
  }

  /** 0 inside the authored core → 1 fully in the Wilds. */
  wildness(x: number, z: number) {
    return this.shape.wildness(x, z);
  }

  heightAt(x: number, z: number) {
    return this.shape.heightAt(x, z);
  }

  /** Null corruption baked into the ground of Blight biomes (0..1). */
  blightAt(x: number, z: number) {
    return this.shape.blightAt(x, z);
  }

  /** Terrain steepness |∇h| (1 ≈ 45°). */
  slopeAt(x: number, z: number) {
    return this.shape.slopeAt(x, z);
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
    this.hzMat?.dispose();
  }
}
