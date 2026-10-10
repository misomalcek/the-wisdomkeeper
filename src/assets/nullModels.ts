import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sculpt, skinnedTube, MAT, type Prim, type MatId, type DetailFn } from './sdf';
import { cellular, fbm } from './noise';
import { Kit } from './sculptKit';

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
  cyl(bone: number, a: number[], b: number[], r: number, k: number, mat: MatId, sub = false) {
    this.list.push({ bone, kind: 'cyl', a: V(a[0], a[1], a[2]), b: V(b[0], b[1], b[2]), ra: r, k, mat, sub });
  }
  box(bone: number, c: number[], h: number[], round: number, k: number, mat: MatId, rot?: number[], sub = false) {
    this.list.push({ bone, kind: 'box', a: V(c[0], c[1], c[2]), ra: round, radii: V(h[0], h[1], h[2]), rot: rot ? new THREE.Euler(rot[0], rot[1], rot[2]) : undefined, k, mat, sub });
  }
}

const cache = new Map<string, THREE.BufferGeometry>();
const once = (key: string, build: () => THREE.BufferGeometry) => {
  let g = cache.get(key);
  if (!g) cache.set(key, (g = build()));
  return g;
};

/**
 * Surface detail for the Null's machines: irregular Voronoi panel seams and pitted corrosion on armour plate,
 * machined grooves on the dark under-structure, conchoidal facets on crystal.
 */
const _c = { f1: 0, f2: 0 };
export const nullDetail = (scale: number): DetailFn => (x, y, z, mat) => {
  const k = 1 / scale;
  if (mat === MAT.armor) {
    // planar panel seams: the plate is cut by three families of planes, ~30 cm apart at scale 1
    const f = (v: number) => {
      const t = ((v % 1) + 1) % 1;
      return Math.min(t, 1 - t);
    };
    const e = Math.min(f(x * 3.3 * k + 0.13), f(y * 3.3 * k + 0.41), f(z * 3.3 * k + 0.77));
    const seam = Math.max(0, 1 - e / 0.02);
    const wear = Math.max(0, fbm(x * 22 * k, y * 22 * k, z * 22 * k, 3) - 0.3);
    return seam * 0.005 * scale + wear * 0.006 * scale;
  }
  if (mat === MAT.skin) {
    // weathered basalt: broad chips and fine grit
    cellular(x * 2.4 * k, y * 2.4 * k, z * 2.4 * k, _c);
    return _c.f1 * 0.02 * scale + fbm(x * 30 * k, y * 30 * k, z * 30 * k, 2) * 0.004 * scale;
  }
  if (mat === MAT.dark) {
    const g = Math.abs(((y * 14 * k) % 1 + 1) % 1 - 0.5);
    return Math.max(0, 0.08 - g) * 0.05 * scale + fbm(x * 30 * k, y * 30 * k, z * 30 * k, 2) * 0.002 * scale;
  }
  if (mat === MAT.blade) {
    cellular(x * 6 * k, y * 6 * k, z * 6 * k, _c);
    return _c.f1 * 0.02 * scale;
  }
  return 0;
};

export interface MachineQuality {
  cell?: number;
  detail?: boolean;
}

const rigid = (g: THREE.BufferGeometry) => {
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  return g;
};

/**
 * Null-Sentry Drone (≈1.6 m): a segmented corroded-steel pod in magnetic suspension. Six armour shells with
 * open seams wrap a dark core; the red Null-optic sits deep in a ringed socket forward (+Z) under a hooded brow;
 * side thruster pods glow from their nozzles; a crown of antenna spines trails back; three jointed spike legs
 * fold beneath, and the Core Power Resonator shows as a belt of lit slots. Unskinned: the drone is rigid; its
 * suspension rings are separate spinning meshes.
 */
