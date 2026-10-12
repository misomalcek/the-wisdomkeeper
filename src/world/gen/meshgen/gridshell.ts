/**
 * Funicular gridshells (Frei Otto's Mannheim Multihalle, Gaudí's hanging models).
 * - Plan grid, Townscaper-style (Stålberg): a hexagon of equilateral triangles; random adjacent pairs merge into
 *   quads; every face is split about its centroid through its edge midpoints (triangle → 3 quads, quad → 4), so all
 *   faces are quads with irregular valence. The hexagon's rings are warped onto the plan curve (a superellipse),
 *   then relaxation pulls each quad toward the square that best fits it (corners rotated by −k·90° about the
 *   centroid and averaged), with a little Laplacian smoothing and even spacing along the sliding boundary.
 * - Form finding by dynamic relaxation of the hanging net: grid edges become tension-only springs, pre-tensioned
 *   (rest length below plan length) so every chain stays taut; boundary nodes stay pinned on the ground except
 *   over the openings, whose free edges get an edge cable; nodes carry their weight; explicit integration with
 *   fictitious masses (Σ axial + geometric stiffness) and viscous damping runs to equilibrium. Inverted, every
 *   chain becomes a strut in pure compression and every edge cable an arch. A vertical scale then sets the rise: it
 *   keeps the force densities (T/L) and the horizontal equilibrium and scales the vertical loads uniformly, so the
 *   form stays funicular. Node weights are re-lumped from the built form's member lengths and the net relaxed
 *   again, so the shell is funicular for its own self-weight.
 * - One diagonal per quad (the shorter) braces the net in shear, as the cables did at Mannheim; free edges are
 *   stiffened into edge trusses (see `gridshell`).
 */
import { Rng } from '../../../util/rng';
import type { Frame } from './truss';

export interface QuadGrid {
  /** Plan positions (x, z) interleaved (m). */
  p: Float64Array;
  /** Four corners per quad, counter-clockwise in the (x, z) plane. */
  quads: Uint32Array;
  /** Boundary nodes, in order around the plan. */
  loop: number[];
}

export interface PlanOpts {
  /** Hexagon size in triangle rows (resolution). */
  rings: number;
  /** Plan semi-axes (m) and superellipse exponent (2 ellipse, ~3.5 rounded rectangle). */
  a: number;
  b: number;
  e: number;
  /** Fraction of triangle pairs merged into quads. */
  merge?: number;
  iters?: number;
}

const ekey = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a);

/** Radial projection of (x, z) onto the superellipse |x/a|ᵉ + |z/b|ᵉ = 1. */
function onPlan(x: number, z: number, o: PlanOpts): [number, number] {
  const s = Math.pow(Math.abs(x / o.a) ** o.e + Math.abs(z / o.b) ** o.e, -1 / o.e);
  return [x * s, z * s];
}

