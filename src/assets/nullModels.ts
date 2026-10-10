import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sculpt, skinnedTube, MAT, type Prim, type MatId } from './sdf';

/**
 * Sculpts for the Null's machines (Asset Pipeline blueprint entries `null_sentinel_drone`, the Void-Infused
 * Construct and its Integrated Data-River Pylons). All three come out of the same SDF kernel as the hero.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

class Prims {
  readonly list: Prim[] = [];
  cone(bone: number, a: number[], b: number[], ra: number, rb: number, k: number, mat: MatId = MAT.skin, sub = false) {
    this.list.push({ bone, kind: 'cone', a: V(a[0], a[1], a[2]), b: V(b[0], b[1], b[2]), ra, rb, k, mat, sub });
  }
  ell(bone: number, c: number[], r: number[], k: number, mat: MatId = MAT.skin, rot?: number[], sub = false) {
    this.list.push({ bone, kind: 'ellipsoid', a: V(c[0], c[1], c[2]), ra: 0, radii: V(r[0], r[1], r[2]), rot: rot ? new THREE.Euler(rot[0], rot[1], rot[2]) : undefined, k, mat, sub });
  }
}

const cache = new Map<string, THREE.BufferGeometry>();
const once = (key: string, build: () => THREE.BufferGeometry) => {
  let g = cache.get(key);
  if (!g) cache.set(key, (g = build()));
  return g;
};

/**
 * Null-Sentry Drone (≈1.6 m): a corroded-steel lens pod held in magnetic suspension, its red Null-optic sensor
 * forward (+Z), the Core Power Resonator as a glowing belt, and three spike-deployment vanes hanging beneath.
 * Unskinned: the drone is rigid; its suspension rings are separate spinning meshes.
 */
export function droneGeometry() {
  return once('drone', () => {
    const p = new Prims();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow;
    p.ell(0, [0, 0, 0], [0.62, 0.36, 0.62], 0);
    p.ell(0, [0, 0.2, -0.05], [0.48, 0.26, 0.52], 0.12, A);
    // armoured brow shielding the optic
    p.cone(0, [-0.34, 0.2, 0.34], [0.34, 0.2, 0.34], 0.1, 0.1, 0.08, A);
    // optic socket carved into the front, with the lens inside
    p.ell(0, [0, 0.02, 0.6], [0.26, 0.2, 0.2], 0.05, MAT.skin, undefined, true);
    p.ell(0, [0, 0.02, 0.5], [0.17, 0.14, 0.1], 0.02, G);
    // resonator belt
    p.ell(0, [0, -0.02, 0], [0.66, 0.06, 0.66], 0.03, D);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      p.ell(0, [Math.sin(a) * 0.63, -0.02, Math.cos(a) * 0.63], [0.06, 0.035, 0.06], 0.01, G);
    }
    // rear fins
    for (const s of [-1, 1]) p.cone(0, [s * 0.3, 0.12, -0.45], [s * 0.62, 0.32, -0.85], 0.09, 0.02, 0.06, A);
    // spike-deployment vanes
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const x = Math.sin(a) * 0.32, z = Math.cos(a) * 0.32;
      p.cone(0, [x, -0.2, z], [x * 1.6, -0.95, z * 1.6], 0.08, 0.012, 0.06, D);
    }
    const g = new Sculpt(p.list).mesh(0.022).geometry;
    g.deleteAttribute('skinIndex');
    g.deleteAttribute('skinWeight');
    return g;
  });
}

/** Thin torus used for the drone's magnetic suspension rings and the construct's halo. */
export function ringGeometry(r: number, tube: number) {
  return once(`ring${r}:${tube}`, () => new THREE.TorusGeometry(r, tube, 6, 48));
}

