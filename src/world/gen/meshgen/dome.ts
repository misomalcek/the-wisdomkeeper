/**
 * Geodesic domes (Fuller). An icosahedron stood on a vertex (five-fold axis vertical) has every face divided into
 * a ν-frequency triangular grid (class I, ν² triangles per face); the grid points are pushed out onto the sphere,
 * so strut lengths vary only a little and every node is five- or six-valent. The sphere is cut at the vertex level
 * nearest the requested dome fraction (height / sphere diameter: ½ hemisphere, ⅝ the classic 3V dome); base nodes
 * that zig-zag above the cut slide down their meridian onto the base plane, so the dome sits on a flat ring of
 * pinned supports. Fully triangulated, it is a stiff space truss: the solver needs no bracing.
 */
import type { Frame } from './truss';

export interface DomeOpts {
  /** Frequency (3–5 sensible). */
  freq: number;
  /** Height / sphere diameter. */
  fraction: number;
  /** Sphere diameter (m). */
  diameter: number;
}

/** Unit icosahedron with vertices at both poles; faces wound outward. */
function icosahedron() {
  const v: number[][] = [[0, 1, 0]];
  const h = 1 / Math.sqrt(5);
  const r = 2 / Math.sqrt(5);
  for (let k = 0; k < 5; k++) v.push([r * Math.cos((k * 2 * Math.PI) / 5), h, r * Math.sin((k * 2 * Math.PI) / 5)]);
  for (let k = 0; k < 5; k++) v.push([r * Math.cos(((k + 0.5) * 2 * Math.PI) / 5), -h, r * Math.sin(((k + 0.5) * 2 * Math.PI) / 5)]);
  v.push([0, -1, 0]);
  const f: number[][] = [];
  for (let k = 0; k < 5; k++) {
    const u0 = 1 + k;
    const u1 = 1 + ((k + 1) % 5);
    const l0 = 6 + k;
    const l1 = 6 + ((k + 1) % 5);
    f.push([0, u0, u1], [u0, l0, u1], [u1, l0, l1], [11, l0, l1]);
  }
  // wind every face outward
  for (const t of f) {
    const [a, b, c] = t.map((i) => v[i]);
    const n = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ];
    if (n[0] * (a[0] + b[0] + c[0]) + n[1] * (a[1] + b[1] + c[1]) + n[2] * (a[2] + b[2] + c[2]) < 0) [t[1], t[2]] = [t[2], t[1]];
  }
  return { v, f };
}

/** Geodesic sphere of frequency ν: unit-sphere points and outward triangles. */
export function geodesicSphere(freq: number) {
  const ico = icosahedron();
  const pts: number[][] = [];
  const key = new Map<string, number>();
  const tris: number[][] = [];
  const at = (p: number[]) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    const q = [p[0] / l, p[1] / l, p[2] / l];
    const k = q.map((c) => Math.round(c * 1e6)).join(',');
    let i = key.get(k);
    if (i === undefined) key.set(k, (i = pts.push(q) - 1));
    return i;
  };
  for (const [ia, ib, ic] of ico.f) {
    const [A, B, C] = [ico.v[ia], ico.v[ib], ico.v[ic]];
    const id: number[][] = [];
    for (let i = 0; i <= freq; i++) {
      id.push([]);
      for (let j = 0; j <= freq - i; j++) id[i].push(at([0, 1, 2].map((c) => A[c] + ((B[c] - A[c]) * i + (C[c] - A[c]) * j) / freq)));
    }
    for (let i = 0; i < freq; i++)
      for (let j = 0; j < freq - i; j++) {
        tris.push([id[i][j], id[i + 1][j], id[i][j + 1]]);
        if (i + j + 1 < freq) tris.push([id[i + 1][j], id[i + 1][j + 1], id[i][j + 1]]);
      }
  }
  return { pts, tris };
}

/** Build the dome's frame in metres, base ring on y = 0, centred on the y axis. */
export function geodesicDome(o: DomeOpts): Frame {
  const { pts, tris } = geodesicSphere(o.freq);
  // cut at the vertex level nearest the requested fraction
  const want = 1 - 2 * o.fraction;
  let cut = -1;
  for (const p of pts) if (Math.abs(p[1] - want) < Math.abs(cut - want)) cut = p[1];
  const kept = tris.filter((t) => t.every((i) => pts[i][1] >= cut - 1e-6));
  // boundary edges: used by one kept face
  const use = new Map<string, number>();
  const ek = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const t of kept) for (let k = 0; k < 3; k++) use.set(ek(t[k], t[(k + 1) % 3]), (use.get(ek(t[k], t[(k + 1) % 3])) ?? 0) + 1);
  const base = new Set<number>();
  for (const [k, c] of use) if (c === 1) for (const s of k.split(',')) base.add(+s);
  // renumber, slide the zig-zag base down its meridian onto the cut plane
  const R = o.diameter / 2;
  const map = new Map<number, number>();
  const x: number[] = [];
  const rb = Math.sqrt(Math.max(0, 1 - cut * cut));
  for (const t of kept)
    for (const i of t) {
      if (map.has(i)) continue;
      map.set(i, x.length / 3);
      const p = pts[i];
      if (base.has(i)) {
        const h = Math.hypot(p[0], p[2]) || 1;
        x.push((p[0] / h) * rb * R, 0, (p[2] / h) * rb * R);
      } else x.push(p[0] * R, (p[1] - cut) * R, p[2] * R);
    }
  const n = x.length / 3;
  const fixed = new Uint8Array(n * 3);
  for (const i of base) if (map.has(i)) fixed.fill(1, map.get(i)! * 3, map.get(i)! * 3 + 3);
  // struts; the base ring between two supports carries nothing and becomes the ground sill
  const ends: number[] = [];
  const sill: number[] = [];
  for (const k of use.keys()) {
    const [a, b] = k.split(',').map((s) => map.get(+s)!);
    (fixed[a * 3] && fixed[b * 3] ? sill : ends).push(a, b);
  }
  return {
    x: new Float64Array(x),
    ends: new Uint32Array(ends),
    fixed,
    faces: kept.map((t) => t.map((i) => map.get(i)!)),
    role: new Uint8Array(ends.length / 2),
    sill: new Uint32Array(sill),
  };
}
