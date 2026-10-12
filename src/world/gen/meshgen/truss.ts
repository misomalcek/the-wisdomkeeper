/**
 * Pin-jointed space trusses, solved by the direct stiffness method and sized by the forces they carry.
 * - Each member (i, j) with axial stiffness k = E·A / L and unit direction d adds k·d·dᵀ to the 3×3 blocks
 *   K_ii, K_jj and −k·d·dᵀ to K_ij, K_ji. K is stored block-sparse (one 3×3 block per node pair), supports are
 *   removed by masking their dofs, and K·u = f is solved by conjugate gradients with a block-Jacobi (node 3×3)
 *   preconditioner. Shallow, braced gridshells have soft near-mechanism modes that leave Jacobi-PCG creeping for
 *   hundreds of steps, so CG can instead be preconditioned by an envelope Cholesky factor of K (reverse
 *   Cuthill–McKee order keeps the envelope narrow); the sizing loop factors once and reuses that factor while the
 *   sizes change. The axial force is N = k·d·(u_j − u_i): tension positive, compression negative.
 * - Sizing: a member must not yield (γ·|N| ≤ A·f_y) and, in compression, not buckle (Euler,
 *   γ·|N| ≤ π²·E·I / (K·L)²). Radii come from those inequalities for a solid round bar or a thin tube, rounded up
 *   to a geometric catalogue of stock sizes (real frames use a handful of sections, so utilisation varies), and the
 *   loop repeats because self-weight (ρ·g·A·L, lumped half to each end) and the share of force a member attracts
 *   depend on the sizes it produces; after two passes sizes may only grow, so it settles.
 * - Envelope loads: snow on plan area (shape factor falling to zero at 60° slope, as in EN 1991-1-3) and wind
 *   pressure/suction on the faces of the skin the frame carries, lumped to the face corners.
 */
import { type V3, cross, sub } from './geo';

export interface Truss {
  /** Node positions, xyz interleaved (m). */
  x: Float64Array;
  /** Member end nodes, interleaved pairs. */
  ends: Uint32Array;
  /** Axial stiffness E·A per member (N). */
  EA: Float64Array;
  /** 1 = restrained, per dof (node·3 + axis). */
  fixed: Uint8Array;
  /** Nodal loads (N), xyz interleaved. */
  f: Float64Array;
}

export interface TrussSolution {
  /** Nodal displacements (m). */
  u: Float64Array;
  /** Member axial forces (N), tension +. */
  N: Float64Array;
  iters: number;
  /** Final relative residual |r| / |f|. */
  residual: number;
  /** The Cholesky factor used, if any (reuse it as the preconditioner of a nearby system). */
  factor?: Factor;
}

export interface SolveOpts {
  tol?: number;
  maxIter?: number;
  /** Warm start. */
  u0?: Float64Array;
  /**
   * 'jacobi' (default): node 3×3 block-Jacobi. 'cholesky': factor this K (envelope Cholesky, reverse Cuthill–McKee
   * order), so CG finishes in a step or two; or pass a factor kept from a nearby K (a previous sizing pass), which
   * stays a strong preconditioner while the member sizes change.
   */
  precond?: 'jacobi' | 'cholesky' | Factor;
}