/** Rig for the Void-Infused Construct (≈7 m): a Void-Infused Skeleton of 9 bones. */
export const CB = { root: 0, torso: 1, head: 2, shL: 3, elL: 4, shR: 5, elR: 6, hipL: 7, hipR: 8 } as const;
const C_LAYOUT: [number, number, [number, number, number]][] = [
  [CB.root, -1, [0, 0, 0]],
  [CB.torso, CB.root, [0, 3.6, 0]],
  [CB.head, CB.torso, [0, 2.3, 0.35]],
  [CB.shL, CB.torso, [-1.9, 1.5, 0]],
  [CB.elL, CB.shL, [-0.25, -1.9, 0.2]],
  [CB.shR, CB.torso, [1.9, 1.5, 0]],
  [CB.elR, CB.shR, [0.25, -1.9, 0.2]],
  [CB.hipL, CB.root, [-0.95, 2.6, 0]],
  [CB.hipR, CB.root, [0.95, 2.6, 0]],
];
/** Resonance core in torso space (the exposed weak point). */
export const CONSTRUCT_CORE = new THREE.Vector3(0, 0.5, 0.95);

export function buildConstructRig() {
  const bones: THREE.Bone[] = [];
  for (const [i, parent, pos] of C_LAYOUT) {
    const b = new THREE.Bone();
    b.position.set(...pos);
    bones[i] = b;
    if (parent >= 0) bones[parent].add(b);
  }
  bones[0].updateMatrixWorld(true);
  return { bones, skeleton: new THREE.Skeleton(bones) };
}

/**
 * Void-Infused Construct: a Null-grown colossus — bark-black skeleton armoured in violet crystal plates, ribs
 * caging a chest cavity where the Void-Integrated Resonance Core hangs, crystal crown, and conduit sockets on its
 * back where the data-river beams from the arena pylons plug in. One skinned mesh.
 */
