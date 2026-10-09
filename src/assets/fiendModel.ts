import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sculpt, skinnedTube, MAT, type Prim, type MatId } from './sdf';

/**
 * Void-Root Fiend sculpt: a hunched, antlered husk of corrupted root-flesh with a thorned hump and a cavity in
 * the chest where its mycelial core (the weak point) glows. One skinned mesh on an 11-bone rig.
 * Materials: skin = flesh, armor = bark/thorn, glow = eyes, dark = hump.
 */
export const FB = { root: 0, torso: 1, head: 2, shL: 3, elL: 4, shR: 5, elR: 6, hipL: 7, knL: 8, hipR: 9, knR: 10 } as const;

const LAYOUT: [number, number, [number, number, number]][] = [
  [FB.root, -1, [0, 0, 0]],
  [FB.torso, FB.root, [0, 1.45, 0]],
  [FB.head, FB.torso, [0, 0.95, 0.28]],
  [FB.shL, FB.torso, [-0.8, 0.45, 0.05]],
  [FB.elL, FB.shL, [0, -1.0, 0]],
  [FB.shR, FB.torso, [0.8, 0.45, 0.05]],
  [FB.elR, FB.shR, [0, -1.0, 0]],
  [FB.hipL, FB.root, [-0.42, 1.0, 0]],
  [FB.knL, FB.hipL, [0, -0.9, 0]],
  [FB.hipR, FB.root, [0.42, 1.0, 0]],
  [FB.knR, FB.hipR, [0, -0.9, 0]],
];

export function buildFiendRig() {
  const bones: THREE.Bone[] = [];
  for (const [i, parent, p] of LAYOUT) {
    const b = new THREE.Bone();
    b.position.set(...p);
    bones[i] = b;
    if (parent >= 0) bones[parent].add(b);
  }
  bones[0].updateMatrixWorld(true);
  return { bones, skeleton: new THREE.Skeleton(bones) };
}

/** Chest-cavity centre of the weak point in torso space. */
export const FIEND_CORE = new THREE.Vector3(0, 0.05, 0.5);

let cached: THREE.BufferGeometry | null = null;

