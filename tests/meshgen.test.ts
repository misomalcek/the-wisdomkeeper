import { describe, expect, it } from 'vitest';
import { MeshBuilder, type MeshArrays } from '../src/world/gen/meshgen/geo';
import { surfaceNets } from '../src/world/gen/meshgen/sdf';
import { TREE_SPECIES, TREE_LODS, buildTree, buildTuft, daVinci, growSkeleton } from '../src/world/gen/meshgen/trees';
import { buildBoulder, buildHoodoo, buildCrystalCluster } from '../src/world/gen/meshgen/rocks';
import { FORMATIONS, buildFormation } from '../src/world/gen/meshgen/fractals';
import { buildHorizon, HORIZON_RINGS, HORIZON_SEGS } from '../src/world/gen/horizonMesh';
import { GroundShape } from '../src/world/gen/shape';

/** Fraction of triangles whose winding agrees with their first vertex normal (1 = every face points outward). */
const outward = (m: MeshArrays) => {
  let ok = 0;
  const n = m.idx.length / 3;
  for (let t = 0; t < m.idx.length; t += 3) {
    const [a, b, c] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
    const u = [0, 1, 2].map((k) => m.pos[b * 3 + k] - m.pos[a * 3 + k]);
    const v = [0, 1, 2].map((k) => m.pos[c * 3 + k] - m.pos[a * 3 + k]);
    const nx = u[1] * v[2] - u[2] * v[1];
    const ny = u[2] * v[0] - u[0] * v[2];
    const nz = u[0] * v[1] - u[1] * v[0];
    if (nx * m.nor[a * 3] + ny * m.nor[a * 3 + 1] + nz * m.nor[a * 3 + 2] > 0) ok++;
  }
  return ok / n;
};
const finite = (m: MeshArrays) => [...m.pos, ...m.nor].every(Number.isFinite) && m.idx.every((i) => i < m.pos.length / 3);

describe('generated geometry (gen/meshgen)', () => {
  it('surface nets mesh a sphere closed and outward', () => {
    const b = new MeshBuilder();
    surfaceNets((x, y, z) => Math.hypot(x, y, z) - 1, [-1.5, -1.5, -1.5], [1.5, 1.5, 1.5], 20, b, () => [0, 0, 0]);
    const m = b.build(false);
    expect(outward(m)).toBe(1);
    for (let i = 0; i < m.pos.length; i += 3) expect(Math.abs(Math.hypot(m.pos[i], m.pos[i + 1], m.pos[i + 2]) - 1)).toBeLessThan(0.04);
  });

  it('grows every tree species deterministically, upright, within its triangle budget', () => {
    for (const sp of TREE_SPECIES) {
      const a = buildTree(sp, 7, TREE_LODS[0]);
      const b = buildTree(sp, 7, TREE_LODS[0]);
      expect(a.pos).toEqual(b.pos);
      expect(finite(a)).toBe(true);
      expect(outward(a)).toBeGreaterThan(0.97);
      expect(a.height).toBeGreaterThan(1.5);
      expect(a.idx.length / 3).toBeLessThan(9000);
      const lo = buildTree(sp, 7, TREE_LODS[1]);
      expect(lo.idx.length).toBeLessThan(a.idx.length * 0.6);
    }
  });

  it("splits radii by da Vinci's rule at every fork", () => {
    for (const shares of [[1, 1], [2.2, 1, 0.8], [0.7, 1.3, 1, 0.9]]) {
      const r = daVinci(0.4, shares, 2.3);
      expect(Math.abs(r.reduce((a, x) => a + x ** 2.3, 0) / 0.4 ** 2.3 - 1)).toBeLessThan(1e-9);
      expect(Math.max(...r)).toBe(r[shares.indexOf(Math.max(...shares))]);
    }
    // and the trees taper: no child is ever thicker than the branch it grows from
    const { s } = growSkeleton(TREE_SPECIES[0], 3);
    s.parent.forEach((p, i) => p >= 0 && expect(s.r[i]).toBeLessThanOrEqual(s.r[p] * 1.0001));
  });

  it('builds stones, crystals and grass that face outward', () => {
    for (const m of [buildBoulder(1, 18), buildHoodoo(1, 18), buildCrystalCluster(1)]) {
      expect(finite(m)).toBe(true);
      expect(outward(m)).toBe(1);
    }
    // grass blades are two-sided; their normals lean up, so only most faces agree
    expect(outward(buildTuft(1))).toBeGreaterThan(0.9);
  });

  it('meshes every fractal formation standing on the ground with unit height', () => {
    for (const f of FORMATIONS) {
      const m = buildFormation(f, 24);
      expect(finite(m)).toBe(true);
      expect(m.idx.length / 3).toBeGreaterThan(500);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 1; i < m.pos.length; i += 3) (lo = Math.min(lo, m.pos[i])), (hi = Math.max(hi, m.pos[i]));
      expect(lo).toBeCloseTo(0, 5);
      expect(hi).toBeCloseTo(1, 5);
      expect(outward(m)).toBeGreaterThan(0.85);
    }
  });

  it('builds the far horizon ring on the same ground, normals up', () => {
    const shape = new GroundShape({ radius: 120, amp: 1.2, freq: 0.03, river: false, seed: 5, wild: true, flavour: 'seedbed', features: { erosion: true, terrace: true, orbit: true, landforms: true } });
    const h = buildHorizon(shape, 300, -200);
    expect(h.pos.length).toBe(HORIZON_RINGS * HORIZON_SEGS * 3);
    for (let v = 0; v < h.pos.length / 3; v += 97) {
      expect(h.nor[v * 3 + 1]).toBeGreaterThan(0);
      if (v > HORIZON_SEGS * 12) expect(h.pos[v * 3 + 1]).toBeCloseTo(shape.heightAt(h.pos[v * 3], h.pos[v * 3 + 2]), 3);
    }
    // faces point up (counter-clockwise seen from above)
    let up = 0;
    for (let t = 0; t < h.idx.length; t += 3) {
      const [a, b, c] = [h.idx[t], h.idx[t + 1], h.idx[t + 2]];
      const ux = h.pos[b * 3] - h.pos[a * 3], uz = h.pos[b * 3 + 2] - h.pos[a * 3 + 2];
      const vx = h.pos[c * 3] - h.pos[a * 3], vz = h.pos[c * 3 + 2] - h.pos[a * 3 + 2];
      if (uz * vx - ux * vz > 0) up++;
    }
    expect(up).toBe(h.idx.length / 3);
  });
});
