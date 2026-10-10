import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sculpt, skinnedTube, MAT, type Prim, type MatId, type DetailFn } from './sdf';
import { cellular, fbm, ridged } from './noise';

/**
 * Void-Root Fiend: a 3.4 m hunched brute of braided root-sinew and void-blackened bark. Rope-like cords wrap a
 * flesh core and climb from the pelvis over the chest into the shoulders; layered bark pauldrons and a plated
 * spine ridge armour its back, where void crystals have broken through the hump. The chest is a cavity caged
 * by root ribs around the glowing mycelial core (the weak point). Long arms end in four hooked root claws; the
 * head is an elongated bark skull with a split jaw, glowing slit eyes and a forked antler crown.
 * Materials: skin = sinew, armor = bark, glow = eyes/nodes, dark = bone-bark, blade = void crystal.
 * One skinned mesh on an 11-bone rig.
 */
export const FB = { root: 0, torso: 1, head: 2, shL: 3, elL: 4, shR: 5, elR: 6, hipL: 7, knL: 8, hipR: 9, knR: 10 } as const;

const LAYOUT: [number, number, [number, number, number]][] = [
  [FB.root, -1, [0, 0, 0]],
  [FB.torso, FB.root, [0, 1.45, 0]],
  [FB.head, FB.torso, [0, 0.95, 0.28]],
  [FB.shL, FB.torso, [-0.98, 0.45, 0.05]],
  [FB.elL, FB.shL, [0, -1.0, 0]],
  [FB.shR, FB.torso, [0.98, 0.45, 0.05]],
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
    b.name = `j${i}`;
    b.position.set(...p);
    bones[i] = b;
    if (parent >= 0) bones[parent].add(b);
  }
  bones[0].updateMatrixWorld(true);
  return { bones, skeleton: new THREE.Skeleton(bones) };
}

/** Chest-cavity centre of the weak point in torso space. */
export const FIEND_CORE = new THREE.Vector3(0, 0.05, 0.5);

const _c = { f1: 0, f2: 0 };

/**
 * Surface detail, carved into the field near the zero set: sinew striations and pores on flesh, deep
 * fibre-following fissures on bark, knotted grain on bone-bark, and conchoidal facets on crystal.
 */
export const fiendDetail: DetailFn = (x, y, z, mat) => {
  if (mat === MAT.skin) {
    // fine parallel fibres (limbs run along Y in the bind pose) over a soft pore grain
    const f = ridged(x * 34, y * 3.5, z * 34, 2);
    return f * f * 0.006 + fbm(x * 70, y * 70, z * 70, 2) * 0.0015 + fbm(x * 6, y * 6, z * 6, 2) * 0.006;
  }
  if (mat === MAT.armor) {
    cellular(x * 7.5, y * 1.8, z * 7.5, _c);
    const fissure = Math.max(0, 1 - (_c.f2 - _c.f1) / 0.11);
    return fissure * fissure * 0.022 + ridged(x * 26, y * 6, z * 26, 2) * 0.006 + fbm(x * 60, y * 60, z * 60, 2) * 0.002;
  }
  if (mat === MAT.dark) {
    const k = fbm(x * 9, y * 9, z * 9, 3);
    return Math.abs(k) * 0.012 + ridged(x * 34, y * 12, z * 34, 2) * 0.004;
  }
  if (mat === MAT.blade) {
    cellular(x * 9, y * 9, z * 9, _c);
    return _c.f1 * 0.012;
  }
  return 0;
};

export interface SculptQuality {
  /** Surface-nets cell size in metres. */
  cell?: number;
  /** Carve the surface detail function into the field (offline bakes). */
  detail?: boolean;
}

let cached: THREE.BufferGeometry | null = null;

