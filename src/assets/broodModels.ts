import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sculpt, skinnedTube, MAT, type MatId } from './sdf';
import { Kit } from './sculptKit';
import { nullDetail, type MachineQuality } from './nullModels';

/**
 * The Null's second brood: creatures grown from the same SDF kernel as the first, each built around a piece of
 * "infinite mathematics" so the deeper strata feel stranger. The Lattice Stalker carries a branching
 * iterated-function crest, the Spore Bloater's pores follow the golden-angle phyllotaxis of a sunflower head, the
 * Root Lasher's trunk is a twisted helix braid, and the Fractal Prism is a Sierpinski tetrahedron.
 */

const cache = new Map<string, THREE.BufferGeometry>();
const once = (key: string, q: MachineQuality, build: () => THREE.BufferGeometry) => {
  if (q.cell || q.detail) return build();
  let g = cache.get(key);
  if (!g) cache.set(key, (g = build()));
  return g;
};
const rigid = (g: THREE.BufferGeometry) => {
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  return g;
};
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

type Layout = [number, number, [number, number, number]][];
function rigFrom(layout: Layout) {
  const bones: THREE.Bone[] = [];
  for (const [i, parent, p] of layout) {
    const b = new THREE.Bone();
    b.name = `j${i}`;
    b.position.set(...p);
    bones[i] = b;
    if (parent >= 0) bones[parent].add(b);
  }
  bones[0].updateMatrixWorld(true);
  return { bones, skeleton: new THREE.Skeleton(bones) };
}

/**
 * A branching crystal: one shard, then two children from its tip turned ±`spread` and twisted by the golden angle,
 * `depth` times over (an iterated function system, so every branch is a smaller copy of the whole).
 */
function crystalTree(p: Kit, bone: number, from: THREE.Vector3, dir: THREE.Vector3, len: number, depth: number, mat: MatId, spread = 0.55, twist = 0) {
  const tip = from.clone().addScaledVector(dir, len);
  p.cone(bone, [from.x, from.y, from.z], [tip.x, tip.y, tip.z], len * 0.13, 0.008, 0.012, mat);
  if (depth <= 0) return;
  const side = new THREE.Vector3(0, 1, 0).cross(dir);
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize().applyAxisAngle(dir, twist);
  for (const s of [-1, 1]) {
    const d = dir.clone().applyAxisAngle(side, s * spread).normalize();
    crystalTree(p, bone, from.clone().addScaledVector(dir, len * 0.72), d, len * 0.6, depth - 1, mat, spread, twist + GOLDEN);
  }
}

// ---------------------------------------------------------------------------------------------
// Lattice Stalker
// ---------------------------------------------------------------------------------------------

/** Lattice Stalker rig: root, body, head and six two-bone legs (hip then knee), front to back, left then right. */
export const SB = { root: 0, body: 1, head: 2, hip: (leg: number) => 3 + leg * 2, knee: (leg: number) => 4 + leg * 2 } as const;
const LEG_Z = [0.45, 0, -0.5];
const legSide = (leg: number) => (leg % 2 ? 1 : -1);
const legZ = (leg: number) => LEG_Z[Math.floor(leg / 2)];

function stalkerLayout(): Layout {
  const L: Layout = [
    [0, -1, [0, 0, 0]],
    [1, 0, [0, 0.95, 0]],
    [2, 1, [0, 0.05, 0.8]],
  ];
  for (let leg = 0; leg < 6; leg++) {
    const s = legSide(leg), z = legZ(leg);
    L.push([SB.hip(leg), 1, [s * 0.38, -0.05, z]]);
    L.push([SB.knee(leg), SB.hip(leg), [s * 0.62, 0.32, z * 0.25]]);
  }
  return L;
}
export const buildStalkerRig = () => rigFrom(stalkerLayout());

/** Foot of a leg in model space (bind pose). */
export const stalkerFoot = (leg: number) => V(legSide(leg) * 1.45, 0, legZ(leg) * 1.6);

/**
 * Lattice Stalker (≈2.4 m long): a six-legged crystalline hunter. A plated thorax and a swollen abdomen carry a
 * crest of branching void-crystal; the wedge head has three pairs of lit eyes and hooked mandibles; the lit
 * core glows under the abdomen. Long jointed legs splay wide like a harvestman's. One skinned mesh, 15 bones.
 */
