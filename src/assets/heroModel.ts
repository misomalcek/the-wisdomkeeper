import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, clamp, float, materialEmissive, positionGeometry, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import { Sculpt, skinnedTube, matWeights, MAT, type Prim, type MatId } from './sdf';
import { fresnel, type N } from '../engine/materials';

/**
 * The Wisdomkeeper as one sculpted, skinned mesh (Tripo turntable reference): slender blue-teal body with
 * defined musculature, an elongated faceless helm that sweeps back into an antler crest, violet back, hips,
 * hamstrings and calves, and eight cyan nodes running up the spine. Bones mirror the procedural pose rig.
 */

export const BONE = {
  body: 0, hips: 1, spine: 2, chest: 3, head: 4,
  thL: 5, knL: 6, ftL: 7, thR: 8, knR: 9, ftR: 10,
  shL: 11, elL: 12, hdL: 13, shR: 14, elR: 15, hdR: 16,
  crest: 17,
} as const;
export const CREST_STRANDS = 5;
export const CREST_SEGS = 3;

/** Bind-pose offsets (parent-relative); all bones start unrotated. */
const LAYOUT: [number, number, [number, number, number]][] = [
  [BONE.body, -1, [0, 0, 0]],
  [BONE.hips, BONE.body, [0, 0.98, 0]],
  [BONE.spine, BONE.hips, [0, 0.1, 0]],
  [BONE.chest, BONE.spine, [0, 0.32, 0]],
  [BONE.head, BONE.chest, [0, 0.4, 0]],
  [BONE.thL, BONE.hips, [-0.1, -0.05, 0]],
  [BONE.knL, BONE.thL, [0, -0.44, 0]],
  [BONE.ftL, BONE.knL, [0, -0.42, 0]],
  [BONE.thR, BONE.hips, [0.1, -0.05, 0]],
  [BONE.knR, BONE.thR, [0, -0.44, 0]],
  [BONE.ftR, BONE.knR, [0, -0.42, 0]],
  [BONE.shL, BONE.chest, [-0.215, 0.24, 0]],
  [BONE.elL, BONE.shL, [-0.01, -0.31, 0]],
  [BONE.hdL, BONE.elL, [-0.008, -0.28, 0.005]],
  [BONE.shR, BONE.chest, [0.215, 0.24, 0]],
  [BONE.elR, BONE.shR, [0.01, -0.31, 0]],
  [BONE.hdR, BONE.elR, [0.008, -0.28, 0.005]],
];
export const LEG = { thigh: 0.44, shin: 0.42, ankle: 0.07 };

/** Crest strand control points (head-relative model space), one curve per strand. */
function crestCurve(i: number): THREE.Vector3[] {
  const a = (i / (CREST_STRANDS - 1) - 0.5) * 1.9;
  const len = 1 - Math.abs(a) * 0.28;
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    pts.push(new THREE.Vector3(
      Math.sin(a) * (0.04 + 0.13 * t * len + 0.09 * t * t),
      2.0 + (0.4 * t - 0.08 * t * t) * len,
      -0.08 - (0.1 * t + 0.1 * t * t) * len,
    ));
  }
  return pts;
}

export interface HeroRig {
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
}

export function buildRig(): HeroRig {
  const bones: THREE.Bone[] = [];
  for (const [i, parent, p] of LAYOUT) {
    const b = new THREE.Bone();
    b.name = Object.keys(BONE).find((k) => BONE[k as keyof typeof BONE] === i)!;
    b.position.set(...p);
    bones[i] = b;
    if (parent >= 0) bones[parent].add(b);
  }
  // crest: per strand a chain of CREST_SEGS bones pivoting at t = k / CREST_SEGS along its curve
  for (let s = 0; s < CREST_STRANDS; s++) {
    const curve = new THREE.CatmullRomCurve3(crestCurve(s));
    let parent = bones[BONE.head];
    let prev = new THREE.Vector3(0, 1.8, 0);
    for (let k = 0; k < CREST_SEGS; k++) {
      const b = new THREE.Bone();
      b.name = `crest${s}_${k}`;
      const p = curve.getPointAt(k / CREST_SEGS);
      b.position.copy(p).sub(prev);
      prev = p;
      parent.add(b);
      parent = b;
      bones[BONE.crest + s * CREST_SEGS + k] = b;
    }
  }
  bones[0].updateMatrixWorld(true);
  return { bones, skeleton: new THREE.Skeleton(bones) };
}

let cached: THREE.BufferGeometry | null = null;