export function droneGeometry(q: MachineQuality = {}) {
  const build = () => {
    const p = new Prims();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow;
    p.ell(0, [0, 0, 0], [0.58, 0.4, 0.6], 0, D);
    // six armour shells around the core, with seams between them
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      p.box(0, [Math.sin(a) * 0.42, 0.14, Math.cos(a) * 0.42], [0.26, 0.2, 0.08], 0.05, 0, A, [0.5, a, 0]);
    }
    p.ell(0, [0, 0.3, -0.04], [0.44, 0.16, 0.46], 0.08, A); // dorsal cap
    p.box(0, [0, 0.42, -0.1], [0.08, 0.06, 0.32], 0.03, 0.04, A); // dorsal spine
    // hooded brow and the optic socket
    p.box(0, [0, 0.26, 0.42], [0.36, 0.07, 0.16], 0.05, 0.05, A, [-0.35, 0, 0]);
    p.cyl(0, [0, 0.02, 0.3], [0, 0.02, 0.66], 0.27, 0.04, D);
    p.cyl(0, [0, 0.02, 0.52], [0, 0.02, 0.8], 0.21, 0.01, D, true);
    p.cyl(0, [0, 0.02, 0.48], [0, 0.02, 0.6], 0.17, 0.005, A); // inner ring
    p.cyl(0, [0, 0.02, 0.55], [0, 0.02, 0.8], 0.13, 0.005, D, true);
    p.ell(0, [0, 0.02, 0.57], [0.11, 0.11, 0.05], 0.01, G);
    // resonator belt: lit slots in a dark band
    p.ell(0, [0, -0.06, 0], [0.62, 0.07, 0.62], 0.03, D);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      p.box(0, [Math.sin(a) * 0.61, -0.06, Math.cos(a) * 0.61], [0.05, 0.025, 0.03], 0.01, 0.005, G, [0, a, 0]);
    }
    // side thruster pods
    for (const s of [-1, 1]) {
      p.box(0, [s * 0.66, 0.04, -0.12], [0.12, 0.14, 0.26], 0.06, 0.06, A);
      p.cyl(0, [s * 0.66, 0.04, -0.3], [s * 0.66, 0.04, -0.48], 0.11, 0.02, D);
      p.cyl(0, [s * 0.66, 0.04, -0.4], [s * 0.66, 0.04, -0.6], 0.08, 0.005, D, true);
      p.ell(0, [s * 0.66, 0.04, -0.36], [0.07, 0.07, 0.03], 0.005, G);
    }
    // antenna spines trailing back
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 0.09;
      p.cone(0, [x, 0.36, -0.3], [x * 1.6, 0.56 - Math.abs(i - 2) * 0.05, -0.9 + Math.abs(i - 2) * 0.1], 0.025, 0.006, 0.02, D);
    }
    // three jointed spike legs folded beneath
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 3;
      const c = [Math.sin(a), Math.cos(a)];
      const j0 = [c[0] * 0.3, -0.3, c[1] * 0.3], j1 = [c[0] * 0.62, -0.5, c[1] * 0.62], j2 = [c[0] * 0.5, -1.0, c[1] * 0.5];
      p.ell(0, j0, [0.08, 0.08, 0.08], 0.04, A);
      p.cone(0, j0, j1, 0.06, 0.045, 0.03, D);
      p.ell(0, j1, [0.06, 0.06, 0.06], 0.02, A);
      p.cone(0, j1, j2, 0.045, 0.008, 0.02, D);
    }
    return rigid(new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(0.5), band: 0.03 } : {}).mesh(q.cell ?? 0.022).geometry);
  };
  return q.cell || q.detail ? build() : once('drone', build);
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
 * Void-Infused Construct: a Null-grown colossus. A skeleton of braided black root-cable is armoured in violet
 * plate; a cage of cable ribs holds the chest cavity where the Void-Integrated Resonance Core hangs; the
 * pauldrons are eruptions of void crystal; the forearms end in plated hammer fists with crystal knuckles; a low
 * plated helm carries one slit optic under a crystal crown; and on its back two conduit sockets take the
 * data-river beams from the arena pylons. One skinned mesh.
 */
