import { describe, expect, it } from 'vitest';
import type { MeshArrays } from '../src/world/gen/meshgen/geo';
import { STEEL, TIMBER, sizeTruss, solveTruss, type Truss } from '../src/world/gen/meshgen/truss';
import { formFind, gridshell, townscaperGrid } from '../src/world/gen/meshgen/gridshell';
import { geodesicDome, geodesicSphere } from '../src/world/gen/meshgen/dome';
import { STATIONS, analyseStation, buildStation, type StationSpec } from '../src/world/gen/meshgen/stations';

/** Fraction of triangles (optionally filtered by their first vertex) whose winding agrees with the vertex normal. */
const outward = (m: MeshArrays, keep: (v: number) => boolean = () => true) => {
  let ok = 0;
  let n = 0;
  for (let t = 0; t < m.idx.length; t += 3) {
    const [a, b, c] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
    if (!keep(a)) continue;
    n++;
    const u = [0, 1, 2].map((k) => m.pos[b * 3 + k] - m.pos[a * 3 + k]);
    const v = [0, 1, 2].map((k) => m.pos[c * 3 + k] - m.pos[a * 3 + k]);
    const nx = u[1] * v[2] - u[2] * v[1];
    const ny = u[2] * v[0] - u[0] * v[2];
    const nz = u[0] * v[1] - u[1] * v[0];
    if (nx * m.nor[a * 3] + ny * m.nor[a * 3 + 1] + nz * m.nor[a * 3 + 2] > 0) ok++;
  }
  return ok / n;
};
const finite = (m: MeshArrays) => [m.pos, m.nor, m.aux].every((a) => a.every(Number.isFinite)) && m.idx.every((i) => i < m.pos.length / 3);
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

/** A truss with every node free in x, y and z unless listed. */
function truss(nodes: number[][], bars: number[][], EA: number, fixed: [number, number[]][], loads: [number, number[]][]): Truss {
  const n = nodes.length;
  const fx = new Uint8Array(n * 3);
  for (const [i, axes] of fixed) for (const a of axes) fx[i * 3 + a] = 1;
  const f = new Float64Array(n * 3);
  for (const [i, v] of loads) for (let a = 0; a < 3; a++) f[i * 3 + a] += v[a];
  return { x: new Float64Array(nodes.flat()), ends: new Uint32Array(bars.flat()), EA: new Float64Array(bars.length).fill(EA), fixed: fx, f };
}