export function stalkerGeometry(q: MachineQuality = {}) {
  return once('stalker', q, () => {
    const p = new Kit();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow, S = MAT.skin, C = MAT.blade;
    const B = 1, H = 2;
    // thorax, waist, abdomen
    p.ell(B, [0, 0.98, 0.2], [0.4, 0.28, 0.52], 0.08, A);
    p.ell(B, [0, 0.96, -0.3], [0.22, 0.2, 0.22], 0.12, S);
    p.ell(B, [0, 1.06, -0.82], [0.4, 0.34, 0.62], 0.1, S, [-0.18, 0, 0]);
    p.ell(B, [0, 0.82, -0.8], [0.22, 0.1, 0.3], 0.04, G); // the lit core under the abdomen
    // dorsal plates
    for (let i = 0; i < 6; i++) {
      const z = 0.55 - i * 0.3;
      const y = 1.24 + Math.sin((i / 5) * Math.PI) * 0.12;
      p.box(B, [0, y, z], [0.24 - Math.abs(i - 2.5) * 0.03, 0.04, 0.14], 0.03, 0.05, A, [0.15, 0, 0]);
    }
    // ventral ribs on the abdomen
    for (let i = 0; i < 5; i++) {
      const z = -0.45 - i * 0.18;
      p.cyl(B, [-0.36, 0.95, z], [0.36, 0.95, z], 0.035, 0.05, D);
    }
    // the crest: five branching crystal trees along the spine, leaning back
    for (let i = 0; i < 5; i++) {
      const z = 0.4 - i * 0.32;
      const lean = V(Math.sin(i * 2.1) * 0.25, 1, -0.5 - i * 0.08).normalize();
      crystalTree(p, B, V(0, 1.25 + Math.sin((i / 4) * Math.PI) * 0.1, z), lean, 0.62 - Math.abs(i - 1.5) * 0.05, 2, C, 0.6, i * GOLDEN);
    }
    // head: a wedge with a hooded brow, three pairs of eyes, mandibles
    p.ell(H, [0, 1.0, 0.86], [0.24, 0.18, 0.3], 0.06, A);
    p.box(H, [0, 1.12, 0.9], [0.2, 0.04, 0.2], 0.03, 0.04, D, [-0.35, 0, 0]);
    for (let k = 0; k < 3; k++) {
      for (const s of [-1, 1]) p.ell(H, [s * (0.08 + k * 0.05), 1.07 - k * 0.03, 1.1 - k * 0.07], [0.035 - k * 0.006, 0.035 - k * 0.006, 0.02], 0.004, G);
    }
    for (const s of [-1, 1]) {
      p.cord(H, [[s * 0.12, 0.92, 1.0], [s * 0.24, 0.86, 1.28], [s * 0.18, 0.8, 1.5], [s * 0.04, 0.78, 1.58]], 0.05, 0.008, 0.02, D, 7);
      p.cone(H, [s * 0.2, 0.9, 1.2], [s * 0.3, 0.98, 1.32], 0.025, 0.004, 0.01, C);
    }
    // legs
    for (let leg = 0; leg < 6; leg++) {
      const s = legSide(leg), z = legZ(leg);
      const hip = [s * 0.38, 0.9, z], knee = [s * 1.0, 1.22, z * 1.25];
      const f = stalkerFoot(leg);
      const foot = [f.x, f.y, f.z];
      const hb = SB.hip(leg), kb = SB.knee(leg);
      p.ell(hb, hip, [0.11, 0.1, 0.11], 0.05, A);
      p.cone(hb, hip, knee, 0.075, 0.05, 0.04, A);
      p.ell(kb, knee, [0.07, 0.07, 0.07], 0.03, D);
      const mid = [(knee[0] + foot[0]) / 2, (knee[1] + foot[1]) / 2, (knee[2] + foot[2]) / 2];
      p.cone(kb, knee, mid, 0.05, 0.035, 0.02, D);
      p.cone(kb, mid, [foot[0], foot[1] + 0.02, foot[2]], 0.035, 0.01, 0.015, D);
      // a crystal spur off each shin
      p.cone(kb, mid, [mid[0] + s * 0.18, mid[1] + 0.2, mid[2]], 0.03, 0.004, 0.01, C);
      p.ell(kb, mid, [0.045, 0.045, 0.045], 0.02, G);
    }
    return new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(0.45), band: 0.025 } : {}).mesh(q.cell ?? 0.03).geometry;
  });
}