/** Assemble K (block CSR) and solve K·u = f by preconditioned conjugate gradients. */
export function solveTruss(t: Truss, o: SolveOpts = {}): TrussSolution {
  const { x, ends, EA, fixed } = t;
  const n = x.length / 3;
  const m = ends.length / 2;
  // incidence lists
  const ip = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) ip[ends[2 * e] + 1]++, ip[ends[2 * e + 1] + 1]++;
  for (let i = 0; i < n; i++) ip[i + 1] += ip[i];
  const inc = new Int32Array(2 * m);
  const fill = ip.slice(0, n);
  for (let e = 0; e < m; e++) inc[fill[ends[2 * e]]++] = e, inc[fill[ends[2 * e + 1]]++] = e;
  // member direction and stiffness
  const dk = new Float64Array(m * 4);
  for (let e = 0; e < m; e++) {
    const a = ends[2 * e] * 3;
    const b = ends[2 * e + 1] * 3;
    const dx = x[b] - x[a];
    const dy = x[b + 1] - x[a + 1];
    const dz = x[b + 2] - x[a + 2];
    const L = Math.hypot(dx, dy, dz) || 1e-9;
    dk[e * 4] = dx / L;
    dk[e * 4 + 1] = dy / L;
    dk[e * 4 + 2] = dz / L;
    dk[e * 4 + 3] = EA[e] / L;
  }
  // block rows: the diagonal block first, then one block per distinct neighbour
  const rp = new Int32Array(n + 1);
  const col = new Int32Array(n + 2 * m);
  const val = new Float64Array((n + 2 * m) * 9);
  const mark = new Int32Array(n).fill(-1);
  let nb = 0;
  for (let i = 0; i < n; i++) {
    rp[i] = nb;
    col[nb] = i;
    mark[i] = nb++;
    for (let q = ip[i]; q < ip[i + 1]; q++) {
      const e = inc[q];
      const j = ends[2 * e] === i ? ends[2 * e + 1] : ends[2 * e];
      if (mark[j] < rp[i]) (col[nb] = j), (mark[j] = nb++);
    }
    for (let q = ip[i]; q < ip[i + 1]; q++) {
      const e = inc[q];
      const j = ends[2 * e] === i ? ends[2 * e + 1] : ends[2 * e];
      const k = dk[e * 4 + 3];
      const di = mark[i] * 9;
      const dj = mark[j] * 9;
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) {
          const v = k * dk[e * 4 + r] * dk[e * 4 + c];
          val[di + r * 3 + c] += v;
          val[dj + r * 3 + c] -= v;
        }
    }
  }
  rp[n] = nb;
  // supports: zero the restrained rows/columns; a whisper of ground stiffness keeps mechanisms from diverging
  let tr = 0;
  for (let i = 0; i < n; i++) tr += val[rp[i] * 9] + val[rp[i] * 9 + 4] + val[rp[i] * 9 + 8];
  const eps = (tr / (3 * n)) * 1e-9;
  for (let i = 0; i < n; i++) {
    for (let b = rp[i]; b < rp[i + 1]; b++) {
      const j = col[b];
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) if (fixed[i * 3 + r] || fixed[j * 3 + c]) val[b * 9 + r * 3 + c] = 0;
    }
    for (let r = 0; r < 3; r++) val[rp[i] * 9 + r * 4] += fixed[i * 3 + r] ? 1 : eps;
  }
  const N3 = 3 * n;
  const fac = o.precond === 'cholesky' ? factorise(n, rp, col, val, fixed) : typeof o.precond === 'object' ? o.precond : undefined;
  // block-Jacobi preconditioner: inverse of each diagonal 3×3
  const P = new Float64Array(fac ? 0 : n * 9);
  if (!fac) for (let i = 0; i < n; i++) inv3(val, rp[i] * 9, P, i * 9);
  const mul = (v: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      for (let b = rp[i]; b < rp[i + 1]; b++) {
        const j = col[b] * 3;
        const k = b * 9;
        const v0 = v[j];
        const v1 = v[j + 1];
        const v2 = v[j + 2];
        s0 += val[k] * v0 + val[k + 1] * v1 + val[k + 2] * v2;
        s1 += val[k + 3] * v0 + val[k + 4] * v1 + val[k + 5] * v2;
        s2 += val[k + 6] * v0 + val[k + 7] * v1 + val[k + 8] * v2;
      }
      out[i * 3] = s0;
      out[i * 3 + 1] = s1;
      out[i * 3 + 2] = s2;
    }
  };
  const prec = (r: Float64Array, z: Float64Array) => {
    if (fac) return applyFactor(fac, r, z);
    for (let i = 0; i < n; i++) {
      const k = i * 9;
      const a = i * 3;
      z[a] = P[k] * r[a] + P[k + 1] * r[a + 1] + P[k + 2] * r[a + 2];
      z[a + 1] = P[k + 3] * r[a] + P[k + 4] * r[a + 1] + P[k + 5] * r[a + 2];
      z[a + 2] = P[k + 6] * r[a] + P[k + 7] * r[a + 1] + P[k + 8] * r[a + 2];
    }
  };
  const f = new Float64Array(N3);
  for (let k = 0; k < N3; k++) f[k] = fixed[k] ? 0 : t.f[k];
  const u = new Float64Array(N3);
  if (o.u0) for (let k = 0; k < N3; k++) u[k] = fixed[k] ? 0 : o.u0[k];
  const r = new Float64Array(N3);
  const z = new Float64Array(N3);
  const p = new Float64Array(N3);
  const Ap = new Float64Array(N3);
  mul(u, Ap);
  let fn = 0;
  for (let k = 0; k < N3; k++) (r[k] = f[k] - Ap[k]), (fn += f[k] * f[k]);
  fn = Math.sqrt(fn) || 1;
  prec(r, z);
  p.set(z);
  let rz = 0;
  for (let k = 0; k < N3; k++) rz += r[k] * z[k];
  const tol = o.tol ?? 1e-9;
  const maxIter = o.maxIter ?? 4 * N3;
  let it = 0;
  let res = 0;
  for (; it < maxIter; it++) {
    let rr = 0;
    for (let k = 0; k < N3; k++) rr += r[k] * r[k];
    res = Math.sqrt(rr) / fn;
    if (res < tol) break;
    mul(p, Ap);
    let pAp = 0;
    for (let k = 0; k < N3; k++) pAp += p[k] * Ap[k];
    if (!(pAp > 0)) break;
    const al = rz / pAp;
    for (let k = 0; k < N3; k++) (u[k] += al * p[k]), (r[k] -= al * Ap[k]);
    prec(r, z);
    let rz1 = 0;
    for (let k = 0; k < N3; k++) rz1 += r[k] * z[k];
    const be = rz1 / rz;
    rz = rz1;
    for (let k = 0; k < N3; k++) p[k] = z[k] + be * p[k];
  }
  return { u, N: axialForces(x, ends, EA, u), iters: it, residual: res, factor: fac };
}

