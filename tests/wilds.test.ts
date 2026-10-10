import { describe, expect, it } from 'vitest';
import { Terrain } from '../src/world/terrain';
import { TerrainStreamer, CHUNK } from '../src/world/chunks';
import { STRATA } from '../src/story/strata';
import { WildField, Biome } from '../src/world/gen/field';
import { interpret, CANOPY_TREE, FERN_BUSH } from '../src/world/gen/lsystem';
import { vogel } from '../src/world/gen/phyllotaxis';
import { growHyphae } from '../src/world/gen/hyphae';
import { Rng } from '../src/util/rng';
import * as THREE from 'three';

const terrain = (wild: boolean, seed = 1234) => {
  const d = STRATA[0];
  return new Terrain({ radius: 80, amp: d.terrain.amp, freq: d.terrain.freq, river: false, seed, palette: d.palette, grid: 0.6, wild, flavour: 'seedbed' });
};

describe('infinite Wilds', () => {
  it('is deterministic and continuous across the core seam', () => {
    const a = terrain(true);
    const b = terrain(true);
    for (const [x, z] of [[0, 0], [90, 10], [400, -300], [-5000, 7000]]) expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
    // no cliffs where the authored core hands over to the Wilds
    for (let r = 60; r < 160; r += 0.5) {
      const d = Math.abs(a.heightAt(r + 0.5, 3) - a.heightAt(r, 3));
      expect(d).toBeLessThan(0.75);
    }
  });

  it('keeps boss arenas closed by the rim wall', () => {
    const t = terrain(false);
    expect(t.heightAt(110, 0)).toBeGreaterThan(t.heightAt(30, 0) + 10);
    expect(t.wild).toBeNull();
  });

  it('is mostly walkable', () => {
    const t = terrain(true, 99);
    const rng = new Rng(3);
    let steep = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const a = rng.range(0, 6.28);
      const r = rng.range(150, 900);
      if (Math.atan(t.slopeAt(Math.cos(a) * r, Math.sin(a) * r)) > Math.PI / 4) steep++;
    }
    expect(steep / N).toBeLessThan(0.04);
  });

  it('lays every biome out on the Voronoi lattice', () => {
    const f = new WildField(42, 'seedbed');
    const seen = new Set<Biome>();
    for (let x = -2000; x < 2000; x += 60) for (let z = -2000; z < 2000; z += 60) seen.add(f.biomeAt(x, z).biome);
    expect(seen.size).toBe(4);
  });

  it('builds seamless chunk edges', () => {
    const t = terrain(true);
    const s = new TerrainStreamer(t);
    const a = s.geometry(3, 1, 48).attributes.position.array;
    const b = s.geometry(4, 1, 24).attributes.position.array;
    // shared edge x = 4*CHUNK: every coarse vertex sits exactly on the fine chunk's surface
    for (let j = 0; j <= 24; j++) {
      const yb = b[(j * 25) * 3 + 1];
      const ya = a[(j * 2 * 49 + 48) * 3 + 1];
      expect(b[(j * 25) * 3]).toBe(4 * CHUNK);
      expect(Math.abs(ya - yb)).toBeLessThan(1e-4);
    }
  });
});

describe('phyto / mycelial / fractal generators', () => {
  it('L-system canopy trees branch fractally and stay upright', () => {
    let segs = 0;
    let leaves = 0;
    let top = 0;
    interpret(CANOPY_TREE, new THREE.Vector3(), new Rng(1), 1, (s) => {
      segs++;
      top = Math.max(top, s.a.y + s.dir.y * s.len);
    }, () => leaves++);
    expect(segs).toBeGreaterThan(200);
    expect(leaves).toBeGreaterThan(100);
    expect(top).toBeGreaterThan(8);
    let fern = 0;
    interpret(FERN_BUSH, new THREE.Vector3(), new Rng(2), 1, () => fern++, () => undefined);
    expect(fern).toBeGreaterThan(30);
  });

  it('phyllotaxis follows Vogel: r = c·√n at the golden angle', () => {
    const p5 = vogel(5, 2);
    expect(p5.r).toBeCloseTo(2 * Math.sqrt(5.5));
    const d = vogel(6, 1).a - vogel(5, 1).a;
    expect(d).toBeCloseTo(Math.PI * (3 - Math.sqrt(5)));
  });

  it('mycelial cords meet their neighbours at shared edge hubs', () => {
    const a = growHyphae(0, 0, CHUNK, 7, 600);
    const b = growHyphae(1, 0, CHUNK, 7, 600);
    const onEdge = (s: typeof a, x: number) => s.filter((g) => Math.abs(g.x1 - x) < 1e-6).map((g) => g.z1.toFixed(4));
    const ea = onEdge(a, CHUNK);
    const eb = b.filter((g) => Math.abs(g.x1 - CHUNK) < 1e-6).map((g) => g.z1.toFixed(4));
    expect(ea.length).toBeGreaterThan(0);
    expect(eb.length).toBeGreaterThan(0);
    expect(ea.some((z) => eb.includes(z))).toBe(true);
    expect(a.some((g) => g.kind === 1)).toBe(true);
  });
});