// ---------------------------------------------------------------------------------------------
// Spore Bloater
// ---------------------------------------------------------------------------------------------

/**
 * Spore Bloater (≈1.8 m across): a drifting fungal gas-sac. Lobed hide crossed by dark veins; 55 lit pores laid out
 * by the golden angle (Vogel's sunflower spiral, wrapped on the sphere); a fringe of gill lamellae underneath and
 * a curtain of hyphal tendrils. Rigid: it swells and pulses as a whole.
 */
export function bloaterGeometry(q: MachineQuality = {}) {
  return once('bloater', q, () => {
    const p = new Kit();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow, S = MAT.skin;
    const R = 0.82;
    p.ell(0, [0, 0, 0], [R, R * 0.92, R], 0, S);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      p.ell(0, [Math.cos(a) * 0.42, 0.1 + (i % 2) * 0.12, Math.sin(a) * 0.42], [0.48, 0.42, 0.48], 0.18, S);
    }
    // golden-angle pores over the upper 80 % of the sphere
    const n = 55;
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 1.6;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = i * GOLDEN;
      const d = V(Math.cos(a) * r, y * 0.92, Math.sin(a) * r).normalize();
      const c = d.clone().multiplyScalar(R * 1.06);
      const s = 0.045 + 0.03 * (1 - Math.abs(y));
      p.ell(0, [c.x, c.y, c.z], [s * 1.3, s * 1.3, s * 1.3], 0.03, D);
      c.copy(d).multiplyScalar(R * 1.1);
      p.ell(0, [c.x, c.y, c.z], [s, s, s], 0.01, G);
    }
    // veins: meridians from the crown down to the gills
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      const pts: number[][] = [];
      for (let k = 0; k <= 5; k++) {
        const t = 0.1 + (k / 5) * 0.75;
        const th = t * Math.PI;
        const w = Math.sin(th * 3 + i) * 0.12;
        pts.push([Math.cos(a + w) * Math.sin(th) * (R + 0.08), Math.cos(th) * R * 0.95, Math.sin(a + w) * Math.sin(th) * (R + 0.08)]);
      }
      p.cord(0, pts, 0.04, 0.025, 0.05, D, 10);
    }
    // crown cap
    p.ell(0, [0, R * 0.9, 0], [0.22, 0.1, 0.22], 0.08, A);
    p.cone(0, [0, R * 0.95, 0], [0.04, R * 1.3, -0.03], 0.06, 0.01, 0.03, D);
    // gill lamellae fringe
    p.ell(0, [0, -R * 0.78, 0], [0.5, 0.12, 0.5], 0.1, D);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      p.box(0, [Math.cos(a) * 0.46, -R * 0.84, Math.sin(a) * 0.46], [0.24, 0.07, 0.012], 0.008, 0.01, A, [0, -a, 0.25]);
    }
    p.ell(0, [0, -R * 0.84, 0], [0.18, 0.06, 0.18], 0.02, G);
    const body = rigid(new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(0.4), band: 0.025 } : {}).mesh(q.cell ?? 0.03).geometry);
    const parts = [body];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.3;
      const r0 = 0.32 + (i % 3) * 0.08;
      const len = 0.9 + ((i * 5) % 4) * 0.18;
      const pts = [V(Math.cos(a) * r0, -R * 0.8, Math.sin(a) * r0), V(Math.cos(a) * r0 * 1.1, -R - len * 0.3, Math.sin(a) * r0 * 1.1), V(Math.cos(a + 0.4) * r0 * 0.9, -R - len * 0.65, Math.sin(a + 0.4) * r0 * 0.9), V(Math.cos(a + 0.7) * r0 * 1.05, -R - len, Math.sin(a + 0.7) * r0 * 1.05)];
      parts.push(rigid(skinnedTube(pts, (t) => 0.035 * (1 - t) + 0.006, [0], i % 3 ? MAT.dark : MAT.glow, q.detail ? 8 : 5)));
    }
    return mergeGeometries(parts, false)!;
  });
}