export function constructGeometry(q: MachineQuality = {}) {
  const build = () => {
    const p = new Kit();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow, C = MAT.blade, S = MAT.skin;
    // ---- legs: braided cable columns in plated greaves, rooted toes
    p.ell(CB.root, [0, 2.75, -0.05], [1.2, 0.62, 0.82], 0, D);
    for (const s of [-1, 1]) {
      const hip = s < 0 ? CB.hipL : CB.hipR;
      const x0 = s * 0.95, x1 = s * 1.15, x2 = s * 1.25;
      p.cone(hip, [x0, 2.6, 0], [x1, 0.95, 0.1], 0.46, 0.36, 0.2, D);
      p.braid(hip, [x0, 2.7, 0], [x1, 0.95, 0.1], 0.42, 0.17, 5, 0.6, D, s);
      p.cone(hip, [x1, 0.95, 0.1], [x2, 0.12, 0.2], 0.38, 0.46, 0.15, D);
      p.braid(hip, [x1, 1.0, 0.1], [x2, 0.15, 0.2], 0.4, 0.15, 5, 0.5, D, -s);
      // thigh plate, knee guard, greave
      p.box(hip, [s * 1.06, 1.95, 0.42], [0.42, 0.55, 0.12], 0.06, 0.06, A, [0.1, s * 0.25, 0]);
      p.box(hip, [x1, 1.05, 0.52], [0.36, 0.26, 0.14], 0.08, 0.05, A, [-0.3, s * 0.15, 0]);
      p.box(hip, [s * 1.2, 0.55, 0.5], [0.38, 0.32, 0.1], 0.05, 0.05, A, [0.12, s * 0.2, 0]);
      for (let t = -1; t <= 1; t++) p.cord(hip, [[x2 + t * 0.2, 0.25, 0.4], [x2 + t * 0.45, 0.1, 0.85], [x2 + t * 0.6, -0.08, 1.15 - Math.abs(t) * 0.2]], 0.2, 0.05, 0.08, D, 5);
      p.cord(hip, [[x2, 0.2, -0.2], [x2, 0.0, -0.75]], 0.18, 0.05, 0.06, D, 3);
    }
    // plated skirt over the pelvis
    for (let i = 0; i < 7; i++) {
      const a = ((i - 3) / 3) * 1.25;
      p.box(CB.root, [Math.sin(a) * 1.15, 2.55, Math.cos(a) * 0.8], [0.3, 0.38, 0.08], 0.05, 0.03, A, [0.25, a, 0]);
    }
    // ---- torso: dark core, cable ribcage round the cavity, plated chest and back
    p.ell(CB.torso, [0, 3.55, 0], [1.05, 0.6, 0.72], 0.3, D);
    p.ell(CB.torso, [0, 4.4, -0.1], [1.65, 1.15, 1.05], 0.35, D);
    p.ell(CB.torso, [0, 5.1, -0.55], [1.45, 0.85, 0.85], 0.3, D);
    p.ell(CB.torso, [0, 4.1, 0.95], [0.8, 0.92, 0.7], 0.22, S, undefined, true);
    for (let i = 0; i < 5; i++) {
      const y = 3.45 + i * 0.36;
      for (const s of [-1, 1]) {
        const pts: number[][] = [];
        for (let k = 0; k <= 4; k++) {
          const th = 0.15 + (k / 4) * 1.25;
          pts.push([s * 1.45 * Math.sin(th), y - 0.1 + k * 0.05, 0.05 + 1.0 * Math.cos(th)]);
        }
        p.cord(CB.torso, pts, 0.12, 0.08, 0.06, D, 8);
      }
    }
    p.cyl(CB.torso, [0, 3.3, 1.0], [0, 5.0, 1.0], 0.1, 0.05, D); // sternum cable
    for (const s of [-1, 1]) {
      p.box(CB.torso, [s * 0.85, 5.15, 0.55], [0.62, 0.42, 0.16], 0.08, 0.08, A, [-0.35, s * 0.35, s * -0.15]); // chest plates
      p.box(CB.torso, [s * 0.95, 4.4, -0.95], [0.6, 0.6, 0.14], 0.08, 0.08, A, [0.2, s * -0.4, 0]); // back plates
      // conduit sockets on the back (data-river beams attach here)
      p.cyl(CB.torso, [s * 0.7, 5.25, -1.15], [s * 0.95, 6.0, -1.65], 0.34, 0.12, A);
      p.cyl(CB.torso, [s * 0.88, 5.8, -1.52], [s * 1.0, 6.2, -1.8], 0.24, 0.02, D, true);
      p.ell(CB.torso, [s * 0.9, 5.85, -1.55], [0.2, 0.2, 0.2], 0.02, G);
    }
    // spine of void crystals
    for (let i = 0; i < 6; i++) {
      const y = 3.6 + i * 0.42;
      const z = -1.0 - Math.sin((i / 5) * Math.PI) * 0.25;
      p.cone(CB.torso, [0, y, z], [0, y + 0.35, z - 0.7 + i * 0.05], 0.2, 0.02, 0.05, C);
    }
    // ---- arms: crystal-erupting pauldrons, cable upper arms, plated hammer fists
    for (const s of [-1, 1]) {
      const sh = s < 0 ? CB.shL : CB.shR, el = s < 0 ? CB.elL : CB.elR;
      p.ell(sh, [s * 1.95, 5.1, 0], [0.75, 0.68, 0.72], 0.3, D);
      p.box(sh, [s * 2.0, 5.55, 0.0], [0.8, 0.16, 0.85], 0.1, 0.1, A, [0, 0, s * 0.35]);
      p.box(sh, [s * 2.3, 5.15, 0.0], [0.55, 0.14, 0.75], 0.08, 0.08, A, [0, 0, s * 0.85]);
      const shards = [[0, 0, 1.4, 0.3], [0.35, 0.3, 1.1, 0.24], [-0.3, -0.25, 1.0, 0.22], [0.5, -0.35, 0.8, 0.2], [-0.15, 0.45, 0.9, 0.2], [0.25, 0.05, 0.6, 0.16]];
      for (const [dx, dz, len, r] of shards) {
        const b = [s * (1.95 + dx), 5.6, dz];
        p.cone(sh, b, [b[0] + s * (0.4 + dx * 0.6) * len, b[1] + len, b[2] + dz * 0.8 * len], r, 0.02, 0.04, C);
      }
      p.cone(sh, [s * 1.95, 4.9, 0], [s * 2.15, 3.25, 0.2], 0.42, 0.34, 0.2, D);
      p.braid(sh, [s * 1.95, 4.8, 0], [s * 2.15, 3.3, 0.2], 0.36, 0.13, 4, 0.5, D, s);
      p.box(sh, [s * 2.12, 4.0, 0.42], [0.34, 0.5, 0.12], 0.06, 0.05, A, [0.12, s * 0.2, 0]); // bicep plate
      p.ell(el, [s * 2.18, 3.2, 0.2], [0.42, 0.38, 0.42], 0.12, A); // elbow
      p.cone(el, [s * 2.18, 3.15, 0.25], [s * 2.3, 1.75, 0.6], 0.4, 0.5, 0.18, D);
      p.box(el, [s * 2.26, 2.45, 0.5], [0.5, 0.62, 0.5], 0.12, 0.12, A, [0.25, 0, 0]); // forearm gauntlet
      p.box(el, [s * 2.32, 1.35, 0.72], [0.62, 0.5, 0.6], 0.12, 0.1, A, [0.25, 0, 0]); // hammer fist
      for (let k = -1; k <= 1; k++) p.cone(el, [s * 2.32 + k * 0.32, 1.2, 1.15], [s * 2.32 + k * 0.38, 1.0, 1.7], 0.16, 0.02, 0.05, C);
      p.cone(el, [s * 2.32, 1.3, 0.72], [s * (2.32 + 0.75), 1.5, 0.72], 0.14, 0.02, 0.05, C); // side spike
    }
    // ---- head: low plated helm, slit optic, horns
    p.cone(CB.head, [0, 5.5, 0.1], [0, 5.95, 0.4], 0.5, 0.42, 0.2, D);
    p.box(CB.head, [0, 6.05, 0.45], [0.5, 0.36, 0.55], 0.14, 0.12, A);
    p.box(CB.head, [0, 6.05, 1.0], [0.36, 0.07, 0.2], 0.02, 0.02, D, undefined, true);
    p.box(CB.head, [0, 6.05, 0.92], [0.32, 0.04, 0.06], 0.02, 0.01, G);
    p.box(CB.head, [0, 6.42, 0.55], [0.4, 0.08, 0.45], 0.05, 0.06, A, [-0.2, 0, 0]); // brow plate
    for (const s of [-1, 1]) p.cone(CB.head, [s * 0.4, 6.3, 0.25], [s * 1.0, 7.3, -0.45], 0.16, 0.025, 0.08, C);
    const body = new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(2.2), band: 0.07 } : {}).mesh(q.cell ?? 0.075).geometry;
    // crown filaments of crystal
    const parts = [body];
    for (let i = 0; i < 5; i++) {
      const a = (i / 4 - 0.5) * 1.6;
      parts.push(skinnedTube([V(Math.sin(a) * 0.3, 6.4, 0.2), V(Math.sin(a) * 0.55, 7.0, -0.1), V(Math.sin(a) * 0.7, 7.6, -0.5)], (t) => 0.09 * (1 - t) + 0.015, [CB.head], MAT.glow, q.detail ? 10 : 5));
    }
    return mergeGeometries(parts, false)!;
  };
  return q.cell || q.detail ? build() : once('construct', build);
}