/** Sculpt (once per session) the hero's skinned body geometry against the bind pose. */
export function heroGeometry(): THREE.BufferGeometry {
  if (cached) return cached;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const P: Prim[] = [];
  const cone = (bone: number, a: number[], b: number[], ra: number, rb: number, k: number, mat: MatId = MAT.skin) =>
    P.push({ bone, kind: 'cone', a: V(a[0], a[1], a[2]), b: V(b[0], b[1], b[2]), ra, rb, k, mat });
  const ell = (bone: number, c: number[], r: number[], k: number, mat: MatId = MAT.skin, rot?: number[]) =>
    P.push({ bone, kind: 'ellipsoid', a: V(c[0], c[1], c[2]), ra: 0, radii: V(r[0], r[1], r[2]), rot: rot ? new THREE.Euler(rot[0], rot[1], rot[2]) : undefined, k, mat });
  const A = MAT.armor;

  // ---- core volumes
  ell(BONE.hips, [0, 0.985, -0.005], [0.132, 0.1, 0.092], 0);
  cone(BONE.spine, [0, 1.0, 0], [0, 1.3, 0.005], 0.098, 0.106, 0.05);
  ell(BONE.chest, [0, 1.44, -0.005], [0.142, 0.165, 0.098], 0.05);
  ell(BONE.chest, [0, 1.56, -0.01], [0.165, 0.075, 0.09], 0.05);
  ell(BONE.chest, [0, 1.43, -0.045], [0.122, 0.16, 0.07], 0.04, A);
  ell(BONE.spine, [0, 1.15, -0.035], [0.088, 0.12, 0.068], 0.04, A);
  for (const s of [-1, 1]) {
    ell(BONE.spine, [s * 0.082, 1.12, 0], [0.04, 0.08, 0.058], 0.04);
    ell(BONE.chest, [s * 0.11, 1.42, -0.02], [0.045, 0.12, 0.062], 0.04);
    cone(BONE.chest, [s * 0.04, 1.665, -0.03], [s * 0.16, 1.635, -0.02], 0.044, 0.034, 0.04);
    ell(BONE.hips, [s * 0.07, 0.95, -0.052], [0.072, 0.085, 0.062], 0.04, A);
  }
  cone(BONE.chest, [0, 1.6, -0.01], [0, 1.77, 0], 0.056, 0.045, 0.04);
  cone(BONE.head, [0, 1.77, 0], [0, 1.87, 0.01], 0.045, 0.041, 0.03);
  // helm: elongated skull sweeping back, tapered faceless front
  ell(BONE.head, [0, 1.955, -0.01], [0.079, 0.112, 0.097], 0.04, MAT.skin, [-0.3, 0, 0]);
  cone(BONE.head, [0, 1.99, -0.04], [0, 2.1, -0.19], 0.068, 0.018, 0.06);
  cone(BONE.head, [0, 1.95, 0.03], [0, 1.855, 0.068], 0.062, 0.025, 0.045);

  for (const s of [-1, 1]) {
    const L = s < 0;
    const sh = L ? BONE.shL : BONE.shR, el = L ? BONE.elL : BONE.elR, hd = L ? BONE.hdL : BONE.hdR;
    const th = L ? BONE.thL : BONE.thR, kn = L ? BONE.knL : BONE.knR, ft = L ? BONE.ftL : BONE.ftR;
    // arms
    ell(sh, [s * 0.205, 1.615, 0], [0.066, 0.08, 0.066], 0.05);
    cone(sh, [s * 0.215, 1.62, 0], [s * 0.225, 1.34, 0], 0.048, 0.037, 0.02);
    ell(sh, [s * 0.218, 1.47, 0.02], [0.036, 0.085, 0.035], 0.022);
    ell(sh, [s * 0.218, 1.5, -0.02], [0.036, 0.09, 0.035], 0.022);
    cone(el, [s * 0.225, 1.33, 0], [s * 0.233, 1.06, 0.005], 0.038, 0.025, 0.022);
    ell(el, [s * 0.228, 1.24, 0.008], [0.04, 0.075, 0.036], 0.022);
    ell(el, [s * 0.231, 1.13, 0.004], [0.032, 0.058, 0.031], 0.01, A);
    ell(hd, [s * 0.234, 1.0, 0.01], [0.02, 0.048, 0.038], 0.02);
    cone(hd, [s * 0.234, 0.98, 0.02], [s * 0.232, 0.92, 0.03], 0.019, 0.011, 0.018);
    cone(hd, [s * 0.226, 1.02, 0.036], [s * 0.222, 0.975, 0.05], 0.011, 0.008, 0.012);
    // legs
    cone(th, [s * 0.1, 0.94, 0], [s * 0.105, 0.52, 0.005], 0.078, 0.05, 0.03);
    ell(th, [s * 0.128, 0.74, 0.02], [0.045, 0.15, 0.05], 0.03);
    ell(th, [s * 0.085, 0.6, 0.032], [0.04, 0.08, 0.04], 0.03);
    ell(th, [s * 0.105, 0.76, -0.03], [0.054, 0.14, 0.048], 0.03, A);
    ell(kn, [s * 0.105, 0.49, 0.032], [0.038, 0.04, 0.03], 0.02);
    cone(kn, [s * 0.105, 0.49, 0], [s * 0.105, 0.09, -0.005], 0.048, 0.031, 0.03);
    ell(kn, [s * 0.105, 0.37, -0.033], [0.044, 0.1, 0.043], 0.03, A);
    cone(ft, [s * 0.105, 0.075, -0.02], [s * 0.105, 0.03, 0.14], 0.035, 0.021, 0.03);
    ell(ft, [s * 0.105, 0.045, -0.03], [0.034, 0.04, 0.04], 0.02);
  }

  // ---- surface details placed on the core: abs, pecs, visor slit and the eight spine nodes
  const core = new Sculpt(P);
  const surfZ = (x: number, y: number, dir: 1 | -1) => {
    for (let z = 0.3 * dir; Math.abs(z) > 0; z -= 0.002 * dir) if (core.sample(x, y, z) < 0) return z;
    return 0;
  };
  for (let r = 0; r < 3; r++) {
    for (const s of [-1, 1]) {
      const y = 1.11 + r * 0.066;
      ell(r < 2 ? BONE.spine : BONE.chest, [s * 0.032, y, surfZ(s * 0.032, y, 1) - 0.012], [0.028, 0.029, 0.018], 0.022);
    }
  }
  for (const s of [-1, 1]) ell(BONE.chest, [s * 0.066, 1.5, surfZ(s * 0.066, 1.5, 1) - 0.03], [0.068, 0.05, 0.04], 0.03, MAT.skin, [0, 0, s * 0.2]);
  for (let i = 0; i < 8; i++) {
    const y = 1.12 + i * 0.075;
    ell(y < 1.4 ? BONE.spine : BONE.chest, [0, y, surfZ(0, y, -1) + 0.005], [0.019, 0.016, 0.012], 0.006, MAT.glow);
  }

  const body = new Sculpt(P).mesh(0.011).geometry;
  // crest: tapered antler strands with a tine each, skinned along their bone chains
  const parts: THREE.BufferGeometry[] = [body];
  for (let s = 0; s < CREST_STRANDS; s++) {
    const chain = Array.from({ length: CREST_SEGS }, (_, k) => BONE.crest + s * CREST_SEGS + k);
    const pts = crestCurve(s);
    pts.unshift(pts[0].clone().add(V(0, -0.03, 0.03)));
    parts.push(skinnedTube(pts, (t) => 0.02 * (1 - t) + 0.004, chain, MAT.skin));
    const curve = new THREE.CatmullRomCurve3(crestCurve(s));
    const m = curve.getPointAt(0.55);
    const side = Math.sign(s - (CREST_STRANDS - 1) / 2) || 1;
    const tine = [m, m.clone().add(V(side * 0.04, 0.05, 0.01)), m.clone().add(V(side * 0.06, 0.11, 0.035))];
    parts.push(skinnedTube(tine, (t) => 0.008 * (1 - t) + 0.003, [chain[1]], MAT.skin, 5));
  }
  cached = mergeGeometries(parts, false)!;
  return cached;
}