export function fiendGeometry(): THREE.BufferGeometry {
  if (cached) return cached;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const P: Prim[] = [];
  const cone = (bone: number, a: number[], b: number[], ra: number, rb: number, k: number, mat: MatId = MAT.skin) =>
    P.push({ bone, kind: 'cone', a: V(a[0], a[1], a[2]), b: V(b[0], b[1], b[2]), ra, rb, k, mat });
  const ell = (bone: number, c: number[], r: number[], k: number, mat: MatId = MAT.skin, sub = false) =>
    P.push({ bone, kind: 'ellipsoid', a: V(c[0], c[1], c[2]), ra: 0, radii: V(r[0], r[1], r[2]), k, mat, sub });
  const D = MAT.dark, T = MAT.armor;

  ell(FB.root, [0, 1.0, 0], [0.5, 0.36, 0.4], 0);
  ell(FB.torso, [0, 1.42, 0.02], [0.66, 0.74, 0.5], 0.2);
  ell(FB.torso, [0, 1.95, -0.35], [0.62, 0.52, 0.52], 0.2, D);
  cone(FB.torso, [0, 1.9, 0.12], [0, 2.32, 0.28], 0.26, 0.18, 0.15);
  // ribbed flanks
  for (let i = 0; i < 4; i++) {
    for (const s of [-1, 1]) cone(FB.torso, [s * 0.35, 1.2 + i * 0.16, 0.42], [s * 0.72, 1.12 + i * 0.16, 0.05], 0.05, 0.035, 0.06, T);
  }
  // head: long skull with a forward jaw and brow ridges
  ell(FB.head, [0, 2.42, 0.3], [0.26, 0.36, 0.36], 0.12, D);
  cone(FB.head, [0, 2.3, 0.42], [0, 2.12, 0.66], 0.17, 0.07, 0.1, D);
  for (const s of [-1, 1]) cone(FB.head, [s * 0.04, 2.52, 0.58], [s * 0.24, 2.55, 0.4], 0.05, 0.03, 0.05, T);
  for (const s of [-1, 1]) {
    const L = s < 0;
    const sh = L ? FB.shL : FB.shR, el = L ? FB.elL : FB.elR, hip = L ? FB.hipL : FB.hipR, kn = L ? FB.knL : FB.knR;
    ell(sh, [s * 0.78, 1.95, 0.05], [0.24, 0.22, 0.22], 0.15, T);
    cone(sh, [s * 0.8, 1.9, 0.05], [s * 0.8, 0.92, 0.05], 0.2, 0.13, 0.08);
    ell(sh, [s * 0.8, 1.45, 0.1], [0.13, 0.3, 0.12], 0.08);
    cone(el, [s * 0.8, 0.9, 0.05], [s * 0.8, -0.15, 0.05], 0.12, 0.08, 0.07, D);
    for (let i = -1; i <= 1; i++) cone(el, [s * 0.8 + i * 0.07, -0.12, 0.05], [s * 0.8 + i * 0.12, -0.62, 0.16], 0.05, 0.008, 0.04, T);
    cone(hip, [s * 0.42, 1.0, 0], [s * 0.42, 0.12, 0], 0.26, 0.16, 0.1);
    ell(hip, [s * 0.45, 0.6, 0.07], [0.2, 0.34, 0.19], 0.08);
    cone(kn, [s * 0.42, 0.1, 0], [s * 0.42, -0.8, 0], 0.17, 0.09, 0.07, D);
    ell(kn, [s * 0.42, -0.2, -0.08], [0.15, 0.24, 0.15], 0.07, D);
    for (let i = -1; i <= 1; i++) cone(kn, [s * 0.42 + i * 0.07, -0.78, 0.04], [s * 0.42 + i * 0.12, -0.9, 0.42], 0.06, 0.01, 0.04, T);
  }
  // hump thorns
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 1.4 - 0.7;
    const b = [Math.sin(a) * 0.55, 1.95 + (i % 3) * 0.18, -0.55 - Math.cos(a) * 0.1];
    const len = 0.5 + (i % 4) * 0.14;
    const d = new THREE.Vector3(Math.sin(a) * 0.7, 0.75, -0.75).normalize().multiplyScalar(len);
    cone(FB.torso, b, [b[0] + d.x, b[1] + d.y, b[2] + d.z], 0.09, 0.008, 0.05, T);
  }
  // chest cavity for the core, framed by thorn ribs
  ell(FB.torso, [0, 1.5, 0.66], [0.3, 0.32, 0.26], 0.08, MAT.skin, true);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const c = [Math.cos(a) * 0.36, 1.5 + Math.sin(a) * 0.36, 0.5];
    cone(FB.torso, c, [c[0] * 0.55, 1.5 + (c[1] - 1.5) * 0.55, 0.78], 0.05, 0.01, 0.03, T);
  }
  // eyes
  for (const s of [-1, 1]) ell(FB.head, [s * 0.12, 2.47, 0.6], [0.05, 0.035, 0.04], 0.01, MAT.glow);

  const body = new Sculpt(P).mesh(0.038).geometry;
  const parts = [body];
  for (let i = 0; i < 6; i++) {
    const side = i % 2 ? 1 : -1;
    const k = Math.floor(i / 2);
    const o = V(0, 2.4, 0.28);
    const pts = [
      V(side * 0.12, 0.2, -0.05), V(side * (0.3 + k * 0.1), 0.55 + k * 0.1, -0.12 - k * 0.08),
      V(side * (0.45 + k * 0.2), 0.95 + k * 0.15, -0.3 - k * 0.1), V(side * (0.4 + k * 0.28), 1.35 + k * 0.1, -0.5 - k * 0.1),
    ].map((p) => p.add(o));
    parts.push(skinnedTube(pts, (t) => (0.05 - k * 0.008) * (1 - 0.75 * t), [FB.head], MAT.armor, 6));
  }
  cached = mergeGeometries(parts, false)!;
  return cached;
}
