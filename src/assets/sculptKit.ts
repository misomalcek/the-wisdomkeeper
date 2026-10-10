import * as THREE from 'three';
import { MAT, type MatId, type Prim } from './sdf';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const E = (r?: number[]) => (r ? new THREE.Euler(r[0], r[1], r[2]) : undefined);

/** Authoring helpers for SDF sculpts: primitives in model space, each skinned to `bone`. */
export class Kit {
  readonly list: Prim[] = [];
  cone(bone: number, a: number[], b: number[], ra: number, rb: number, k: number, mat: MatId = MAT.skin, sub = false) {
    this.list.push({ bone, kind: 'cone', a: V(a[0], a[1], a[2]), b: V(b[0], b[1], b[2]), ra, rb, k, mat, sub });
  }
  cyl(bone: number, a: number[], b: number[], r: number, k: number, mat: MatId = MAT.skin, sub = false) {
    this.list.push({ bone, kind: 'cyl', a: V(a[0], a[1], a[2]), b: V(b[0], b[1], b[2]), ra: r, k, mat, sub });
  }
  ell(bone: number, c: number[], r: number[], k: number, mat: MatId = MAT.skin, rot?: number[], sub = false) {
    this.list.push({ bone, kind: 'ellipsoid', a: V(c[0], c[1], c[2]), ra: 0, radii: V(r[0], r[1], r[2]), rot: E(rot), k, mat, sub });
  }
  box(bone: number, c: number[], h: number[], round: number, k: number, mat: MatId, rot?: number[], sub = false) {
    this.list.push({ bone, kind: 'box', a: V(c[0], c[1], c[2]), ra: round, radii: V(h[0], h[1], h[2]), rot: E(rot), k, mat, sub });
  }
  /** A cord through control points (Catmull-Rom) as chained round cones tapering r0 → r1. */
  cord(bone: number, pts: number[][], r0: number, r1: number, k: number, mat: MatId, seg = 6) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => V(p[0], p[1], p[2])));
    let prev = curve.getPointAt(0);
    for (let i = 1; i <= seg; i++) {
      const t = i / seg;
      const p = curve.getPointAt(t);
      this.list.push({ bone, kind: 'cone', a: prev.clone(), b: p.clone(), ra: r0 + (r1 - r0) * (t - 1 / seg), rb: r0 + (r1 - r0) * t, k, mat });
      prev = p;
    }
  }
  /** `n` strands twisting round the axis a→b (radius `w`), like braided roots or cabling. */
  braid(bone: number, a: number[], b: number[], w: number, r: number, n: number, turns: number, mat: MatId, phase = 0, taper = 0.7) {
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
      this.cord(bone, pts, r, r * taper, 0.03, mat, 8);
    }
  }
}
