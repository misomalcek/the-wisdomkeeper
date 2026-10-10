import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sculpt, skinnedTube, MAT, type DetailFn } from './sdf';
import { Kit } from './sculptKit';
import { cellular, fbm } from './noise';
import { BONE } from './heroModel';
import fit from './hero-fit.json';

/**
 * The Wisdomkeeper's mycelial boots. The hero sculpt was generated from a reference cropped at the knees, so the
 * hero GLB ends just below them (scripts/assets/build-hero.mjs lifts the figure and fits knee and ankle joints;
 * `hero-fit.json` records them with the stump it left). These boots complete the legs: a cuff that swallows the
 * stump, a carapace knee guard, segmented shin plates over a fibrous underlayer, a lit ankle ring, an armoured
 * foot on a sole with a light seam (it flares on footfalls and while levitating), and living mycelial cords that
 * spiral down the shin and root out at the heel. Skinned to the knee (shin) and ankle (foot) bones in rig order.
 */

type V3 = [number, number, number];
const J = fit.joints as unknown as Record<string, V3>;
const STUMP = fit.stump as unknown as Record<'L' | 'R', { c: V3; rx: number; rz: number; top: { rx: number; rz: number } }>;

/** Carapace plates get shallow hex-scale seams; the fibrous underlayer gets vertical striations; cords get bark. */
const _c = { f1: 0, f2: 0 };
export const bootDetail: DetailFn = (x, y, z, mat) => {
  if (mat === MAT.armor) {
    cellular(x * 60, y * 40, z * 60, _c);
    return Math.max(0, 0.05 - (_c.f2 - _c.f1)) * 0.012 + fbm(x * 120, y * 120, z * 120, 2) * 0.0003;
  }
  if (mat === MAT.skin) {
    const a = Math.atan2(z, x) * 26 + fbm(x * 20, y * 6, z * 20, 2) * 3;
    return Math.abs(Math.sin(a)) * 0.0016 + fbm(x * 60, y * 140, z * 60, 2) * 0.0008;
  }
  if (mat === MAT.dark) return fbm(x * 70, y * 25, z * 70, 3) * 0.0025;
  return 0;
};

export interface BootQuality {
  cell?: number;
  detail?: boolean;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function boot(p: Kit, side: 'L' | 'R', tubes: THREE.BufferGeometry[], q: BootQuality) {
  const s = side === 'L' ? -1 : 1;
  const ft = J[`ft${side}`], st = STUMP[side];
  const KN = side === 'L' ? BONE.knL : BONE.knR;
  const FT = side === 'L' ? BONE.ftL : BONE.ftR;
  const A = MAT.armor, D = MAT.dark, G = MAT.glow, S = MAT.skin, B = MAT.blade;
  const cutY = st.c[1] - 0.03;
  const r0 = Math.max(st.rx, st.rz);
  const c0: V3 = [st.c[0], cutY, st.c[2]];
  const ank: V3 = [ft[0], ft[1] + 0.02, ft[2]];
  // cuff: a flared collar swallowing the stump, with a lit inner lip
  p.cone(KN, add(c0, [0, -0.05, 0]), add(c0, [0, 0.08, 0]), r0 + 0.01, r0 + 0.02, 0.015, A);
  p.cone(KN, add(c0, [0, 0.0, 0]), add(c0, [0, 0.12, 0]), r0 - 0.004, r0 + 0.008, 0, A, true);
  p.cyl(KN, add(c0, [0, 0.07, 0]), add(c0, [0, 0.076, 0]), r0 + 0.019, 0.003, G);
  // knee guard: a carapace shell over the front of the knee with a central ridge
  p.ell(KN, add(c0, [0, 0.0, st.rz + 0.02]), [0.06, 0.085, 0.032], 0.02, A, [-0.25, 0, 0]);
  p.cone(KN, add(c0, [0, 0.07, st.rz + 0.042]), add(c0, [0, -0.06, st.rz + 0.05]), 0.01, 0.007, 0.01, A);
  // fibrous underlayer down to the ankle, calf swelling behind
  p.cone(KN, add(c0, [0, -0.02, 0]), ank, r0 - 0.004, 0.052, 0.04, S);
  p.ell(KN, lerp(c0, ank, 0.28).map((v, i) => v + (i === 2 ? -0.03 : 0)) as V3, [0.068, 0.13, 0.066], 0.04, S);
  // segmented shin plates riding the front, tapering to the ankle
  for (let k = 0; k < 3; k++) {
    const t0 = 0.1 + k * 0.27, t1 = t0 + 0.24;
    const a = lerp(c0, ank, t0), b = lerp(c0, ank, t1);
    const w = 0.058 - k * 0.008;
    const zf = 0.05 - k * 0.01;
    p.box(KN, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + zf], [w, (a[1] - b[1]) / 2, 0.022], 0.012, 0.012, A, [-0.08, 0, 0]);
    // side flanges and the lit seam below each plate
    p.box(KN, [(a[0] + b[0]) / 2 + s * (w + 0.008), (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + zf - 0.02], [0.012, (a[1] - b[1]) / 2 - 0.01, 0.03], 0.006, 0.01, D);
    p.box(KN, [b[0], b[1] + 0.004, b[2] + zf + 0.012], [w * 0.7, 0.003, 0.012], 0.002, 0.004, G);
  }
  // ankle ring with a light seam
  p.cyl(FT, add(ank, [0, -0.03, 0]), add(ank, [0, 0.03, 0]), 0.064, 0.012, A);
  p.cyl(FT, add(ank, [0, -0.004, 0]), add(ank, [0, 0.004, 0]), 0.067, 0.002, G);
  // foot: heel, armoured instep, tapering toe cap
  const f0: V3 = [ft[0], 0, ft[2]];
  p.ell(FT, add(f0, [0, 0.055, -0.035]), [0.052, 0.05, 0.055], 0.03, A);
  p.ell(FT, add(f0, [0, 0.05, 0.07]), [0.056, 0.045, 0.12], 0.03, A, [0.18, 0, 0]);
  p.cone(FT, add(f0, [0, 0.04, 0.12]), add(f0, [0, 0.028, 0.215]), 0.044, 0.022, 0.025, A);
  // instep scales
  for (let k = 0; k < 3; k++) p.ell(FT, add(f0, [0, 0.088 - k * 0.012, 0.03 + k * 0.05]), [0.04 - k * 0.004, 0.012, 0.03], 0.01, A, [0.35, 0, 0]);
  // sole and its light seam
  p.box(FT, add(f0, [0, 0.016, 0.06]), [0.058, 0.016, 0.155], 0.012, 0.012, D);
  p.box(FT, add(f0, [0, 0.018, 0.06]), [0.0595, 0.0022, 0.1565], 0.002, 0.002, G);
  // bracket fungi growing on the cuff's outer back
  for (let k = 0; k < 3; k++) {
    const a = s * (1.9 + k * 0.4);
    const r = r0 + 0.035;
    p.ell(KN, add(c0, [Math.sin(a) * (r - 0.012), 0.02 - k * 0.06, Math.cos(a) * (r - 0.012) - 0.01]), [0.032 - k * 0.006, 0.008, 0.024], 0.012, B, [0, a, 0.15 * s]);
  }
  // mycelial cords spiralling down the shin and rooting out at the heel
  for (let c = 0; c < 3; c++) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const a = c * 2.1 + t * 3.6 * s + 2.4;
      const ctr = lerp(c0, ank, t * 0.98);
      const r = (r0 + 0.006) * (1 - t) + 0.058 * t;
      pts.push(new THREE.Vector3(ctr[0] + Math.sin(a) * r, ctr[1], ctr[2] + Math.cos(a) * r));
    }
    // over the ankle, then out along the ground at the heel
    const e = pts[pts.length - 1];
    const ox = Math.sin(c * 1.4 - 0.6) * s, oz = -Math.abs(Math.cos(c * 1.4 - 0.6));
    pts.push(new THREE.Vector3(e.x + ox * 0.04, 0.05, e.z + oz * 0.05), new THREE.Vector3(e.x + ox * 0.1, 0.012, e.z + oz * 0.12));
    const tube = skinnedTube(pts, (t) => 0.011 * (1 - t * 0.6), [KN, KN, KN, FT], MAT.dark, q.detail ? 7 : 5);
    tubes.push(tube);
    // glowing nodes along each cord
    for (let i = 3; i < 8; i += 3) p.ell(i < 6 ? KN : FT, [pts[i].x, pts[i].y, pts[i].z], [0.008, 0.008, 0.008], 0.003, G);
  }
}