/** Envelope (skyline) Cholesky factor of K over the free dofs, in reverse Cuthill–McKee order. */
export interface Factor {
  /** Compact index per dof (−1 restrained). */
  map: Int32Array;
  /** First column and row offset of each envelope row; L packed row by row. */
  first: Int32Array;
  start: Int32Array;
  L: Float64Array;
  y: Float64Array;
}

function factorise(n: number, rp: Int32Array, col: Int32Array, val: Float64Array, fixed: Uint8Array): Factor {
  // reverse Cuthill–McKee from a pseudo-peripheral node of each component keeps the envelope narrow
  const degree = (i: number) => rp[i + 1] - rp[i];
  const order: number[] = [];
  const seen = new Uint8Array(n);
  const bfs = (s: number, mark: Uint8Array, out: number[]) => {
    out.length = 0;
    out.push(s);
    mark[s] = 1;
    for (let h = 0; h < out.length; h++) {
      const v = out[h];
      const nb: number[] = [];
      for (let b = rp[v]; b < rp[v + 1]; b++) if (!mark[col[b]]) (mark[col[b]] = 1), nb.push(col[b]);
      nb.sort((a, c) => degree(a) - degree(c));
      for (const w of nb) out.push(w);
    }
    return out;
  };
  const comp: number[] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0]) continue;
    let s = s0;
    for (let k = 0; k < 2; k++) {
      const tmp = new Uint8Array(n);
      bfs(s, tmp, comp);
      s = comp[comp.length - 1];
    }
    bfs(s, seen, comp);
    for (let k = comp.length - 1; k >= 0; k--) order.push(comp[k]);
  }
  const map = new Int32Array(3 * n).fill(-1);
  let m = 0;
  for (const v of order) for (let a = 0; a < 3; a++) if (!fixed[v * 3 + a]) map[v * 3 + a] = m++;
  // envelope: each row starts at the lowest coupled dof
  const first = new Int32Array(m);
  for (let v = 0; v < n; v++) {
    let lo = Infinity;
    for (let b = rp[v]; b < rp[v + 1]; b++) for (let a = 0; a < 3; a++) if (map[col[b] * 3 + a] >= 0) lo = Math.min(lo, map[col[b] * 3 + a]);
    for (let a = 0; a < 3; a++) if (map[v * 3 + a] >= 0) first[map[v * 3 + a]] = Math.min(lo, map[v * 3 + a]);
  }
  const start = new Int32Array(m + 1);
  for (let i = 0; i < m; i++) start[i + 1] = start[i] + (i - first[i] + 1);
  const L = new Float64Array(start[m]);
  // scatter the lower triangle of K
  for (let v = 0; v < n; v++)
    for (let b = rp[v]; b < rp[v + 1]; b++)
      for (let r = 0; r < 3; r++) {
        const i = map[v * 3 + r];
        if (i < 0) continue;
        for (let c = 0; c < 3; c++) {
          const j = map[col[b] * 3 + c];
          if (j >= 0 && j <= i) L[start[i] + j - first[i]] = val[b * 9 + r * 3 + c];
        }
      }
  // row-oriented envelope Cholesky
  for (let i = 0; i < m; i++) {
    const fi = first[i];
    const si = start[i] - fi;
    for (let j = fi; j <= i; j++) {
      const sj = start[j] - first[j];
      let sum = L[si + j];
      for (let k = Math.max(fi, first[j]); k < j; k++) sum -= L[si + k] * L[sj + k];
      L[si + j] = j < i ? sum / L[sj + j] : Math.sqrt(Math.max(sum, 1e-300));
    }
  }
  return { map, first, start, L, y: new Float64Array(m) };
}