export function townscaperGrid(seed: number, o: PlanOpts): QuadGrid {
  const rng = new Rng(seed);
  const N = o.rings;
  // triangular lattice inside the hexagon
  const id = new Map<number, number>();
  const P: number[] = [];
  const lk = (q: number, r: number) => (q + 64) * 256 + (r + 64);
  for (let q = -N; q <= N; q++)
    for (let r = -N; r <= N; r++) if (Math.abs(q + r) <= N) id.set(lk(q, r), P.push(q + r / 2, (r * Math.sqrt(3)) / 2) / 2 - 1);
  const tris: number[][] = [];
  for (let q = -N; q <= N; q++)
    for (let r = -N; r <= N; r++) {
      const a = id.get(lk(q, r));
      const b = id.get(lk(q + 1, r));
      const c = id.get(lk(q, r + 1));
      const d = id.get(lk(q + 1, r + 1));
      if (a !== undefined && b !== undefined && c !== undefined) tris.push([a, b, c]);
      if (b !== undefined && d !== undefined && c !== undefined) tris.push([b, d, c]);
    }
  // merge random neighbouring pairs into quads
  const byEdge = new Map<number, number[]>();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const key = ekey(t[k], t[(k + 1) % 3]);
      byEdge.set(key, [...(byEdge.get(key) ?? []), i]);
    }
  });
  const order = tris.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const used = new Uint8Array(tris.length);
  const faces: number[][] = [];
  const merge = o.merge ?? 0.85;
  for (const t of order) {
    if (used[t]) continue;
    used[t] = 1;
    const T = tris[t];
    const opts: [number, number][] = [];
    for (let k = 0; k < 3; k++) for (const u of byEdge.get(ekey(T[k], T[(k + 1) % 3]))!) if (u !== t && !used[u]) opts.push([u, k]);
    if (!opts.length || !rng.chance(merge)) {
      faces.push(T);
      continue;
    }
    const [u, k] = opts[Math.floor(rng.next() * opts.length)];
    used[u] = 1;
    const far = tris[u].find((v) => v !== T[k] && v !== T[(k + 1) % 3])!;
    // T is CCW: insert the neighbour's far corner between T[k] and T[k+1]
    faces.push([T[k], far, T[(k + 1) % 3], T[(k + 2) % 3]]);
  }
  // subdivide every face into quads about its centroid
  const pos = [...P];
  const mid = new Map<number, number>();
  const edgeUse = new Map<number, number>();
  const midOf = (a: number, b: number) => {
    const key = ekey(a, b);
    let m = mid.get(key);
    if (m === undefined) mid.set(key, (m = pos.push((pos[a * 2] + pos[b * 2]) / 2, (pos[a * 2 + 1] + pos[b * 2 + 1]) / 2) / 2 - 1));
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    return m;
  };
  const quads: number[] = [];
  for (const f of faces) {
    let cx = 0;
    let cz = 0;
    for (const v of f) (cx += pos[v * 2]), (cz += pos[v * 2 + 1]);
    const c = pos.push(cx / f.length, cz / f.length) / 2 - 1;
    const ms = f.map((v, k) => midOf(v, f[(k + 1) % f.length]));
    f.forEach((v, k) => quads.push(v, ms[k], c, ms[(k + f.length - 1) % f.length]));
  }
  const n = pos.length / 2;
  // boundary loop from the edges used by one quad
  const next = new Int32Array(n).fill(-1);
  const qe = new Map<number, number>();
  for (let q = 0; q < quads.length; q += 4) for (let k = 0; k < 4; k++) qe.set(ekey(quads[q + k], quads[q + ((k + 1) % 4)]), (qe.get(ekey(quads[q + k], quads[q + ((k + 1) % 4)])) ?? 0) + 1);
  for (let q = 0; q < quads.length; q += 4)
    for (let k = 0; k < 4; k++) {
      const a = quads[q + k];
      const b = quads[q + ((k + 1) % 4)];
      if (qe.get(ekey(a, b)) === 1) next[a] = b;
    }
  const loop: number[] = [];
  let s = next.findIndex((v) => v >= 0);
  for (let v = s; loop.length <= n; v = next[v]) {
    loop.push(v);
    if (next[v] === s) break;
  }
  const onB = new Uint8Array(n);
  const prev = new Int32Array(n);
  for (const v of loop) (onB[v] = 1), (prev[next[v]] = v);
  // neighbour lists (CSR) for smoothing
  const np = new Int32Array(n + 1);
  const ed: number[] = [];
  for (const k of qe.keys()) ed.push(Math.floor(k / 1048576), k % 1048576);
  for (const v of ed) np[v + 1]++;
  for (let v = 0; v < n; v++) np[v + 1] += np[v];
  const nb = new Int32Array(ed.length);
  const fill = np.slice(0, n);
  for (let k = 0; k < ed.length; k += 2) (nb[fill[ed[k]]++] = ed[k + 1]), (nb[fill[ed[k + 1]]++] = ed[k]);
  // warp the hexagon's rings onto scaled copies of the plan curve, then relax toward squares with the boundary
  // sliding on the curve
  const p = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 2];
    const z = pos[i * 2 + 1];
    const r = (z * 2) / Math.sqrt(3);
    const ring = Math.max(Math.abs(x - r / 2), Math.abs(r), Math.abs(x + r / 2)) / N;
    if (ring < 1e-9) continue;
    const [px, pz] = onPlan(x, z, o);
    p[i * 2] = px * ring;
    p[i * 2 + 1] = pz * ring;
  }
  const acc = new Float64Array(n * 2);
  const cnt = new Float64Array(n);
  for (const v of quads) cnt[v]++;
  const iters = o.iters ?? 120;
  for (let it = 0; it < iters; it++) {
    acc.fill(0);
    for (let q = 0; q < quads.length; q += 4) {
      let cx = 0;
      let cz = 0;
      for (let k = 0; k < 4; k++) (cx += p[quads[q + k] * 2] / 4), (cz += p[quads[q + k] * 2 + 1] / 4);
      // best-fit square: corner k rotated by −k·90° onto corner 0, averaged
      const v0 = quads[q] * 2;
      const v1 = quads[q + 1] * 2;
      const v2 = quads[q + 2] * 2;
      const v3 = quads[q + 3] * 2;
      // corners k rotated by −k·90° (x, z) → (z, −x) onto corner 0, averaged
      const sx = (p[v0] - cx + (p[v1 + 1] - cz) - (p[v2] - cx) - (p[v3 + 1] - cz)) / 4;
      const sz = (p[v0 + 1] - cz - (p[v1] - cx) - (p[v2 + 1] - cz) + (p[v3] - cx)) / 4;
      // and the square's corners back: rotations by +k·90°
      acc[v0] += cx + sx - p[v0];
      acc[v0 + 1] += cz + sz - p[v0 + 1];
      acc[v1] += cx - sz - p[v1];
      acc[v1 + 1] += cz + sx - p[v1 + 1];
      acc[v2] += cx - sx - p[v2];
      acc[v2 + 1] += cz - sz - p[v2 + 1];
      acc[v3] += cx + sz - p[v3];
      acc[v3 + 1] += cz - sx - p[v3 + 1];
    }
    // squareness, a little Laplacian smoothing inside, even spacing along the boundary
    for (let v = 0; v < n; v++) {
      let lx = 0;
      let lz = 0;
      if (onB[v]) {
        const a = prev[v];
        const c = next[v];
        lx = (p[a * 2] + p[c * 2]) / 2 - p[v * 2];
        lz = (p[a * 2 + 1] + p[c * 2 + 1]) / 2 - p[v * 2 + 1];
      } else {
        for (let k = np[v]; k < np[v + 1]; k++) (lx += p[nb[k] * 2] / (np[v + 1] - np[v])), (lz += p[nb[k] * 2 + 1] / (np[v + 1] - np[v]));
        lx = (lx - p[v * 2]) * 0.3;
        lz = (lz - p[v * 2 + 1]) * 0.3;
      }
      p[v * 2] += (acc[v * 2] / cnt[v]) * 0.5 + lx * 0.5;
      p[v * 2 + 1] += (acc[v * 2 + 1] / cnt[v]) * 0.5 + lz * 0.5;
      if (onB[v]) [p[v * 2], p[v * 2 + 1]] = onPlan(p[v * 2], p[v * 2 + 1], o);
    }
  }
  return { p, quads: new Uint32Array(quads), loop };
}

