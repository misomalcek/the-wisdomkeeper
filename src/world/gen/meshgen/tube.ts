/**
 * Skeleton → continuous tube mesh. A skeleton is a tree of nodes (position, radius, parent). It is split into limbs:
 * each limb follows the thickest child onward, and every other child starts a new limb rooted inside its parent, so
 * branches grow out of the bark instead of being separate sticks. Each limb is swept with rotation-minimising
 * (parallel-transport) frames, so the rings never twist, and closed with a rounded tip.
 */
import { MeshBuilder, type V3, add, cross, dot, norm, perp, scale, sub } from './geo';

export interface Skeleton {
  p: V3[];
  r: number[];
  parent: number[];
  /** Branch order (0 trunk). */
  depth: number[];
}

export const newSkeleton = (): Skeleton => ({ p: [], r: [], parent: [], depth: [] });
export function addNode(s: Skeleton, p: V3, r: number, parent: number, depth: number) {
  s.p.push(p);
  s.r.push(r);
  s.parent.push(parent);
  s.depth.push(depth);
  return s.p.length - 1;
}

export interface TubeOpts {
  /** Ring sides for a radius (more for thick limbs). */
  sides: (r: number) => number;
  /** Skip limbs whose base radius is below this (LOD pruning). */
  minR: number;
  /** Depth that maps to aux.w = 1. */
  maxDepth: number;
}

export function sweepSkeleton(s: Skeleton, b: MeshBuilder, o: TubeOpts) {
  const n = s.p.length;
  const kids: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) if (s.parent[i] >= 0) kids[s.parent[i]].push(i);
  // limbs: start at roots and at every non-primary child
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = s.parent[i];
    if (p < 0) starts.push(i);
    else {
      const sib = kids[p];
      let best = sib[0];
      for (const k of sib) if (s.r[k] > s.r[best]) best = k;
      if (best !== i) starts.push(i);
    }
  }
  for (const st of starts) {
    if (s.r[st] < o.minR) continue;
    const chain: number[] = [];
    if (s.parent[st] >= 0) chain.push(s.parent[st]);
    let c = st;
    for (;;) {
      chain.push(c);
      const ks = kids[c];
      if (!ks.length) break;
      let best = ks[0];
      for (const k of ks) if (s.r[k] > s.r[best]) best = k;
      if (s.r[best] < o.minR * 0.6) break;
      c = best;
    }
    if (chain.length < 2) continue;
    sweep(s, chain, b, o, st);
  }
}

function sweep(s: Skeleton, chain: number[], b: MeshBuilder, o: TubeOpts, start: number) {
  const m = chain.length;
  const pts = chain.map((i) => s.p[i]);
  const rad = chain.map((i, k) => (k === 0 && i !== start ? s.r[start] * 1.12 : s.r[i]));
  const sides = Math.max(3, o.sides(rad[0]));
  // a side limb starts a little inside the parent so the join reads as one surface
  if (s.parent[start] >= 0 && chain[0] !== start) {
    const d = norm(sub(pts[1], pts[0]));
    pts[0] = add(pts[0], scale(d, -s.r[chain[0]] * 0.35));
  }
  const tan: V3[] = [];
  for (let k = 0; k < m; k++) tan.push(norm(sub(pts[Math.min(m - 1, k + 1)], pts[Math.max(0, k - 1)])));
  let N = perp(tan[0]);
  const depthW = s.depth[start] / o.maxDepth;
  const rnd = fract(Math.sin(start * 12.9898) * 43758.5453);
  let prevRing = -1;
  for (let k = 0; k < m; k++) {
    const T = tan[k];
    // parallel transport: project the previous normal onto the new normal plane
    N = norm(sub(N, scale(T, dot(N, T))));
    const B = cross(T, N);
    const ring = b.vertexCount;
    const r = rad[k];
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const nx = N[0] * ca + B[0] * sa;
      const ny = N[1] * ca + B[1] * sa;
      const nz = N[2] * ca + B[2] * sa;
      const P = pts[k];
      b.vertex(P[0] + nx * r, P[1] + ny * r, P[2] + nz * r, nx, ny, nz, 0, rnd, 0, depthW);
    }
    if (prevRing >= 0) {
      for (let j = 0; j < sides; j++) {
        const j1 = (j + 1) % sides;
        b.quad(prevRing + j, prevRing + j1, ring + j1, ring + j);
      }
    }
    prevRing = ring;
  }
  // rounded tip
  const T = tan[m - 1];
  const P = pts[m - 1];
  const r = rad[m - 1];
  const tip = b.vertex(P[0] + T[0] * r * 1.6, P[1] + T[1] * r * 1.6, P[2] + T[2] * r * 1.6, T[0], T[1], T[2], 0, rnd, 0, depthW);
  for (let j = 0; j < sides; j++) b.tri(prevRing + j, prevRing + ((j + 1) % sides), tip);
}

const fract = (x: number) => x - Math.floor(x);