export interface HeroLook {
  body: number;
  armor: number;
  vein: number;
  accent: number;
  dark: number;
}

export interface HeroUniforms {
  cSkin: N; cArmor: N; cGlow: N; cDark: N; cBlade: N; uT: N; uHurt: N;
}

export function heroUniforms(): HeroUniforms {
  return {
    cSkin: uniform(new THREE.Color()), cArmor: uniform(new THREE.Color()), cGlow: uniform(new THREE.Color()),
    cDark: uniform(new THREE.Color()), cBlade: uniform(new THREE.Color()), uT: uniform(0), uHurt: uniform(0),
  };
}

export function applyLook(u: HeroUniforms, l: HeroLook) {
  u.cSkin.value.set(l.body);
  u.cArmor.value.set(l.armor);
  u.cGlow.value.set(l.vein);
  u.cDark.value.set(l.dark);
  u.cBlade.value.set(l.accent);
}

/**
 * One material for the whole hero (body and Root-Blade): the per-vertex `aMat` id selects skin, violet armour,
 * bioluminescent node, dark wood or blade crystal. Emissive carries the Data-Stream veins (1.5 Hz pulse
 * flowing upward), spine-node pulses travelling up the back, a fresnel rim and the hurt flash.
 */
export function heroMaterial(u: HeroUniforms, veinScale = 1, veinGain = 1) {
  const m = new MeshStandardNodeMaterial();
  const mw: N = attribute('aMat', 'vec4');
  const wA: N = mw.x, wG: N = mw.y, wD: N = mw.z, wB: N = mw.w;
  const wS: N = clamp(float(1).sub(wA).sub(wG).sub(wD).sub(wB), 0, 1);
  m.colorNode = u.cSkin.mul(wS).add(u.cArmor.mul(wA)).add(u.cGlow.mul(wG)).add(u.cDark.mul(wD)).add(u.cBlade.mul(wB));
  m.roughnessNode = wS.mul(0.34).add(wA.mul(0.26)).add(wG.mul(0.2)).add(wD.mul(0.55)).add(wB.mul(0.12));
  m.metalnessNode = wS.mul(0.12).add(wA.mul(0.45)).add(wD.mul(0.1)).add(wB.mul(0.6));
  const o: N = positionGeometry.mul(veinScale);
  const hv = sin(o.y.mul(58).add(sin(o.x.mul(37).add(o.z.mul(23))).mul(2.4)).add(u.uT.mul(0.8)));
  const vein = smoothstep(0.965, 0.998, hv).mul(sin(o.x.mul(40).add(o.z.mul(31))).mul(0.45).add(0.55));
  const flow = sin(o.y.mul(18).sub(u.uT.mul(1.5 * 6.283))).mul(0.5).add(0.5);
  const skinVein = vein.mul(flow.mul(0.6).add(0.4)).mul(wS.mul(0.6).add(wA));
  const pulse = sin(u.uT.mul(1.5 * 6.283).sub(o.y.mul(14))).mul(0.5).add(0.5);
  m.emissiveNode = materialEmissive
    .add(u.cGlow.mul(skinVein.mul(0.9 * veinGain)))
    .add(u.cGlow.mul(wG.mul(pulse.mul(1.2).add(0.9))))
    .add(u.cBlade.mul(wB.mul(0.35)))
    .add(u.cGlow.mul(fresnel(2.6).mul(wS.add(wA).mul(0.3))))
    .add(vec3(1, 0.25, 0.35).mul(u.uHurt));
  return m;
}