export interface FormOpts {
  /** Crown height after inversion (m). */
  rise: number;
  /** Number of arched openings (free edges) and their share of the perimeter each. */
  openings: number;
  openingWidth: number;
  /** Chain rest length / plan length (< 1: the net hangs pre-tensioned, every chain taut). */
  rest?: number;
  /** Mean node weight / chain stiffness (sets how deep the net sags before the rise is scaled). */
  weight?: number;
  /** Edge cable stiffness relative to the net, and its rest length / plan length. */
  edgeStiff?: number;
  edgeRest?: number;
  /** Load updates (each re-lumps self-weight from the current form) and DR steps per update. */
  passes?: number;
  iters?: number;
}

export interface FormResult {
  /** Funicular positions, xyz interleaved, supports on y = 0. */
  x: Float64Array;
  pinned: Uint8Array;
  /** Grid edges (pairs) and which of them are free edge arches; one bracing diagonal per quad (pairs). */
  edges: Uint32Array;
  edgeArch: Uint8Array;
  braces: Uint32Array;
  /** Total DR steps and final max |out-of-balance force| / mean node load. */
  iters: number;
  residual: number;
}

/**
 * Hang the net, find equilibrium by dynamic relaxation, invert it. The node weights are re-lumped from the
 * inverted form's own member lengths (ribs and braces of one section) a few times, so the shell ends up funicular
 * for its self-weight rather than for a load spread on plan.
 */