// ---------------------------------------------------------------------------------------------
// Root Lasher
// ---------------------------------------------------------------------------------------------

/** Root Lasher rig: root, three trunk segments and the head, a chain it whips along. */
export const LB = { root: 0, s1: 1, s2: 2, s3: 3, head: 4 } as const;
const LASHER: Layout = [
  [0, -1, [0, 0, 0]],
  [1, 0, [0, 0.9, 0]],
  [2, 1, [0, 0.8, 0]],
  [3, 2, [0, 0.7, 0.05]],
  [4, 3, [0, 0.55, 0.12]],
];
export const buildLasherRig = () => rigFrom(LASHER);
const lasherBone = (h: number) => (h < 0.9 ? LB.root : h < 1.7 ? LB.s1 : h < 2.4 ? LB.s2 : LB.s3);
/** Throat centre in head space: where the root spikes are spat from. */
export const LASHER_THROAT = V(0, 0.15, 0.08);

/**
 * Root Lasher (≈3.4 m): a burrowing carnivorous bloom. Five root strands twist round a sinew core into a trunk
 * (a tapered helix), studded with thorns; the head is a bulb whose five armoured jaw-petals open around a lit
 * throat ringed with crystal teeth. A flare of roots grips the ground. One skinned mesh on a 5-bone chain.
 */
export function lasherGeometry(q: MachineQuality = {}) {
  return once('lasher', q, () => {
    const p = new Kit();
    const A = MAT.armor, D = MAT.dark, G = MAT.glow, S = MAT.skin, C = MAT.blade;
    const TOP = 2.6;
    const axis = (h: number) => V(0, h, Math.max(0, h - 1.7) * 0.15);
    // sinew core
    for (let h = 0; h < TOP; h += 0.3) {
      const a = axis(h), b = axis(Math.min(TOP, h + 0.3));
      p.cone(lasherBone(h + 0.15), [a.x, a.y, a.z], [b.x, b.y, b.z], 0.26 - h * 0.05, 0.26 - (h + 0.3) * 0.05, 0.08, S);
    }
    // five twisting strands: a helix whose radius tapers with height
    for (let s = 0; s < 5; s++) {
      const seg = 14;
      let prev: THREE.Vector3 | null = null;
      for (let i = 0; i <= seg; i++) {
        const h = (i / seg) * TOP;
        const ang = (s / 5) * Math.PI * 2 + h * 1.9;
        const rr = 0.3 - h * 0.06;
        const c = axis(h).add(V(Math.cos(ang) * rr, 0, Math.sin(ang) * rr));
        if (prev) p.cone(lasherBone(h - TOP / seg / 2), [prev.x, prev.y, prev.z], [c.x, c.y, c.z], 0.12 - (h / TOP) * 0.05, 0.12 - (h / TOP) * 0.05, 0.05, A);
        prev = c;
      }
    }
    // thorns
    for (let i = 0; i < 16; i++) {
      const h = 0.35 + (i / 16) * 2.0;
      const ang = i * GOLDEN * 2;
      const c = axis(h);
      const r = 0.36 - h * 0.06;
      const o = V(Math.cos(ang), 0.35, Math.sin(ang)).normalize();
      p.cone(lasherBone(h), [c.x + o.x * r * 0.8, c.y, c.z + o.z * r * 0.8], [c.x + o.x * (r + 0.28), c.y + 0.12, c.z + o.z * (r + 0.28)], 0.05, 0.004, 0.015, D);
    }
    // root flare gripping the ground
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.2;
      const c = [Math.cos(a), Math.sin(a)];
      p.cord(LB.root, [[c[0] * 0.25, 0.5, c[1] * 0.25], [c[0] * 0.65, 0.12, c[1] * 0.65], [c[0] * 1.1, -0.05, c[1] * 1.1], [c[0] * 1.6, -0.2, c[1] * 1.6]], 0.14, 0.03, 0.06, D, 8);
    }
    // the head: bulb, five jaw-petals, throat and teeth
    const hc = V(0, 3.05, 0.2);
    p.ell(LB.head, [hc.x, hc.y - 0.1, hc.z], [0.42, 0.36, 0.42], 0.1, S);
    p.ell(LB.head, [hc.x, hc.y + 0.12, hc.z], [0.26, 0.2, 0.26], 0.05, S, undefined, true);
    p.ell(LB.head, [hc.x, hc.y + 0.02, hc.z], [0.2, 0.12, 0.2], 0.03, G);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const c = [Math.cos(a), Math.sin(a)];
      const at = (r: number, y: number) => [hc.x + c[0] * r, hc.y + y, hc.z + c[1] * r];
      // a jaw-claw: out from the rim, flaring wide, its tip hooking back over the throat
      p.cord(LB.head, [at(0.3, 0.1), at(0.62, 0.3), at(0.78, 0.62), at(0.55, 0.88), at(0.3, 0.92)], 0.13, 0.02, 0.05, A, 9);
      p.cord(LB.head, [at(0.36, 0.12), at(0.6, 0.26), at(0.72, 0.5)], 0.07, 0.04, 0.04, D, 5);
      // teeth along each claw's inner edge
      for (let k = 0; k < 4; k++) {
        const r = 0.5 + k * 0.08, y = 0.3 + k * 0.17;
        const t0 = at(r, y), t1 = at(r - 0.2, y + 0.02);
        p.cone(LB.head, t0, t1, 0.03, 0.003, 0.01, C);
      }
      p.ell(LB.head, at(0.3, 0.1), [0.08, 0.08, 0.08], 0.03, D);
    }
    p.cyl(LB.head, [hc.x, hc.y + 0.1, hc.z], [hc.x, hc.y + 0.2, hc.z], 0.3, 0.03, G); // lit throat ring
    // two hanging leaf-blades off the upper trunk
    for (const s of [-1, 1]) p.ell(LB.s2, [s * 0.45, 1.95, 0.05], [0.32, 0.05, 0.14], 0.06, A, [0, 0, s * -0.6]);
    return new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(0.55), band: 0.03 } : {}).mesh(q.cell ?? 0.035).geometry;
  });
}

