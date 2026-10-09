import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Sculpt, MAT } from '../src/assets/sdf';
import { BONE, buildRig, heroGeometry, rootBladeGeometry } from '../src/assets/heroModel';
import { FB, buildFiendRig, fiendGeometry } from '../src/assets/fiendModel';
import { remapSkin } from '../src/assets/pipeline';

describe('SDF sculpting', () => {
  it('meshes a sphere onto its true surface', () => {
    const s = new Sculpt([{ bone: 0, kind: 'ellipsoid', a: new THREE.Vector3(), ra: 0, radii: new THREE.Vector3(0.5, 0.5, 0.5), k: 0, mat: MAT.skin }]);
    const g = s.mesh(0.05).geometry;
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) expect(Math.abs(Math.hypot(p.getX(i), p.getY(i), p.getZ(i)) - 0.5)).toBeLessThan(0.004);
    // closed surface: Euler characteristic of a sphere
    const tris = g.index!.count / 3;
    expect(p.count - tris / 2).toBe(2);
  });

  it('sculpts a hero with normalised skin weights inside the rig and a height near 2.05 m', () => {
    buildRig();
    const g = heroGeometry();
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeGreaterThan(-0.02);
    expect(g.boundingBox!.max.y).toBeGreaterThan(2.0);
    expect(g.index!.count / 3).toBeLessThan(80000);
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    const nb = buildRig().bones.length;
    for (let i = 0; i < sw.count; i++) {
      expect(Math.abs(sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i) - 1)).toBeLessThan(1e-3);
      expect(si.getX(i)).toBeLessThan(nb);
    }
    // feet are skinned to the feet, the crown to the head
    let footOk = 0;
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) if (p.getY(i) < 0.03 && (si.getX(i) === BONE.ftL || si.getX(i) === BONE.ftR)) footOk++;
    expect(footOk).toBeGreaterThan(20);
    expect(rootBladeGeometry().getAttribute('aMat').itemSize).toBe(4);
  });

  it('sculpts the fiend on its own rig', () => {
    const g = fiendGeometry();
    const n = buildFiendRig().bones.length;
    expect(n).toBe(Object.keys(FB).length);
    const si = g.getAttribute('skinIndex');
    for (let i = 0; i < si.count; i++) expect(si.getX(i)).toBeLessThan(n);
  });

  it('remaps a GLB skin onto the rig by bone name', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array([0, 1, 0, 0, 2, 0, 0, 0]), 4));
    const head = new THREE.Bone(); head.name = 'head';
    const tip = new THREE.Bone(); tip.name = 'hair_tip'; head.add(tip);
    const hips = new THREE.Bone(); hips.name = 'hips';
    remapSkin(g, [hips, head, tip]);
    const out = g.getAttribute('skinIndex');
    expect([out.getX(0), out.getY(0), out.getX(1)]).toEqual([BONE.hips, BONE.head, BONE.head]);
    expect(g.getAttribute('aMat').itemSize).toBe(4);
  });
});