export function formFind(g: QuadGrid, seed: number, o: FormOpts): FormResult {
  const rng = new Rng(seed ^ 0x5f0f);
  const n = g.p.length / 2;
  // unique edges
  const seen = new Set<number>();
  const E: number[] = [];
  for (let q = 0; q < g.quads.length; q += 4)
    for (let k = 0; k < 4; k++) {
      const a = g.quads[q + k];
      const b = g.quads[q + ((k + 1) % 4)];
      if (!seen.has(ekey(a, b))) seen.add(ekey(a, b)), E.push(a, b);
    }
  const m = E.length / 2;
  // openings: arcs of the boundary loop left free, centred evenly round the plan with a seeded twist
  const pinned = new Uint8Array(n);
  const free = new Uint8Array(n);
  for (const v of g.loop) pinned[v] = 1;
  const nl = g.loop.length;
  const w = Math.max(2, Math.round(o.openingWidth * nl));
  const phase = rng.next();
  for (let k = 0; k < o.openings; k++) {
    const c = Math.floor(((k + phase) / o.openings) * nl + rng.range(-0.04, 0.04) * nl);
    for (let j = -Math.floor(w / 2) + 1; j < Math.ceil(w / 2); j++) {
      const v = g.loop[(((c + j) % nl) + nl) % nl];
      pinned[v] = 0;
      free[v] = 1;
    }
  }
  const arch = new Uint8Array(m);
  const loopNext = new Map<number, number>();
  g.loop.forEach((v, i) => loopNext.set(v, g.loop[(i + 1) % nl]));
  for (let e = 0; e < m; e++) {
    const a = E[2 * e];
    const b = E[2 * e + 1];
    if ((free[a] || free[b]) && (loopNext.get(a) === b || loopNext.get(b) === a)) arch[e] = 1;
  }
  // chains: rest length and stiffness k = EA / L0 (EA = 1 for the net)
  const L0 = new Float64Array(m);
  const k = new Float64Array(m);
  const load = new Float64Array(n);
  for (let e = 0; e < m; e++) {
    const a = E[2 * e];
    const b = E[2 * e + 1];
    const l = Math.hypot(g.p[a * 2] - g.p[b * 2], g.p[a * 2 + 1] - g.p[b * 2 + 1]);
    L0[e] = l * (arch[e] ? (o.edgeRest ?? 1.0) : (o.rest ?? 0.7));
    k[e] = (arch[e] ? (o.edgeStiff ?? 2) : 1) / L0[e];
    load[a] += l / 2;
    load[b] += l / 2;
  }
  const W = o.weight ?? 0.05;
  const normLoad = () => {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += load[i] / n;
    for (let i = 0; i < n; i++) load[i] *= W / mean;
  };
  normLoad();
  const x = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) (x[i * 3] = g.p[i * 2]), (x[i * 3 + 2] = g.p[i * 2 + 1]);
  const v = new Float64Array(n * 3);
  const F = new Float64Array(n * 3);
  const S = new Float64Array(n);
  const braces = new Uint32Array(g.quads.length / 2);
  const out = new Float64Array(n * 3);
  let total = 0;
  let res = Infinity;
  const passes = o.passes ?? 3;
  for (let pass = 0; pass < passes; pass++) {
    v.fill(0);
    for (let it = 0; it < (o.iters ?? 3000); it++, total++) {
      F.fill(0);
      S.fill(0);
      for (let i = 0; i < n; i++) F[i * 3 + 1] = -load[i];
      for (let e = 0; e < m; e++) {
        const a = E[2 * e] * 3;
        const b = E[2 * e + 1] * 3;
        const dx = x[b] - x[a];
        const dy = x[b + 1] - x[a + 1];
        const dz = x[b + 2] - x[a + 2];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        // tension-only chain
        const q = Math.max(0, k[e] * (l - L0[e])) / l;
        F[a] += q * dx;
        F[a + 1] += q * dy;
        F[a + 2] += q * dz;
        F[b] -= q * dx;
        F[b + 1] -= q * dy;
        F[b + 2] -= q * dz;
        const s = k[e] + q;
        S[a / 3] += s;
        S[b / 3] += s;
      }
      let worst = 0;
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        // fictitious mass = local stiffness (Δt = 1): stable, and every node relaxes at the same pace
        const mi = S[i] || 1;
        for (let c = 0; c < 3; c++) {
          const j = i * 3 + c;
          worst = Math.max(worst, Math.abs(F[j]));
          v[j] = v[j] * 0.9 + F[j] / mi;
          x[j] += v[j];
        }
      }
      res = worst / W;
      if (res < 2e-5) break;
    }
    // invert and scale the rise
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, -x[i * 3 + 1]);
    const sy = o.rise / (top || 1);
    for (let i = 0; i < n; i++) (out[i * 3] = x[i * 3]), (out[i * 3 + 1] = -x[i * 3 + 1] * sy || 0), (out[i * 3 + 2] = x[i * 3 + 2]);
    // brace each quad on its shorter diagonal; re-lump self-weight from the built form
    load.fill(0);
    const d = (a: number, b: number) => Math.hypot(out[a * 3] - out[b * 3], out[a * 3 + 1] - out[b * 3 + 1], out[a * 3 + 2] - out[b * 3 + 2]);
    for (let e = 0; e < m; e++) {
      const l = d(E[2 * e], E[2 * e + 1]);
      load[E[2 * e]] += l / 2;
      load[E[2 * e + 1]] += l / 2;
    }
    for (let q = 0, j = 0; q < g.quads.length; q += 4, j += 2) {
      const [a, b, c, dd] = g.quads.subarray(q, q + 4);
      const ac = d(a, c);
      const bd = d(b, dd);
      [braces[j], braces[j + 1]] = ac <= bd ? [a, c] : [b, dd];
      const l = Math.min(ac, bd);
      load[braces[j]] += l / 2;
      load[braces[j + 1]] += l / 2;
    }
    normLoad();
  }
  return { x: out, pinned, edges: new Uint32Array(E), edgeArch: arch, braces, iters: total, residual: res };
}