export function fiendGeometry(q: SculptQuality = {}): THREE.BufferGeometry {
  const runtime = q.cell === undefined && q.detail === undefined;
  if (runtime && cached) return cached;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const P: Prim[] = [];
  const cone = (bone: number, a: number[], b: number[], ra: number, rb: number, k: number, mat: MatId = MAT.skin, sub = false) =>
    P.push({ bone, kind: 'cone', a: V(a[0], a[1], a[2]), b: V(b[0], b[1], b[2]), ra, rb, k, mat, sub });
  const ell = (bone: number, c: number[], r: number[], k: number, mat: MatId = MAT.skin, sub = false, rot?: number[]) =>
    P.push({ bone, kind: 'ellipsoid', a: V(c[0], c[1], c[2]), ra: 0, radii: V(r[0], r[1], r[2]), rot: rot ? new THREE.Euler(rot[0], rot[1], rot[2]) : undefined, k, mat, sub });
  const box = (bone: number, c: number[], h: number[], round: number, k: number, mat: MatId, rot?: number[]) =>
    P.push({ bone, kind: 'box', a: V(c[0], c[1], c[2]), ra: round, radii: V(h[0], h[1], h[2]), rot: rot ? new THREE.Euler(rot[0], rot[1], rot[2]) : undefined, k, mat });
  /** A cord through control points (Catmull-Rom), as chained round cones tapering r0 → r1. */
  const cord = (bone: number | ((t: number) => number), pts: number[][], r0: number, r1: number, k: number, mat: MatId, seg = 6) => {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => V(p[0], p[1], p[2])));
    let prev = curve.getPointAt(0);
    for (let i = 1; i <= seg; i++) {
      const t = i / seg;
      const p = curve.getPointAt(t);
      const b = typeof bone === 'number' ? bone : bone(t - 0.5 / seg);
      P.push({ bone: b, kind: 'cone', a: prev.clone(), b: p.clone(), ra: r0 + (r1 - r0) * (t - 1 / seg), rb: r0 + (r1 - r0) * t, k, mat });
      prev = p;
    }
  };
  /** `n` strands twisting round the axis a→b (radius `w`), like braided roots. */
  const braid = (bone: number | ((t: number) => number), a: number[], b: number[], w: number, r: number, n: number, turns: number, mat: MatId, phase = 0, taper = 0.7) => {
    const A = V(a[0], a[1], a[2]), B = V(b[0], b[1], b[2]);
    const ax = B.clone().sub(A);
    const u = new THREE.Vector3(1, 0, 0).cross(ax).normalize();
    if (u.lengthSq() < 0.1) u.set(0, 0, 1);
    const v = ax.clone().cross(u).normalize();
    for (let s = 0; s < n; s++) {
      const pts: number[][] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const ang = phase + (s / n) * Math.PI * 2 + t * turns * Math.PI * 2;
        const ww = w * (1 - t * (1 - taper));
        const p = A.clone().addScaledVector(ax, t).addScaledVector(u, Math.cos(ang) * ww).addScaledVector(v, Math.sin(ang) * ww);
        pts.push([p.x, p.y, p.z]);
      }
      cord(bone, pts, r, r * taper, 0.03, mat, 8);
    }
  };
  const S = MAT.skin, A = MAT.armor, D = MAT.dark, G = MAT.glow, C = MAT.blade;

  // ---- pelvis, belly and torso core
  ell(FB.root, [0, 1.02, -0.02], [0.46, 0.3, 0.36], 0);
  cone(FB.torso, [0, 1.12, 0.02], [0, 1.5, 0.04], 0.36, 0.5, 0.18);
  ell(FB.torso, [0, 1.5, 0.0], [0.6, 0.62, 0.46], 0.16);
  ell(FB.torso, [0, 1.88, -0.04], [0.8, 0.4, 0.5], 0.22);
  // the hump: bone-bark mass the crystals break through
  ell(FB.torso, [0, 2.0, -0.38], [0.6, 0.5, 0.5], 0.2, D);
  ell(FB.torso, [0, 1.62, -0.42], [0.46, 0.42, 0.36], 0.16, D);
  // sinew cords: pelvis → over the chest → into the shoulders (and their mirror over the back)
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const o = i * 0.1;
      cord(FB.torso, [[s * (0.16 + o), 1.0, 0.3 - o * 0.4], [s * (0.36 + o), 1.42, 0.44 - o * 0.3], [s * (0.56 + o * 0.6), 1.82, 0.32], [s * 0.78, 2.02, 0.06 - o]], 0.07 - i * 0.008, 0.06, 0.05, S);
      cord(FB.torso, [[s * (0.2 + o), 1.1, -0.3], [s * (0.42 + o), 1.5, -0.48], [s * (0.62 + o * 0.5), 1.9, -0.36], [s * 0.82, 2.0, -0.08]], 0.065, 0.055, 0.05, S);
    }
    // obliques: diagonal ropes across the flanks
    for (let i = 0; i < 4; i++) cord(FB.torso, [[s * 0.38, 1.05 + i * 0.16, 0.24], [s * 0.56, 1.2 + i * 0.16, 0.0], [s * 0.46, 1.35 + i * 0.16, -0.3]], 0.045, 0.035, 0.035, A);
  }
  // pectoral and trapezius masses give the chest a top-heavy, muscled silhouette
  for (const s of [-1, 1]) {
    ell(FB.torso, [s * 0.3, 1.8, 0.3], [0.3, 0.2, 0.18], 0.1, S, false, [0, 0, s * -0.25]);
    cone(FB.torso, [s * 0.12, 2.2, 0.0], [s * 0.72, 2.0, 0.02], 0.2, 0.16, 0.14, S);
  }
  // chest cavity for the core, caged by root ribs lying along the chest wall
  ell(FB.torso, [0, 1.5, 0.62], [0.3, 0.33, 0.28], 0.07, S, true);
  for (let i = 0; i < 4; i++) {
    const y = 1.26 + i * 0.15;
    const rx = 0.58 - Math.abs(i - 1.5) * 0.04, rz = 0.4;
    for (const s of [-1, 1]) {
      const pts: number[][] = [];
      for (let k = 0; k <= 4; k++) {
        const th = 0.12 + (k / 4) * 1.15;
        pts.push([s * rx * Math.sin(th), y - 0.05 + k * 0.02, 0.14 + rz * Math.cos(th)]);
      }
      cord(FB.torso, pts, 0.04, 0.026, 0.03, D, 8);
    }
  }
  cone(FB.torso, [0, 1.22, 0.62], [0, 1.84, 0.62], 0.05, 0.04, 0.03, D); // sternum root
  // shoulder pauldrons: three overlapping bark plates per side
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) box(FB.torso, [s * (0.72 + i * 0.05), 2.12 - i * 0.12, 0.02 - i * 0.04], [0.26 - i * 0.03, 0.05, 0.3 - i * 0.03], 0.035, 0.04, A, [0.1, 0, s * (0.42 + i * 0.12)]);
  }
  // spine ridge: overlapping bark scales down the hump, flanked by knotted burls and climbing roots
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const y = 2.42 - t * 1.3, z = -0.56 - Math.sin(t * Math.PI) * 0.34;
    ell(FB.torso, [0, y, z], [0.2 - t * 0.07, 0.11, 0.06], 0.04, A, false, [-1.0 + t * 1.5, 0, 0]);
  }
  const burls = [[-0.38, 2.1, -0.66, 0.12], [0.42, 1.95, -0.66, 0.1], [-0.3, 1.55, -0.74, 0.09], [0.28, 1.7, -0.78, 0.11], [0.0, 2.36, -0.5, 0.1], [-0.5, 1.8, -0.5, 0.08], [0.55, 2.2, -0.42, 0.08]];
  for (const [x, y, z, r] of burls) ell(FB.torso, [x, y, z], [r, r * 0.8, r * 0.7], 0.06, D);
  for (const s of [-1, 1]) {
    cord(FB.torso, [[s * 0.1, 2.45, -0.4], [s * 0.4, 2.25, -0.68], [s * 0.6, 1.9, -0.62], [s * 0.66, 1.5, -0.42]], 0.05, 0.03, 0.025, A, 10);
    cord(FB.torso, [[s * 0.2, 2.3, -0.6], [s * 0.25, 1.8, -0.86], [s * 0.42, 1.35, -0.66]], 0.04, 0.025, 0.025, A, 8);
  }
  // void crystals erupting from the hump
  const crystals = [[-0.32, 2.2, -0.62, -0.5, 0.8, -0.5, 0.55], [0.36, 2.15, -0.66, 0.5, 0.7, -0.55, 0.5], [-0.12, 2.35, -0.55, -0.15, 1, -0.3, 0.7], [0.16, 2.3, -0.7, 0.2, 0.85, -0.6, 0.62], [-0.48, 1.9, -0.6, -0.8, 0.4, -0.5, 0.42], [0.5, 1.85, -0.62, 0.8, 0.35, -0.55, 0.45], [0, 2.05, -0.86, 0, 0.5, -0.9, 0.48]];
  for (const [x, y, z, dx, dy, dz, len] of crystals) {
    const d = V(dx, dy, dz).normalize().multiplyScalar(len);
    cone(FB.torso, [x, y, z], [x + d.x, y + d.y, z + d.z], 0.085, 0.01, 0.015, C);
    // two smaller shards splayed from the same root
    for (const [a, l] of [[0.5, 0.5], [-0.6, 0.38]]) {
      const e = d.clone().normalize().applyAxisAngle(V(0, 0, 1), a).applyAxisAngle(V(1, 0, 0), -a * 0.5).multiplyScalar(len * l);
      cone(FB.torso, [x, y, z], [x + e.x, y + e.y, z + e.z], 0.05, 0.008, 0.01, C);
    }
  }

  // ---- head: elongated bark skull, split jaw, slit eyes, root teeth
  cone(FB.head, [0, 2.0, 0.14], [0, 2.36, 0.42], 0.24, 0.15, 0.12, S);
  ell(FB.head, [0, 2.48, 0.42], [0.2, 0.2, 0.3], 0.1, D);
  cone(FB.head, [0, 2.48, 0.6], [0, 2.38, 0.94], 0.13, 0.055, 0.06, D);
  ell(FB.head, [0, 2.58, 0.52], [0.24, 0.07, 0.16], 0.05, D); // brow ridge
  cone(FB.head, [0, 2.3, 0.46], [0, 2.2, 0.86], 0.1, 0.045, 0.06, D); // jaw
  ell(FB.head, [0, 2.32, 0.7], [0.13, 0.025, 0.24], 0.015, D, true); // mouth split
  for (const s of [-1, 1]) {
    ell(FB.head, [s * 0.11, 2.5, 0.7], [0.07, 0.03, 0.06], 0.02, D, true, [0, s * 0.3, 0]); // eye sockets
    ell(FB.head, [s * 0.11, 2.5, 0.69], [0.05, 0.016, 0.035], 0.005, G, false, [0, s * 0.3, 0]);
    for (let i = 0; i < 4; i++) cone(FB.head, [s * (0.03 + i * 0.025), 2.33, 0.86 - i * 0.07], [s * (0.035 + i * 0.025), 2.27, 0.84 - i * 0.07], 0.012, 0.003, 0.004, A);
    ell(FB.head, [s * 0.17, 2.4, 0.42], [0.06, 0.12, 0.14], 0.06, A); // cheek plates
  }

  // ---- arms: deltoid, braided sinew upper arm, bark-root forearm, four hooked claws
  for (const s of [-1, 1]) {
    const sh = s < 0 ? FB.shL : FB.shR, el = s < 0 ? FB.elL : FB.elR;
    const x = s * 0.98;
    ell(sh, [x - s * 0.06, 1.92, 0.05], [0.3, 0.26, 0.26], 0.14, S);
    cone(sh, [x, 1.85, 0.05], [x, 0.98, 0.05], 0.15, 0.12, 0.08, S);
    braid(sh, [x, 1.8, 0.05], [x, 0.95, 0.05], 0.11, 0.07, 4, 0.5, S, s);
    ell(sh, [x, 1.4, 0.13], [0.13, 0.28, 0.12], 0.07, S); // biceps
    ell(el, [x, 0.9, 0.0], [0.15, 0.13, 0.15], 0.06, A); // elbow knot
    cone(el, [x, 0.88, 0.05], [x, -0.1, 0.06], 0.1, 0.075, 0.06, D);
    braid(el, [x, 0.86, 0.05], [x, -0.08, 0.06], 0.1, 0.055, 5, 0.8, A, s * 2, 0.8);
    for (let i = 0; i < 2; i++) box(el, [x + s * 0.02, 0.55 - i * 0.32, 0.12], [0.11, 0.12, 0.05], 0.025, 0.03, A, [0.15, 0, 0]); // bracers
    ell(el, [x, -0.18, 0.08], [0.17, 0.12, 0.12], 0.06, D); // knuckles
    for (let f = 0; f < 4; f++) {
      const fx = x + (f - 1.5) * 0.085 * s;
      cord(el, [[fx, -0.2, 0.14], [fx + s * (f - 1.5) * 0.03, -0.42, 0.24], [fx + s * (f - 1.5) * 0.05, -0.62, 0.22], [fx + s * (f - 1.5) * 0.06, -0.74, 0.08]], 0.042, 0.006, 0.02, f % 2 ? A : D, 7);
    }
    cord(el, [[x - s * 0.12, -0.12, 0.04], [x - s * 0.2, -0.32, 0.14], [x - s * 0.18, -0.48, 0.18]], 0.035, 0.006, 0.02, D, 5); // thumb
  }

  // ---- legs: corded thigh, bark knee, braided root shin, splayed root toes
  for (const s of [-1, 1]) {
    const hip = s < 0 ? FB.hipL : FB.hipR, kn = s < 0 ? FB.knL : FB.knR;
    const x = s * 0.42;
    ell(hip, [x, 0.72, 0.04], [0.28, 0.4, 0.28], 0.12, S);
    braid(hip, [x, 1.0, 0.0], [x, 0.15, 0.0], 0.18, 0.09, 4, 0.4, S, s * 0.7);
    ell(kn, [x, 0.1, 0.1], [0.16, 0.14, 0.13], 0.05, A); // knee cap
    cone(kn, [x, 0.08, 0], [x, -0.72, 0.0], 0.14, 0.09, 0.07, D);
    braid(kn, [x, 0.05, -0.02], [x, -0.72, 0.02], 0.12, 0.06, 5, 0.7, A, s, 0.75);
    ell(kn, [x, -0.2, -0.1], [0.14, 0.24, 0.13], 0.06, S); // calf
    ell(kn, [x, -0.78, 0.06], [0.16, 0.08, 0.2], 0.06, D); // foot
    for (let i = -1; i <= 1; i++) cord(kn, [[x + i * 0.07, -0.78, 0.14], [x + i * 0.12, -0.84, 0.34], [x + i * 0.16, -0.9, 0.48]], 0.05, 0.008, 0.025, A, 5);
    cord(kn, [[x, -0.76, -0.1], [x, -0.84, -0.28]], 0.04, 0.008, 0.02, A, 3); // heel spur
  }

  const cell = q.cell ?? 0.038;
  const body = new Sculpt(P, undefined, q.detail ? { detail: fiendDetail, band: 0.05 } : {}).mesh(cell).geometry;
  const parts = [body];
  // antler crown: forked root tines rigid on the head
  const radial = q.detail ? 10 : 6;
  for (let i = 0; i < 6; i++) {
    const side = i % 2 ? 1 : -1;
    const k = Math.floor(i / 2);
    const o = V(0, 2.5, 0.36);
    const pts = [
      V(side * 0.12, 0.08, -0.05), V(side * (0.3 + k * 0.1), 0.45 + k * 0.1, -0.12 - k * 0.08),
      V(side * (0.45 + k * 0.2), 0.85 + k * 0.15, -0.3 - k * 0.1), V(side * (0.4 + k * 0.28), 1.25 + k * 0.1, -0.5 - k * 0.1),
    ].map((p) => p.add(o));
    const r0 = 0.05 - k * 0.008;
    parts.push(skinnedTube(pts, (t) => r0 * (1 - 0.8 * t), [FB.head], MAT.armor, radial));
    // a fork off each tine
    const c = new THREE.CatmullRomCurve3(pts);
    const m = c.getPointAt(0.5);
    parts.push(skinnedTube([m, m.clone().add(V(side * 0.18, 0.16, 0.06)), m.clone().add(V(side * 0.26, 0.36, 0.02))], (t) => r0 * 0.55 * (1 - 0.8 * t), [FB.head], MAT.armor, radial));
  }
  const out = mergeGeometries(parts, false)!;
  if (runtime) cached = out;
  return out;
}
