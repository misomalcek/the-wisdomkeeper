import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sculpt, skinnedTube, MAT } from './sdf';
import { Kit } from './sculptKit';
import { nullDetail, type MachineQuality } from './nullModels';

/**
 * The Null's swarm: the Null Sprite and the Thorn Caster. Both float and are rigid (their motion is the body
 * spinning and bobbing), so they are unskinned sculpts out of the same kernel and bake as the bigger creatures.
 */

const cache = new Map<string, THREE.BufferGeometry>();
const rigid = (g: THREE.BufferGeometry) => {
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  return g;
};
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Null Sprite (≈1.1 m): a faceted void-crystal seed caged by four hooked bone-blades, with a glowing heart
 * showing between them and three barbed tendrils trailing beneath.
 */
export function miteGeometry(q: MachineQuality = {}) {
  const key = 'mite';
  if (!q.cell && !q.detail && cache.has(key)) return cache.get(key)!;
  const p = new Kit();
  const A = MAT.armor, D = MAT.dark, C = MAT.blade;
  // the seed: two crystal bipyramids, offset and crossed
  p.cone(0, [0, -0.36, 0], [0, 0, 0], 0.02, 0.2, 0.02, C);
  p.cone(0, [0, 0, 0], [0, 0.42, 0], 0.2, 0.02, 0.02, C);
  p.cone(0, [0.08, -0.2, 0.06], [0.12, 0.3, -0.06], 0.08, 0.02, 0.03, C);
  // the heart, sunk in the seed's waist
  p.ell(0, [0, 0.02, 0.0], [0.14, 0.1, 0.14], 0.02, MAT.glow);
  // four hooked bone-blades caging it
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const c = [Math.sin(a), Math.cos(a)];
    p.cord(0, [[c[0] * 0.12, -0.3, c[1] * 0.12], [c[0] * 0.36, -0.1, c[1] * 0.36], [c[0] * 0.4, 0.22, c[1] * 0.4], [c[0] * 0.2, 0.5, c[1] * 0.2]], 0.07, 0.008, 0.03, A, 10);
    // a ridge of barbs along each blade's back
    for (let k = 0; k < 3; k++) {
      const y = -0.08 + k * 0.16;
      const r = 0.38 + (k === 1 ? 0.03 : 0);
      p.cone(0, [c[0] * r, y, c[1] * r], [c[0] * (r + 0.14), y + 0.06, c[1] * (r + 0.14)], 0.03, 0.004, 0.015, D);
    }
  }
  p.ell(0, [0, -0.32, 0], [0.12, 0.06, 0.12], 0.04, D); // knuckle where the blades meet
  const body = rigid(new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(0.35), band: 0.02 } : {}).mesh(q.cell ?? 0.018).geometry);
  const parts = [body];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const pts = [V(Math.sin(a) * 0.06, -0.34, Math.cos(a) * 0.06), V(Math.sin(a) * 0.16, -0.62, Math.cos(a) * 0.16), V(Math.sin(a + 0.6) * 0.12, -0.9, Math.cos(a + 0.6) * 0.12), V(Math.sin(a + 1.1) * 0.2, -1.15, Math.cos(a + 1.1) * 0.2)];
    parts.push(rigid(skinnedTube(pts, (t) => 0.03 * (1 - t) + 0.004, [0], MAT.dark, q.detail ? 8 : 5)));
  }
  const g = mergeGeometries(parts, false)!;
  if (!q.cell && !q.detail) cache.set(key, g);
  return g;
}

/**
 * Thorn Caster (≈1.8 m): a floating void-blossom. A ribbed bulb hangs from a crown of curved thorns; a ring
 * of leathery petals cups a glowing maw on top (where its bolts are born), and root tendrils trail beneath.
 */
export function spitterGeometry(q: MachineQuality = {}) {
  const key = 'spitter';
  if (!q.cell && !q.detail && cache.has(key)) return cache.get(key)!;
  const p = new Kit();
  const A = MAT.armor, D = MAT.dark, S = MAT.skin, G = MAT.glow;
  p.ell(0, [0, -0.1, 0], [0.42, 0.5, 0.42], 0, S);
  p.ell(0, [0, -0.62, 0], [0.18, 0.2, 0.18], 0.12, D);
  // ribs down the bulb
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const c = [Math.sin(a), Math.cos(a)];
    p.cord(0, [[c[0] * 0.3, 0.3, c[1] * 0.3], [c[0] * 0.45, -0.05, c[1] * 0.45], [c[0] * 0.3, -0.5, c[1] * 0.3], [c[0] * 0.1, -0.75, c[1] * 0.1]], 0.05, 0.025, 0.05, D, 8);
  }
  // petals cupping the maw
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const c = [Math.sin(a), Math.cos(a)];
    p.ell(0, [c[0] * 0.32, 0.42, c[1] * 0.32], [0.2, 0.05, 0.3], 0.05, A, [0.6 * c[1], a, -0.6 * c[0]]);
  }
  p.ell(0, [0, 0.42, 0], [0.22, 0.12, 0.22], 0.06, S, undefined, true); // the maw
  p.ell(0, [0, 0.34, 0], [0.16, 0.08, 0.16], 0.02, G);
  // the thorn crown, curving out and down
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const c = [Math.sin(a), Math.cos(a)];
    const l = 0.9 + (i % 3) * 0.12;
    p.cord(0, [[c[0] * 0.36, 0.18, c[1] * 0.36], [c[0] * 0.7 * l, 0.3, c[1] * 0.7 * l], [c[0] * 0.95 * l, 0.05, c[1] * 0.95 * l], [c[0] * 1.05 * l, -0.3, c[1] * 1.05 * l]], 0.06, 0.006, 0.03, D, 9);
  }
  const body = rigid(new Sculpt(p.list, undefined, q.detail ? { detail: nullDetail(0.5), band: 0.025 } : {}).mesh(q.cell ?? 0.025).geometry);
  const parts = [body];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const pts = [V(Math.sin(a) * 0.08, -0.72, Math.cos(a) * 0.08), V(Math.sin(a) * 0.2, -1.0, Math.cos(a) * 0.2), V(Math.sin(a + 0.5) * 0.16, -1.35, Math.cos(a + 0.5) * 0.16), V(Math.sin(a + 0.9) * 0.26, -1.7, Math.cos(a + 0.9) * 0.26)];
    parts.push(rigid(skinnedTube(pts, (t) => 0.035 * (1 - t) + 0.005, [0], MAT.dark, q.detail ? 8 : 5)));
  }
  const g = mergeGeometries(parts, false)!;
  if (!q.cell && !q.detail) cache.set(key, g);
  return g;
}