function applyFactor(F: Factor, r: Float64Array, z: Float64Array) {
  const { map, first, start, L, y } = F;
  const m = y.length;
  for (let d = 0; d < map.length; d++) if (map[d] >= 0) y[map[d]] = r[d];
  for (let i = 0; i < m; i++) {
    const si = start[i] - first[i];
    let s = y[i];
    for (let k = first[i]; k < i; k++) s -= L[si + k] * y[k];
    y[i] = s / L[si + i];
  }
  for (let i = m - 1; i >= 0; i--) {
    const si = start[i] - first[i];
    y[i] /= L[si + i];
    const yi = y[i];
    for (let k = first[i]; k < i; k++) y[k] -= L[si + k] * yi;
  }
  for (let d = 0; d < map.length; d++) z[d] = map[d] >= 0 ? y[map[d]] : 0;
}

/** N = (E·A / L)·d·(u_j − u_i). */
export function axialForces(x: Float64Array, ends: Uint32Array, EA: Float64Array, u: Float64Array) {
  const N = new Float64Array(ends.length / 2);
  for (let e = 0; e < N.length; e++) {
    const a = ends[2 * e] * 3;
    const b = ends[2 * e + 1] * 3;
    const dx = x[b] - x[a];
    const dy = x[b + 1] - x[a + 1];
    const dz = x[b + 2] - x[a + 2];
    const L2 = dx * dx + dy * dy + dz * dz || 1e-18;
    N[e] = (EA[e] / L2) * (dx * (u[b] - u[a]) + dy * (u[b + 1] - u[a + 1]) + dz * (u[b + 2] - u[a + 2]));
  }
  return N;
}

function inv3(a: Float64Array, o: number, out: Float64Array, q: number) {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = [a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], a[o + 6], a[o + 7], a[o + 8]];
  const c0 = a4 * a8 - a5 * a7;
  const c1 = a5 * a6 - a3 * a8;
  const c2 = a3 * a7 - a4 * a6;
  const det = a0 * c0 + a1 * c1 + a2 * c2;
  if (Math.abs(det) < 1e-300) {
    // degenerate block: plain Jacobi
    out.fill(0, q, q + 9);
    out[q] = 1 / (a0 || 1);
    out[q + 4] = 1 / (a4 || 1);
    out[q + 8] = 1 / (a8 || 1);
    return;
  }
  const id = 1 / det;
  out[q] = c0 * id;
  out[q + 1] = (a2 * a7 - a1 * a8) * id;
  out[q + 2] = (a1 * a5 - a2 * a4) * id;
  out[q + 3] = c1 * id;
  out[q + 4] = (a0 * a8 - a2 * a6) * id;
  out[q + 5] = (a2 * a3 - a0 * a5) * id;
  out[q + 6] = c2 * id;
  out[q + 7] = (a1 * a6 - a0 * a7) * id;
  out[q + 8] = (a0 * a4 - a1 * a3) * id;
}