let bladeCache: THREE.BufferGeometry | null = null;

/** The Root-Blade: twisted living-wood shaft with vine wraps, forked guard and a leaf-shaped crystal blade (+Y). */
export function rootBladeGeometry(): THREE.BufferGeometry {
  if (bladeCache) return bladeCache;
  const parts: THREE.BufferGeometry[] = [];
  const tag = (g: THREE.BufferGeometry, mat: number) => {
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) matWeights(mat, w, i * 4);
    g.setAttribute('aMat', new THREE.BufferAttribute(w, 4));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  tag(new THREE.CylinderGeometry(0.014, 0.017, 1.22, 7).translate(0, -0.01, 0), MAT.dark);
  // three vines twisting around the shaft
  for (let v = 0; v < 3; v++) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const a = v * 2.094 + t * 9;
      pts.push(new THREE.Vector3(Math.cos(a) * 0.02, -0.42 + t * 0.98, Math.sin(a) * 0.02));
    }
    tag(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.0065, 5), MAT.armor);
  }
  // forked guard: two hooked prongs flanking the blade root
  for (const s of [-1, 1]) {
    const pts = [new THREE.Vector3(0, 0.56, 0), new THREE.Vector3(s * 0.05, 0.6, 0), new THREE.Vector3(s * 0.065, 0.69, 0), new THREE.Vector3(s * 0.045, 0.76, 0)];
    tag(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.007, 5), MAT.dark);
  }
  // leaf blade
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  sh.bezierCurveTo(0.06, 0.08, 0.058, 0.3, 0, 0.56);
  sh.bezierCurveTo(-0.058, 0.3, -0.06, 0.08, 0, 0);
  const leaf = new THREE.ExtrudeGeometry(sh, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.008, bevelSegments: 2, curveSegments: 14 });
  leaf.translate(0, 0.58, -0.002);
  tag(leaf, MAT.blade);
  tag(new THREE.BoxGeometry(0.006, 0.42, 0.016).translate(0, 0.82, 0), MAT.glow);
  tag(new THREE.ConeGeometry(0.018, 0.1, 6).rotateX(Math.PI).translate(0, -0.66, 0), MAT.blade);
  bladeCache = mergeGeometries(parts, false)!;
  bladeCache.computeBoundingSphere();
  return bladeCache;
}