// ---------------------------------------------------------------------------------------------
// Fractal Prism
// ---------------------------------------------------------------------------------------------

/**
 * Sierpinski tetrahedron of the given depth and edge length, centred on its centroid: 4^depth hard-edged
 * tetrahedra (flat-shaded, no SDF: its crystal reads best with crisp facets). Each tetra carries its corner
 * address in `aLevel` (0..1) so the shader can shimmer generation by generation.
 */
export function sierpinskiGeometry(depth: number, edge: number) {
  const key = `sierpinski${depth}:${edge}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = edge / Math.sqrt(8);
  const corners = [V(1, 1, 1), V(-1, -1, 1), V(-1, 1, -1), V(1, -1, -1)].map((v) => v.multiplyScalar(s));
  const faces = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  const pos: number[] = [];
  const lvl: number[] = [];
  const rec = (vs: THREE.Vector3[], d: number, addr: number) => {
    if (d === 0) {
      for (const f of faces) for (const i of f) {
        pos.push(vs[i].x, vs[i].y, vs[i].z);
        lvl.push(addr);
      }
      return;
    }
    for (let c = 0; c < 4; c++) {
      const sub = vs.map((v) => v.clone().add(vs[c]).multiplyScalar(0.5));
      rec(sub, d - 1, addr * 0.25 + c * 0.25 + 0.0625);
    }
  };
  rec(corners, depth, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLevel', new THREE.Float32BufferAttribute(lvl, 1));
  g.computeVertexNormals();
  cache.set(key, g);
  return g;
}

/** Octahedral shard used for the Prism's orbiting satellites. */
export function shardGeometry() {
  const hit = cache.get('shard');
  if (hit) return hit;
  const g = new THREE.OctahedronGeometry(0.22, 0);
  g.scale(0.6, 1.5, 0.6);
  g.deleteAttribute('uv');
  g.setAttribute('aLevel', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(0.5), 1));
  g.computeVertexNormals();
  cache.set('shard', g);
  return g;
}