/**
 * Integrated Data-River Pylon (≈6 m): a cluster of basalt columns bound by Null steel bands, split by a glowing
 * data channel, with root cables gripping the ground and a crown cradle holding the conduit lens that beams
 * power to the Construct. Unskinned.
 */
export function dataPylonGeometry(q: MachineQuality = {}) {
  const build = () => {
    const p = new Prims();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow, S = MAT.skin;
    // plinth
    p.cyl(0, [0, -0.3, 0], [0, 0.32, 0], 1.2, 0, D);
    p.cyl(0, [0, 0.3, 0], [0, 0.4, 0], 1.08, 0.02, A);
    p.box(0, [0, 0.5, 0], [0.95, 0.18, 0.95], 0.08, 0.1, A, [0, 0.4, 0]);
    // basalt columns: hexagonal-ish prisms of differing heights leaning in
    const cols = [[0, 0, 5.0, 0.36], [0.42, 0.18, 4.2, 0.28], [-0.4, 0.22, 4.5, 0.3], [0.12, -0.44, 3.8, 0.27], [-0.2, -0.38, 4.0, 0.26], [0.46, -0.3, 3.2, 0.22], [-0.5, -0.12, 3.5, 0.24]];
    for (const [x, z, h, r] of cols) {
      for (let k = 0; k < 3; k++) p.box(0, [x * (1 - k * 0.08), 0.5 + (h / 3) * (k + 0.5), z * (1 - k * 0.08)], [r, h / 6 - 0.03, r * 0.88], 0.04, 0.015, S, [0, (x + z) * 3 + k * 0.5, x * 0.06]);
      p.cone(0, [x * 0.76, 0.5 + h, z * 0.76], [x * 0.7, 0.5 + h + r * 0.9, z * 0.7], r * 0.8, 0.02, 0.03, S); // weathered tip
    }
    // steel bands binding the cluster
    for (const y of [1.3, 2.6, 3.7]) p.cyl(0, [0, y, 0], [0, y + 0.2, 0], 0.86 - y * 0.08, 0.02, A);
    // the data channel: a cut down the front and back, lit inside
    for (const s of [-1, 1]) {
      p.box(0, [0, 2.8, s * 0.52], [0.09, 2.2, 0.3], 0.02, 0.02, D, [s * -0.06, 0, 0], true);
      p.box(0, [0, 2.8, s * 0.36], [0.05, 2.1, 0.05], 0.02, 0.01, G, [s * -0.06, 0, 0]);
    }
    // root cables gripping the ground
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      const c = [Math.sin(a), Math.cos(a)];
      p.cone(0, [c[0] * 0.8, 1.0, c[1] * 0.8], [c[0] * 1.35, 0.35, c[1] * 1.35], 0.12, 0.1, 0.06, D);
      p.cone(0, [c[0] * 1.35, 0.35, c[1] * 1.35], [c[0] * 1.9, -0.1, c[1] * 1.9], 0.1, 0.04, 0.05, D);
    }
    // crown cradle: four claws around the conduit lens
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const c = [Math.sin(a), Math.cos(a)];
      p.cone(0, [c[0] * 0.25, 5.2, c[1] * 0.25], [c[0] * 0.62, 5.6, c[1] * 0.62], 0.1, 0.07, 0.05, A);
      p.cone(0, [c[0] * 0.62, 5.6, c[1] * 0.62], [c[0] * 0.38, 6.15, c[1] * 0.38], 0.07, 0.02, 0.03, A);
    }
    p.ell(0, [0, 5.62, 0], [0.34, 0.34, 0.34], 0.02, G);
    return rigid(new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(1.4), band: 0.05 } : {}).mesh(q.cell ?? 0.05).geometry);
  };
  return q.cell || q.detail ? build() : once('dataPylon', build);
}