// --------------------------------------------------------------------------------------------- sizing

export interface Material {
  /** Young's modulus (Pa). */
  E: number;
  /** Design strength (Pa). */
  fy: number;
  /** Density (kg/m³). */
  rho: number;
}
/** Glulam (GL24h-ish design values) and structural steel (S275 tubes). */
export const TIMBER: Material = { E: 11e9, fy: 16e6, rho: 480 };
export const STEEL: Material = { E: 205e9, fy: 250e6, rho: 7850 };
const G = 9.81;

export interface SizingOpts {
  mat: Material;
  /** Solid round bar (wall undefined) or a tube with wall thickness = wall·r. */
  wall?: number;
  /** Load factor γ on forces. */
  gamma: number;
  /** Effective length factor (> 1 also covers the shell's global buckling and imperfections). */
  K: number;
  /** Smallest stock radius (m; one for all, or per member) and the catalogue step ratio between sizes. */
  rMin: number | Float64Array;
  step: number;
  rMax?: number;
  /** Most sizing passes (each re-solves with the new sizes and self-weight; stops once no size changes). */
  passes?: number;
}

export interface SizedTruss extends TrussSolution {
  /** Outer radius (m), area (m²), axial stress N/A (Pa) and utilisation (0..1+) per member. */
  r: Float64Array;
  A: Float64Array;
  stress: Float64Array;
  util: Float64Array;
  /** Steel/timber mass (kg). */
  mass: number;
}

/** Section constants for outer radius r: A = π r² a, I = π r⁴ i / 4. */
const section = (wall?: number) => {
  if (!wall) return { a: 1, i: 1 };
  const k = 1 - Math.min(1, wall);
  return { a: 1 - k * k, i: 1 - k ** 4 };
};

/**
 * Size a frame of given geometry. `extra` holds the applied loads (snow, wind, cladding; N, xyz interleaved);
 * member self-weight is added on every pass.
 */
export function sizeTruss(x: Float64Array, ends: Uint32Array, fixed: Uint8Array, extra: Float64Array, o: SizingOpts): SizedTruss {
  const m = ends.length / 2;
  const { a: ca, i: ci } = section(o.wall);
  const { E, fy, rho } = o.mat;
  const L = memberLengths(x, ends);
  const r0 = typeof o.rMin === 'number' ? new Float64Array(m).fill(o.rMin) : o.rMin;
  const r = r0.slice();
  const A = new Float64Array(m);
  const EA = new Float64Array(m);
  const f = new Float64Array(x.length);
  const passes = o.passes ?? 6;
  const lr = Math.log(o.step);
  let sol: TrussSolution | undefined;
  for (let pass = 0; ; pass++) {
    f.set(extra);
    for (let e = 0; e < m; e++) {
      A[e] = Math.PI * r[e] * r[e] * ca;
      EA[e] = E * A[e];
      const w = (rho * G * A[e] * L[e]) / 2;
      f[ends[2 * e] * 3 + 1] -= w;
      f[ends[2 * e + 1] * 3 + 1] -= w;
    }
    // the first pass factors K; later passes keep that factor as their preconditioner
    sol = solveTruss({ x, ends, EA, fixed, f }, { u0: sol?.u, tol: 1e-8, precond: sol?.factor ?? 'cholesky' });
    if (pass === passes) break;
    let changed = false;
    for (let e = 0; e < m; e++) {
      const P = o.gamma * Math.abs(sol.N[e]);
      let need = Math.sqrt(P / (Math.PI * fy * ca));
      if (sol.N[e] < 0) need = Math.max(need, Math.pow((4 * P * (o.K * L[e]) ** 2) / (Math.PI ** 3 * E * ci), 0.25));
      // round up to stock: rMin·stepᵏ; after two free passes sizes only grow, so the loop settles
      const k = Math.max(0, Math.ceil(Math.log(need / r0[e]) / lr - 1e-9));
      let rk = Math.min(o.rMax ?? Infinity, r0[e] * Math.exp(k * lr));
      if (pass >= 2) rk = Math.max(rk, r[e]);
      if (rk !== r[e]) changed = true;
      r[e] = rk;
    }
    if (!changed) break;
  }
  const s = sol!;
  const stress = new Float64Array(m);
  const util = new Float64Array(m);
  let mass = 0;
  for (let e = 0; e < m; e++) {
    stress[e] = s.N[e] / A[e];
    const P = o.gamma * Math.abs(s.N[e]);
    let cap = A[e] * fy;
    if (s.N[e] < 0) cap = Math.min(cap, (Math.PI ** 3 * E * ci * r[e] ** 4) / (4 * (o.K * L[e]) ** 2));
    util[e] = P / cap;
    mass += rho * A[e] * L[e];
  }
  return { ...s, r, A, stress, util, mass };
}