export interface GridshellOpts extends PlanOpts, FormOpts {
  /** Depth of the edge trusses that stiffen the free edges (m). */
  edgeDepth?: number;
}

/**
 * Plan → hanging form → braced frame (metres, supports on y = 0). A free edge of a pin-jointed net is a mechanism
 * (each edge node is held only by members lying in the shell's tangent plane), so every free edge becomes a
 * Warren edge truss: an inner chord hung below the edge along the inward shell normal, posts, alternating
 * diagonals, and ties from the inner chord to the ribs that meet the edge.
 */
export function gridshell(seed: number, o: GridshellOpts): Frame & { form: FormResult; grid: QuadGrid } {
  const grid = townscaperGrid(seed, o);
  const form = formFind(grid, seed, o);
  const { edges, edgeArch, pinned, braces } = form;
  const n0 = form.x.length / 3;
  const X = [...form.x];
  const ends: number[] = [];
  const role: number[] = [];
  const sill: number[] = [];
  const support = [...pinned];
  // ribs; a rib lying on the ground between two supports carries nothing and becomes the ground sill
  for (let e = 0; e < edges.length / 2; e++) {
    if (pinned[edges[2 * e]] && pinned[edges[2 * e + 1]]) {
      sill.push(edges[2 * e], edges[2 * e + 1]);
      continue;
    }
    ends.push(edges[2 * e], edges[2 * e + 1]);
    role.push(edgeArch[e] ? 2 : 0);
  }
  for (let j = 0; j < braces.length; j += 2) {
    if (pinned[braces[j]] && pinned[braces[j + 1]]) continue;
    ends.push(braces[j], braces[j + 1]);
    role.push(1);
  }
  // skin faces: CCW in (x, z) faces down, so reverse them to face up and out; node normals from them
  const faces: number[][] = [];
  const nrm = new Float64Array(n0 * 3);
  for (let q = 0; q < grid.quads.length; q += 4) {
    const [a, b, c, d] = grid.quads.subarray(q, q + 4);
    const f = [a, d, c, b];
    faces.push(f);
    for (let k = 0; k < 4; k++) {
      const p = f[k] * 3;
      const r = f[(k + 1) % 4] * 3;
      // Newell
      const nx = (X[p + 1] - X[r + 1]) * (X[p + 2] + X[r + 2]);
      const ny = (X[p + 2] - X[r + 2]) * (X[p] + X[r]);
      const nz = (X[p] - X[r]) * (X[p + 1] + X[r + 1]);
      for (const v of f) (nrm[v * 3] += nx), (nrm[v * 3 + 1] += ny), (nrm[v * 3 + 2] += nz);
    }
  }
  // edge trusses
  const depth = o.edgeDepth ?? Math.max(0.6, o.rise * 0.075);
  const inner = new Map<number, number>();
  const innerOf = (v: number) => {
    let w = inner.get(v);
    if (w !== undefined) return w;
    const l = Math.hypot(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]) || 1;
    w = X.length / 3;
    X.push(X[v * 3] - (nrm[v * 3] / l) * depth, Math.max(0, X[v * 3 + 1] - (nrm[v * 3 + 1] / l) * depth), X[v * 3 + 2] - (nrm[v * 3 + 2] / l) * depth);
    support.push(pinned[v]);
    inner.set(v, w);
    if (!pinned[v]) ends.push(v, w), role.push(2);
    return w;
  };
  const ribs = new Map<number, number[]>();
  for (let e = 0; e < edges.length / 2; e++)
    if (!edgeArch[e]) for (const [a, b] of [[edges[2 * e], edges[2 * e + 1]], [edges[2 * e + 1], edges[2 * e]]]) ribs.set(a, [...(ribs.get(a) ?? []), b]);
  let parity = 0;
  for (let e = 0; e < edges.length / 2; e++) {
    if (!edgeArch[e]) continue;
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    const ia = innerOf(a);
    const ib = innerOf(b);
    ends.push(ia, ib);
    role.push(2);
    if (parity++ & 1) ends.push(a, ib);
    else ends.push(ia, b);
    role.push(2);
  }
  for (const [v, w] of inner) {
    if (pinned[v]) continue;
    for (const j of ribs.get(v) ?? []) if (!inner.has(j)) ends.push(w, j), role.push(1);
  }
  const n = X.length / 3;
  const fixed = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) if (support[i]) fixed.fill(1, i * 3, i * 3 + 3);
  return { x: new Float64Array(X), ends: new Uint32Array(ends), fixed, faces, role: new Uint8Array(role), sill: new Uint32Array(sill), form, grid };
}