describe('pin-jointed truss solver (gen/meshgen/truss)', () => {
  it('solves the two-bar V and the three-legged tripod by hand', () => {
    for (const precond of ['jacobi', 'cholesky'] as const) {
      // V: legs at 45°, 10 kN down at the apex → each leg −10/(2 sin 45°)
      const v = truss([[-1, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 2], [1, 2]], 1e8, [[0, [0, 1, 2]], [1, [0, 1, 2]], [2, [2]]], [[2, [0, -1e4, 0]]]);
      const sv = solveTruss(v, { precond });
      for (const N of sv.N) expect(N / (-1e4 / (2 * Math.SQRT1_2))).toBeCloseTo(1, 6);
      // tripod: apex h above a base circle of radius R, P down → each leg −P·ℓ/(3h)
      const R = 2;
      const h = 3;
      const base = [0, 1, 2].map((k) => [R * Math.cos((k * 2 * Math.PI) / 3), 0, R * Math.sin((k * 2 * Math.PI) / 3)]);
      const t = truss([...base, [0, h, 0]], [[0, 3], [1, 3], [2, 3]], 2e8, [0, 1, 2].map((i) => [i, [0, 1, 2]] as [number, number[]]), [[3, [0, -6e4, 0]]]);
      const st = solveTruss(t, { precond });
      for (const N of st.N) expect(N / ((-6e4 * Math.hypot(R, h)) / (3 * h))).toBeCloseTo(1, 6);
      // and the apex settles by N·L/EA along each leg, projected: δ = P·ℓ³ / (3·EA·h²)
      expect(st.u[3 * 3 + 1] / (-(6e4 * Math.hypot(R, h) ** 3) / (3 * 2e8 * h * h))).toBeCloseTo(1, 6);
    }
  });

  it('matches the method of sections on a simply supported Warren truss within 1%', () => {
    // 8 panels of d, depth h; bottom nodes 0..8, top nodes at the half panels; P at mid-span
    const panels = 8;
    const d = 3;
    const h = 2.5;
    const P = 5e4;
    const nodes: number[][] = [];
    for (let k = 0; k <= panels; k++) nodes.push([k * d, 0, 0]);
    for (let k = 0; k < panels; k++) nodes.push([(k + 0.5) * d, h, 0]);
    const top = (k: number) => panels + 1 + k;
    const bars: number[][] = [];
    for (let k = 0; k < panels; k++) bars.push([k, k + 1], [k, top(k)], [top(k), k + 1]);
    for (let k = 0; k + 1 < panels; k++) bars.push([top(k), top(k + 1)]);
    // pin at the left, roller at the right; every node held out of plane
    const fixed: [number, number[]][] = nodes.map((_, i) => [i, [2]]);
    fixed.push([0, [0, 1]], [panels, [1]]);
    for (const precond of ['jacobi', 'cholesky'] as const) {
      const s = solveTruss(truss(nodes, bars, 4e8, fixed, [[panels / 2, [0, -P, 0]]]), { precond });
      const L = panels * d;
      const force = (a: number, b: number) => s.N[bars.findIndex((m) => (m[0] === a && m[1] === b) || (m[0] === b && m[1] === a))];
      // top chord over mid-span: moment P·L/4 about the mid bottom node
      expect(force(top(panels / 2 - 1), top(panels / 2)) / (-(P * L) / (4 * h))).toBeCloseTo(1, 2);
      // bottom chord just left of mid-span: moment (P/2)(L/2 − d/2) about the top node above it
      expect(force(panels / 2 - 1, panels / 2) / ((P / 2) * (L / 2 - d / 2) / h)).toBeCloseTo(1, 2);
      // end diagonal carries the reaction P/2 up its slope
      expect(force(0, top(0)) / ((-P / 2) * (Math.hypot(d / 2, h) / h))).toBeCloseTo(1, 2);
    }
  });

  it('sizes members for yield and Euler buckling, to the smallest stock that holds', () => {
    // a steep V: both legs in compression, buckling governs a long thin tube
    const x = new Float64Array([-1.5, 0, 0, 1.5, 0, 0, 0, 4, 0]);
    const ends = new Uint32Array([0, 2, 1, 2]);
    const fixed = new Uint8Array([1, 1, 1, 1, 1, 1, 0, 0, 1]);
    const f = new Float64Array([0, 0, 0, 0, 0, 0, 0, -2e5, 0]);
    const o = { mat: STEEL, wall: 0.08, gamma: 1.5, K: 1, rMin: 0.02, step: 1.2 };
    const z = sizeTruss(x, ends, fixed, f, o);
    for (let e = 0; e < 2; e++) {
      expect(z.N[e]).toBeLessThan(0);
      expect(z.util[e]).toBeLessThanOrEqual(1);
      // one stock size down would buckle
      const r = z.r[e] / o.step;
      const ci = 1 - (1 - o.wall) ** 4;
      const Pcr = (Math.PI ** 3 * STEEL.E * ci * r ** 4) / (4 * Math.hypot(1.5, 4) ** 2);
      expect(o.gamma * -z.N[e]).toBeGreaterThan(Math.min(Pcr, Math.PI * r * r * (1 - (1 - o.wall) ** 2) * STEEL.fy));
    }
    // hang the load instead: the legs go into tension and yield governs
    f[7] = 2e5;
    const t = sizeTruss(x, ends, fixed, f, o);
    for (let e = 0; e < 2; e++) {
      expect(t.N[e]).toBeGreaterThan(0);
      expect(t.util[e]).toBeLessThanOrEqual(1);
      expect(t.r[e]).toBeLessThan(z.r[e]);
    }
  });

  it('solves a ~1500-member gridshell quickly and both preconditioners agree', () => {
    const g = gridshell(7, { rings: 6, a: 19, b: 13, e: 2.6, rise: 9, openings: 3, openingWidth: 0.12 });
    const m = g.ends.length / 2;
    expect(m).toBeGreaterThan(1300);
    const EA = new Float64Array(m).fill(TIMBER.E * 0.01);
    const f = new Float64Array(g.x.length);
    for (let i = 1; i < f.length; i += 3) f[i] = -2000;
    const t: Truss = { x: g.x, ends: g.ends, EA, fixed: g.fixed, f };
    solveTruss(t, { precond: 'cholesky' });
    const t0 = performance.now();
    const a = solveTruss(t, { precond: 'cholesky' });
    const ms = performance.now() - t0;
    // ~10 ms on its own; loose, since the suites run in parallel
    expect(ms).toBeLessThan(250);
    const b = solveTruss(t, { precond: 'jacobi', tol: 1e-10 });
    let nmax = 0;
    for (const N of a.N) nmax = Math.max(nmax, Math.abs(N));
    for (let e = 0; e < m; e++) expect(Math.abs(a.N[e] - b.N[e]) / nmax).toBeLessThan(1e-4);
  });
});

