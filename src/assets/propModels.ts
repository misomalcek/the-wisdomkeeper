import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sculpt, skinnedTube, MAT } from './sdf';
import { Kit } from './sculptKit';
import { nullDetail, type MachineQuality } from './nullModels';

/**
 * Set pieces from the Act IV vision frame, sculpted out of the same kernel as the creatures and baked the same way:
 * the Resonance Contact (a floating machined slab with a lit core socket and roots trailing beneath it) and the
 * Datastream Contact (a round ringed dais with a beam emitter at its heart).
 */

const cache = new Map<string, THREE.BufferGeometry>();
const rigid = (g: THREE.BufferGeometry) => {
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  return g;
};
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Resonance Contact (≈5 × 4 m): three stacked plates — a dark weathered keel, a lit seam, a panelled deck with a
 * sunken engraved well — and a ringed core socket in the middle. Clamps guard the corners, emitters glow from the
 * flanks and old roots that once anchored it hang from the keel. Origin at the deck's underside centre.
 */
export function contactPadGeometry(q: MachineQuality = {}) {
  const key = 'contactPad';
  if (!q.cell && !q.detail && cache.has(key)) return cache.get(key)!;
  const p = new Kit();
  const A = MAT.armor, D = MAT.dark, G = MAT.glow, S = MAT.skin;
  // keel: a weathered stone slab tapering beneath
  p.box(0, [0, -0.1, 0], [2.45, 0.3, 1.85], 0.28, 0, S);
  p.ell(0, [0, -0.42, 0], [2.0, 0.42, 1.45], 0.25, S);
  // the lit seam between keel and deck
  p.box(0, [0, 0.24, 0], [2.36, 0.05, 1.76], 0.05, 0.01, G);
  // deck plate and its raised rim
  p.box(0, [0, 0.42, 0], [2.42, 0.14, 1.82], 0.12, 0.02, A);
  p.box(0, [0, 0.6, 0], [1.75, 0.09, 1.2], 0.06, 0, A, undefined, true); // sunken well
  // engraved channels across the well floor, radiating from the socket
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const len = i % 2 ? 1.35 : 1.05;
    p.box(0, [Math.cos(a) * len * 0.62, 0.52, Math.sin(a) * len * 0.62], [len * 0.5, 0.025, 0.03], 0.01, 0, D, [0, -a, 0], true);
  }
  // panel grooves on the outer rim
  for (const s of [-1, 1]) {
    for (const x of [-1.3, 0, 1.3]) p.box(0, [x, 0.56, s * 1.52], [0.02, 0.05, 0.3], 0.01, 0, D, undefined, true);
    p.box(0, [s * 2.1, 0.56, 0], [0.3, 0.05, 0.02], 0.01, 0, D, undefined, true);
  }
  // core socket: two rings and the lens
  p.cyl(0, [0, 0.48, 0], [0, 0.64, 0], 0.62, 0.03, A);
  p.cyl(0, [0, 0.58, 0], [0, 0.7, 0], 0.46, 0, A, true);
  p.cyl(0, [0, 0.55, 0], [0, 0.62, 0], 0.36, 0.02, D);
  p.ell(0, [0, 0.62, 0], [0.26, 0.1, 0.26], 0.02, G);
  // corner clamps with a lit stud each
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      p.box(0, [sx * 2.12, 0.6, sz * 1.52], [0.34, 0.16, 0.3], 0.06, 0.05, A, [0, sx * sz * 0.785, 0]);
      p.box(0, [sx * 2.32, 0.38, sz * 1.72], [0.16, 0.34, 0.16], 0.05, 0.05, D, [0, sx * sz * 0.785, 0]);
      p.ell(0, [sx * 2.15, 0.78, sz * 1.55], [0.07, 0.04, 0.07], 0.01, G);
    }
  // flank emitters
  for (const s of [-1, 1]) {
    p.box(0, [0, 0.0, s * 1.88], [1.2, 0.05, 0.05], 0.03, 0.01, G);
    p.box(0, [s * 2.5, 0.0, 0], [0.05, 0.05, 0.8], 0.03, 0.01, G);
  }
  const body = rigid(new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(1.2), band: 0.04 } : {}).mesh(q.cell ?? 0.06).geometry);
  const parts = [body];
  // roots hanging from the keel
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.2;
    const r = 1.1 + (i % 3) * 0.3;
    const x = Math.cos(a) * r * 1.2, z = Math.sin(a) * r * 0.85;
    const len = 1.2 + ((i * 7) % 5) * 0.35;
    const pts = [V(x, -0.55, z), V(x * 1.05, -0.55 - len * 0.35, z * 1.05), V(x * 0.95 + 0.15, -0.55 - len * 0.7, z * 0.95), V(x * 0.9, -0.55 - len, z * 0.9 + 0.1)];
    parts.push(rigid(skinnedTube(pts, (t) => 0.09 * (1 - t) + 0.01, [0], MAT.dark, q.detail ? 10 : 6)));
  }
  const g = mergeGeometries(parts, false)!;
  if (!q.cell && !q.detail) cache.set(key, g);
  return g;
}

/**
 * Datastream Contact (≈3.2 m across): a round dais of concentric machined rings around a lens that throws the
 * datastream beam upward; buttress fins hold the outer ring. Origin at ground level.
 */
export function datastreamDaisGeometry(q: MachineQuality = {}) {
  const key = 'dais';
  if (!q.cell && !q.detail && cache.has(key)) return cache.get(key)!;
  const p = new Kit();
  const A = MAT.armor, D = MAT.dark, G = MAT.glow, S = MAT.skin;
  p.cyl(0, [0, -0.4, 0], [0, 0.12, 0], 1.6, 0.08, S);
  p.cyl(0, [0, 0.1, 0], [0, 0.24, 0], 1.45, 0.02, A);
  p.cyl(0, [0, 0.2, 0], [0, 0.3, 0], 1.18, 0, A, true);
  p.cyl(0, [0, 0.16, 0], [0, 0.2, 0], 1.12, 0.01, G); // lit ring groove
  p.cyl(0, [0, 0.14, 0], [0, 0.32, 0], 0.95, 0.02, D);
  p.cyl(0, [0, 0.28, 0], [0, 0.4, 0], 0.62, 0.02, A);
  p.cyl(0, [0, 0.36, 0], [0, 0.46, 0], 0.4, 0, A, true);
  p.ell(0, [0, 0.38, 0], [0.3, 0.1, 0.3], 0.02, G);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    p.box(0, [Math.cos(a) * 0.8, 0.33, Math.sin(a) * 0.8], [0.13, 0.03, 0.025], 0.01, 0, D, [0, -a, 0], true);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.26;
    p.box(0, [Math.cos(a) * 1.6, 0.1, Math.sin(a) * 1.6], [0.32, 0.26, 0.09], 0.05, 0.06, D, [0, -a, 0]);
    p.ell(0, [Math.cos(a) * 1.78, 0.2, Math.sin(a) * 1.78], [0.05, 0.05, 0.05], 0.01, G);
  }
  const g = rigid(new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(0.9), band: 0.03 } : {}).mesh(q.cell ?? 0.05).geometry);
  if (!q.cell && !q.detail) cache.set(key, g);
  return g;
}