const cache: { g?: THREE.BufferGeometry } = {};

/** Both boots, in hero model space, skinned in hero rig order. */
export function bootsGeometry(q: BootQuality = {}) {
  if (!q.cell && !q.detail && cache.g) return cache.g;
  const p = new Kit();
  const tubes: THREE.BufferGeometry[] = [];
  boot(p, 'L', tubes, q);
  boot(p, 'R', tubes, q);
  const body = new Sculpt(p.list, undefined, q.detail ? { detail: bootDetail, band: 0.012 } : {}).mesh(q.cell ?? 0.012).geometry;
  // tubes carry no occlusion; give them a mid value so they sit in the same shading
  for (const t of tubes) {
    const ao = new Float32Array(t.getAttribute('position').count * 2);
    for (let i = 0; i < ao.length; i += 2) ao[i] = 0.8;
    t.setAttribute('aAO', new THREE.BufferAttribute(ao, 2));
    t.deleteAttribute('uv');
  }
  const g = mergeGeometries([body, ...tubes], false)!;
  if (!q.cell && !q.detail) cache.g = g;
  return g;
}

/** The hero rig's first 17 bones at the fitted bind pose, named j{i} in rig order, for the bake's skin. */
export function buildBootRig() {
  const names = Object.keys(BONE).filter((n) => n !== 'crest') as (keyof typeof BONE)[];
  const PARENT: Record<string, string> = { hips: 'body', spine: 'hips', chest: 'spine', head: 'chest', thL: 'hips', knL: 'thL', ftL: 'knL', thR: 'hips', knR: 'thR', ftR: 'knR', shL: 'chest', elL: 'shL', hdL: 'elL', shR: 'chest', elR: 'shR', hdR: 'elR' };
  const bones: THREE.Bone[] = [];
  for (const n of names) {
    const b = new THREE.Bone();
    b.name = `j${BONE[n]}`;
    bones[BONE[n]] = b;
  }
  for (const n of names) {
    const b = bones[BONE[n]], par = PARENT[n];
    const w = J[n], pw = par ? J[par] : [0, 0, 0];
    b.position.set(w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]);
    if (par) bones[BONE[par as keyof typeof BONE]].add(b);
  }
  bones[0].updateMatrixWorld(true);
  return { bones };
}