describe('gridshell form finding (gen/meshgen/gridshell)', () => {
  const opts = { rings: 5, a: 15, b: 11, e: 2.4, rise: 9, openings: 3, openingWidth: 0.11 };

  it('builds a deterministic all-quad Townscaper grid of near-square, unfolded quads', () => {
    const g = townscaperGrid(3, opts);
    expect(g.p).toEqual(townscaperGrid(3, opts).p);
    expect(g.p).not.toEqual(townscaperGrid(4, opts).p);
    expect(g.quads.length % 4).toBe(0);
    let dev = 0;
    for (let q = 0; q < g.quads.length; q += 4) {
      // counter-clockwise in (x, z): positive area, so nothing folded over
      let area = 0;
      for (let k = 0; k < 4; k++) {
        const a = g.quads[q + k];
        const b = g.quads[q + ((k + 1) % 4)];
        area += g.p[a * 2] * g.p[b * 2 + 1] - g.p[b * 2] * g.p[a * 2 + 1];
      }
      expect(area).toBeGreaterThan(0);
      for (let k = 0; k < 4; k++) {
        const [a, b, c] = [g.quads[q + ((k + 3) % 4)], g.quads[q + k], g.quads[q + ((k + 1) % 4)]];
        const u = [g.p[a * 2] - g.p[b * 2], g.p[a * 2 + 1] - g.p[b * 2 + 1]];
        const v = [g.p[c * 2] - g.p[b * 2], g.p[c * 2 + 1] - g.p[b * 2 + 1]];
        dev += Math.abs(Math.acos((u[0] * v[0] + u[1] * v[1]) / Math.hypot(u[0], u[1]) / Math.hypot(v[0], v[1])) - Math.PI / 2) / g.quads.length;
      }
    }
    // mean corner within ~20° of square
    expect(dev).toBeLessThan(0.35);
  });

  it('relaxes to equilibrium and the inverted net stands in compression under its own weight', () => {
    const g = townscaperGrid(3, opts);
    const form = formFind(g, 3, opts);
    expect(form.residual).toBeLessThan(1e-4);
    let top = 0;
    for (let i = 0; i < form.x.length / 3; i++) {
      if (form.pinned[i]) expect(form.x[i * 3 + 1]).toBe(0);
      top = Math.max(top, form.x[i * 3 + 1]);
    }
    expect(top).toBeCloseTo(opts.rise, 6);
    const fr = gridshell(3, opts);
    const z = sizeTruss(fr.x, fr.ends, fr.fixed, new Float64Array(fr.x.length), { mat: TIMBER, gamma: 1.5, K: 2, rMin: 0.06, step: 1.22 });
    // the form-found ribs: (nearly) all in compression
    let ribs = 0;
    let comp = 0;
    let tension = 0;
    let total = 0;
    for (let e = 0; e < z.N.length; e++) {
      total += Math.abs(z.N[e]);
      if (z.N[e] > 0) tension += z.N[e];
      if (fr.role[e] !== 0) continue;
      ribs++;
      if (z.N[e] < 0) comp++;
    }
    expect(comp / ribs).toBeGreaterThan(0.95);
    // the bracing and edge trusses idle: tension is a few per cent of all the force in the frame
    expect(tension / total).toBeLessThan(0.05);
  });
});