export function memberLengths(x: Float64Array, ends: Uint32Array) {
  const L = new Float64Array(ends.length / 2);
  for (let e = 0; e < L.length; e++) {
    const a = ends[2 * e] * 3;
    const b = ends[2 * e + 1] * 3;
    L[e] = Math.hypot(x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]);
  }
  return L;
}

// --------------------------------------------------------------------------------------------- frames & weather

/** A structural frame: nodes, members, supports and the skin faces it carries (outward-wound node loops). */
export interface Frame {
  x: Float64Array;
  ends: Uint32Array;
  fixed: Uint8Array;
  faces: number[][];
  /** Member role: 0 = rib/strut, 1 = bracing, 2 = edge arch. */
  role: Uint8Array;
  /** Ground sill between neighbouring supports (node pairs): meshed, carries nothing. */
  sill: Uint32Array;
}

export interface Weather {
  /** Snow on plan (N/m²), skin dead load (N/m²), wind pressure q (N/m²) and its horizontal direction. */
  snow: number;
  dead: number;
  wind: number;
  windDir: [number, number];
}

/** Lump snow, cladding weight and wind on the skin faces to their corner nodes. */
export function weatherLoads(fr: Frame, w: Weather): Float64Array {
  const f = new Float64Array(fr.x.length);
  const P = (i: number): V3 => [fr.x[i * 3], fr.x[i * 3 + 1], fr.x[i * 3 + 2]];
  const wd: V3 = [w.windDir[0], 0, w.windDir[1]];
  for (const face of fr.faces) {
    // Newell area vector (outward, |n| = area)
    let nx = 0;
    let ny = 0;
    let nz = 0;
    const p0 = P(face[0]);
    for (let k = 1; k + 1 < face.length; k++) {
      const c = cross(sub(P(face[k]), p0), sub(P(face[k + 1]), p0));
      nx += c[0] / 2;
      ny += c[1] / 2;
      nz += c[2] / 2;
    }
    const area = Math.hypot(nx, ny, nz) || 1e-9;
    const slope = Math.acos(Math.min(1, Math.abs(ny) / area));
    // EN 1991-1-3 shape factor: 0.8 up to 30°, falling to 0 at 60°
    const mu = 0.8 * Math.min(1, Math.max(0, (Math.PI / 3 - slope) / (Math.PI / 6)));
    let fy = -(w.dead * area + (ny > 0 ? w.snow * mu * ny : 0));
    // wind: pressure on the windward face (cp ≈ 0.8·cos), suction elsewhere (cp −0.5), acting along −n
    const cosw = -(nx * wd[0] + nz * wd[2]) / area;
    const cp = cosw > 0.2 ? 0.8 * cosw : -0.5;
    const fx = -cp * w.wind * nx;
    const fz = -cp * w.wind * nz;
    fy += -cp * w.wind * ny;
    const s = 1 / face.length;
    for (const i of face) (f[i * 3] += fx * s), (f[i * 3 + 1] += fy * s), (f[i * 3 + 2] += fz * s);
  }
  return f;
}