export function constructGeometry() {
  return once('construct', () => {
    const p = new Prims();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow;
    // pelvis and legs (columnar, rooted)
    p.ell(CB.root, [0, 2.7, 0], [1.25, 0.7, 0.85], 0);
    for (const s of [-1, 1]) {
      const hip = s < 0 ? CB.hipL : CB.hipR;
      p.cone(hip, [s * 0.95, 2.6, 0], [s * 1.15, 0.9, 0.1], 0.62, 0.48, 0.25, D);
      p.cone(hip, [s * 1.15, 0.9, 0.1], [s * 1.25, 0.05, 0.2], 0.5, 0.62, 0.2, D);
      // root toes splaying into the ground
      for (let t = -1; t <= 1; t++) p.cone(hip, [s * 1.25, 0.25, 0.2], [s * 1.25 + t * 0.55, -0.05, 0.9 + Math.abs(t) * -0.2], 0.2, 0.06, 0.12, D);
      p.ell(hip, [s * 1.05, 1.9, 0.25], [0.55, 0.65, 0.45], 0.15, A);
    }
    // torso: ribcage around a hollow core
    p.ell(CB.torso, [0, 4.2, -0.1], [1.7, 1.6, 1.1], 0.4);
    p.ell(CB.torso, [0, 5.0, -0.7], [1.55, 1.1, 0.9], 0.35, A);
    p.ell(CB.torso, [0, 4.1, 0.95], [0.82, 0.95, 0.7], 0.25, MAT.skin, undefined, true);
    for (let i = 0; i < 4; i++) {
      for (const s of [-1, 1]) p.cone(CB.torso, [s * 0.25, 3.5 + i * 0.42, 1.05], [s * 1.35, 3.4 + i * 0.4, 0.45], 0.13, 0.08, 0.1, D);
    }
    // conduit sockets on the back (data-river beams attach here)
    for (const s of [-1, 1]) p.cone(CB.torso, [s * 0.7, 5.2, -1.2], [s * 0.95, 6.1, -1.7], 0.32, 0.18, 0.15, D);
    for (const s of [-1, 1]) p.ell(CB.torso, [s * 0.95, 6.15, -1.72], [0.2, 0.2, 0.2], 0.04, G);
    // shoulders: crystal pauldrons
    for (const s of [-1, 1]) {
      const sh = s < 0 ? CB.shL : CB.shR, el = s < 0 ? CB.elL : CB.elR;
      p.ell(sh, [s * 1.95, 5.15, 0], [0.85, 0.75, 0.8], 0.3, A);
      for (let k = 0; k < 3; k++) p.cone(sh, [s * (1.8 + k * 0.25), 5.6, -0.2 + k * 0.2], [s * (2.2 + k * 0.5), 6.8 - k * 0.3, -0.4 + k * 0.25], 0.22, 0.03, 0.1, A);
      p.cone(sh, [s * 1.95, 5.0, 0], [s * 2.15, 3.2, 0.2], 0.48, 0.38, 0.2);
      p.cone(el, [s * 2.15, 3.2, 0.2], [s * 2.3, 1.55, 0.6], 0.42, 0.55, 0.2, D);
      // hammer fist with crystal knuckles
      p.ell(el, [s * 2.32, 1.35, 0.7], [0.6, 0.55, 0.6], 0.15, A);
      for (let k = -1; k <= 1; k++) p.cone(el, [s * 2.32 + k * 0.25, 1.2, 1.1], [s * 2.32 + k * 0.32, 1.0, 1.6], 0.14, 0.02, 0.06, G);
    }
    // head: low, horned, single slit optic
    p.ell(CB.head, [0, 6.0, 0.4], [0.55, 0.5, 0.6], 0.3, D);
    p.ell(CB.head, [0, 6.05, 0.95], [0.32, 0.06, 0.08], 0.03, G);
    for (const s of [-1, 1]) p.cone(CB.head, [s * 0.35, 6.3, 0.2], [s * 1.0, 7.4, -0.5], 0.16, 0.03, 0.08, A);
    const body = new Sculpt(p.list).mesh(0.075).geometry;
    // crown filaments of crystal
    const parts = [body];
    for (let i = 0; i < 5; i++) {
      const a = (i / 4 - 0.5) * 1.6;
      parts.push(skinnedTube([V(Math.sin(a) * 0.3, 6.4, 0.2), V(Math.sin(a) * 0.55, 7.0, -0.1), V(Math.sin(a) * 0.7, 7.6, -0.5)], (t) => 0.09 * (1 - t) + 0.015, [CB.head], MAT.glow, 5));
    }
    return mergeGeometries(parts, false)!;
  });
}

/**
 * Integrated Data-River Pylon (≈6 m): a basalt obelisk split by a glowing data channel, crowned with a conduit
 * lens that beams power to the Construct. Unskinned.
 */
export function dataPylonGeometry() {
  return once('dataPylon', () => {
    const p = new Prims();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow;
    p.cone(0, [0, 0, 0], [0, 0.6, 0], 1.1, 0.95, 0, D);
    p.cone(0, [0, 0.5, 0], [0, 5.2, 0], 0.62, 0.32, 0.2);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      p.cone(0, [Math.sin(a) * 0.55, 0.4, Math.cos(a) * 0.55], [Math.sin(a) * 0.3, 4.4, Math.cos(a) * 0.3], 0.2, 0.08, 0.1, A);
    }
    // data channel carved down the front and back, lit
    for (const s of [-1, 1]) p.cone(0, [0, 0.9, s * 0.62], [0, 4.6, s * 0.35], 0.1, 0.06, 0.03, G);
    p.ell(0, [0, 5.6, 0], [0.5, 0.5, 0.5], 0.15, A);
    p.ell(0, [0, 5.6, 0], [0.34, 0.34, 0.34], 0.02, G);
    const g = new Sculpt(p.list).mesh(0.05).geometry;
    g.deleteAttribute('skinIndex');
    g.deleteAttribute('skinWeight');
    return g;
  });
}