describe('geodesic domes (gen/meshgen/dome)', () => {
  it('subdivides the icosahedron into 10ν² + 2 points on the sphere', () => {
    for (const nu of [2, 3, 4, 5]) {
      const s = geodesicSphere(nu);
      expect(s.pts.length).toBe(10 * nu * nu + 2);
      expect(s.tris.length).toBe(20 * nu * nu);
    }
  });

  it('cuts a dome with a flat, pinned base and every node on the sphere', () => {
    for (const [freq, fraction] of [[3, 5 / 8], [4, 1 / 2], [5, 5 / 8]]) {
      const d = geodesicDome({ freq, fraction, diameter: 24 });
      let lo = Infinity;
      let hi = 0;
      for (let i = 0; i < d.x.length / 3; i++) {
        const y = d.x[i * 3 + 1];
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
        if (d.fixed[i * 3]) expect(y).toBe(0);
      }
      expect(lo).toBe(0);
      // centre of the sphere is hi − R above the base
      const cy = hi - 12;
      for (let i = 0; i < d.x.length / 3; i++) expect(Math.hypot(d.x[i * 3], d.x[i * 3 + 1] - cy, d.x[i * 3 + 2])).toBeCloseTo(12, 6);
      expect(Math.abs(hi / 24 - fraction)).toBeLessThan(0.09);
      // fully triangulated: the solver finds it stiff
      const z = sizeTruss(d.x, d.ends, d.fixed, new Float64Array(d.x.length), { mat: STEEL, wall: 0.06, gamma: 1.5, K: 1.5, rMin: 0.03, step: 1.22 });
      let umax = 0;
      for (const u of z.u) umax = Math.max(umax, Math.abs(u));
      expect(umax).toBeLessThan(0.01);
    }
  });
});

describe('atlas stations (gen/meshgen/stations)', () => {
  const fresh = (s: StationSpec): StationSpec => JSON.parse(JSON.stringify(s));

  it('builds every station deterministically, standing on the ground, within budget', () => {
    for (const s of STATIONS) {
      const a = buildStation(fresh(s), 0);
      const b = buildStation(fresh(s), 0);
      expect(same(a.pos, b.pos) && same(a.aux, b.aux) && same(a.idx, b.idx)).toBe(true);
      const lo = buildStation(fresh(s), 1);
      for (const [m, budget] of [[a, 60000], [lo, 12000]] as const) {
        expect(finite(m)).toBe(true);
        expect(m.idx.length / 3).toBeLessThanOrEqual(budget);
        let ymin = Infinity;
        for (let i = 1; i < m.pos.length; i += 3) ymin = Math.min(ymin, m.pos[i]);
        expect(ymin).toBeCloseTo(0, 5);
        // struts, hubs, sills and shoes face out; panels are two-sided
        expect(outward(m, (v) => m.aux[v * 4] < 1.5)).toBe(1);
        // aux: part kind, signed stress in [−1, 1], height and utilisation in [0, 1]
        let bad = 0;
        const kinds = new Set<number>();
        for (let v = 0; v < m.aux.length / 4; v++) {
          kinds.add(m.aux[v * 4]);
          if (Math.abs(m.aux[v * 4 + 1]) > 1 || m.aux[v * 4 + 2] < 0 || m.aux[v * 4 + 2] > 1 + 1e-6) bad++;
          if (m.aux[v * 4 + 3] < 0 || m.aux[v * 4 + 3] > 1) bad++;
        }
        expect(bad).toBe(0);
        expect([...kinds].every((k) => k === 0 || k === 1 || k === 2)).toBe(true);
        expect(kinds.has(0)).toBe(true);
      }
      expect(lo.idx.length).toBeLessThan(a.idx.length * 0.35);
      // real metres: domes 18–30 m across, gridshells 25–40 m spans
      const span = 2 * a.radius;
      if (s.kind === 'dome') expect(span).toBeGreaterThan(16), expect(span).toBeLessThan(31);
      else expect(span).toBeGreaterThan(24), expect(span).toBeLessThan(42);
      expect(a.height).toBeGreaterThan(8);
      // the full mesh carries skin panels
      expect(a.aux.some((k, i) => i % 4 === 0 && k === 2)).toBe(true);
    }
  }, 30000);

  it('sizes every member to hold the weather, with tension and compression both present', () => {
    for (const s of STATIONS) {
      const { sized, frame } = analyseStation(fresh(s));
      let tens = 0;
      let umax = 0;
      for (let e = 0; e < sized.N.length; e++) {
        expect(sized.util[e]).toBeLessThanOrEqual(1);
        if (sized.N[e] > 0) tens++;
      }
      for (let i = 0; i < sized.u.length; i += 3) umax = Math.max(umax, Math.hypot(sized.u[i], sized.u[i + 1], sized.u[i + 2]));
      expect(tens).toBeGreaterThan(0);
      expect(tens).toBeLessThan(sized.N.length * 0.6);
      // stiff enough to stand: deflection under the weather within span / 100
      let r = 0;
      for (let i = 0; i < frame.x.length; i += 3) r = Math.max(r, Math.hypot(frame.x[i], frame.x[i + 2]));
      expect(umax).toBeLessThan((2 * r) / 100);
      // and more than one stock size is in use
      expect(new Set(sized.r).size).toBeGreaterThan(1);
    }
  });
});
