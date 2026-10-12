import { describe, expect, it } from 'vitest';
import { GroundShape, type ShapeOpts } from '../src/world/gen/shape';
import { WildField, NO_FEATURES } from '../src/world/gen/field';
import { bakeJuliaSDF, isleProfile, OrbitIsles } from '../src/world/gen/orbit';
import { buildChunkArrays } from '../src/world/gen/chunkMesh';
import { baseGenome, GENE_KEYS, GENES, genomeGrammar, juliaConstant, lineageDrifts, mutate, neutralGenome, parseMutation, regionGenome } from '../src/world/genome';
import { makeNoise2D, makeNoise2DD, Rng } from '../src/util/rng';
import { LivingField } from '../src/bio/livingField';
import { hexLinear, linearToOklab, mixOklab, oklabToLinear, oklch, toOklch } from '../src/engine/color';

const FULL = { erosion: true, terrace: true, orbit: true };
const opts = (seed: number, features = FULL, genome = baseGenome(seed, 'seedbed')): ShapeOpts => ({ radius: 80, amp: 1.2, freq: 0.03, river: false, seed, wild: true, flavour: 'seedbed', genome, features });

/** A world point inside the first isle found near the origin's lattice. */
function findIsle(f: WildField) {
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
    const isle = f.isles!.isleAt(i, j);
    if (isle) return isle;
  }
  throw new Error('no isle');
}

describe('derivative noise', () => {
  it('matches the value noise and its finite-difference gradient', () => {
    const n = makeNoise2D(77);
    const d = makeNoise2DD(77);
    const o = new Float64Array(3);
    const rng = new Rng(5);
    for (let i = 0; i < 200; i++) {
      const x = rng.range(-50, 50), y = rng.range(-50, 50);
      d(x, y, o);
      expect(o[0]).toBeCloseTo(n(x, y), 10);
      const e = 1e-5;
      expect(o[1]).toBeCloseTo((n(x + e, y) - n(x - e, y)) / (2 * e), 4);
      expect(o[2]).toBeCloseTo((n(x, y + e) - n(x, y - e)) / (2 * e), 4);
    }
  });
});

describe('analytic gradient of the rolling land', () => {
  it('matches finite differences through the domain warp', () => {
    const f = new WildField(5, 'seedbed', baseGenome(5, 'river'), FULL);
    for (const [x, z] of [[100, 200], [-900, 40], [3000, -1200]]) {
      const [, gx, gz] = f.rolling(x, z);
      const e = 0.01;
      expect(gx).toBeCloseTo((f.rolling(x + e, z)[0] - f.rolling(x - e, z)[0]) / (2 * e), 4);
      expect(gz).toBeCloseTo((f.rolling(x, z + e)[0] - f.rolling(x, z - e)[0]) / (2 * e), 4);
    }
  });
});

describe('World Genome', () => {
  it('stays inside every gene range and is deterministic', () => {
    for (const seed of [1, 99, 424242]) {
      const g = baseGenome(seed, 'mirror');
      expect(baseGenome(seed, 'mirror')).toEqual(g);
      for (const k of GENE_KEYS) {
        expect(g[k]).toBeGreaterThanOrEqual(GENES[k].min);
        expect(g[k]).toBeLessThanOrEqual(GENES[k].max);
      }
    }
  });

  it('evolves from recorded choices only (a Storycard regenerates it)', () => {
    const run = { remembrances: ['embrace', 'embrace', 'purify'] as ('embrace' | 'purify')[], history: [], latent: [0.4, -0.2, 0.3, 0], cycle: 2, tiers: { root: 1, echo: 0, flow: 2 } };
    const a = regionGenome(7, 'canopy', run);
    const b = regionGenome(7, 'canopy', JSON.parse(JSON.stringify(run)));
    expect(a).toEqual(b);
    const fresh = regionGenome(7, 'canopy');
    expect(a.excite).toBeGreaterThan(fresh.excite); // embracing quickened the Null
    expect(a.warp).toBeGreaterThan(fresh.warp); // flow folded the land
    expect(lineageDrifts(run).length).toBeGreaterThanOrEqual(4);
    // extreme lineages still clamp
    const wild = mutate(fresh, { excite: 9, ridge: -9, juliaA: 1.37 });
    expect(wild.excite).toBe(GENES.excite.max);
    expect(wild.ridge).toBe(GENES.ridge.min);
    expect(wild.juliaA).toBeGreaterThanOrEqual(0);
    expect(wild.juliaA).toBeLessThan(1);
  });

  it('picks hyperbolic Julia constants (an attracting cycle, so the filled set has lakes)', () => {
    for (let i = 0; i < 40; i++) {
      const [cx, cy] = juliaConstant({ juliaA: i / 40 + 0.003, juliaB: (i * 7) % 10 / 10 });
      let x = 0, y = 0;
      for (let k = 0; k < 4000; k++) [x, y] = [x * x - y * y + cx, 2 * x * y + cy];
      expect(Math.hypot(x, y)).toBeLessThan(2);
      // the orbit has settled onto a cycle of period ≤ 5
      const pts: [number, number][] = [];
      for (let k = 0; k < 10; k++) {
        [x, y] = [x * x - y * y + cx, 2 * x * y + cy];
        pts.push([x, y]);
      }
      const period = [1, 2, 3, 4, 5].find((p) => Math.hypot(pts[p][0] - pts[0][0], pts[p][1] - pts[0][1]) < 1e-4);
      expect(period).toBeDefined();
    }
  });

  it('emits a GBNF grammar and clamps parsed proposals (P2 bridge)', () => {
    const g = genomeGrammar();
    expect(g).toContain('root ::=');
    for (const k of GENE_KEYS) expect(g).toContain(`\\"${k}\\"`);
    const m = parseMutation('{"excite": 0.5, "ridge": -0.1, "bogus": 3}');
    expect(m).toEqual({ excite: 0.2, ridge: -0.1 });
  });
});

describe('Orbit Isles', () => {
  it('bakes a signed distance that is negative inside the filled Julia set', () => {
    const sd = bakeJuliaSDF(-1, 0, 64); // basilica: the origin is interior, z = 1.7 is exterior
    expect(sd[32 * 64 + 32]).toBeLessThan(0);
    expect(sd[32 * 64 + 62]).toBeGreaterThan(0);
  });

  it('places isles deterministically and keeps the authored core clear', () => {
    const g = { ...neutralGenome(), isles: 0.95 };
    const a = new OrbitIsles(5, g);
    const b = new OrbitIsles(5, g);
    let n = 0;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      const p = a.isleAt(i, j);
      const q = b.isleAt(i, j);
      expect(!!p).toBe(!!q);
      if (p && q) {
        n++;
        expect(p.x).toBe(q.x);
        expect(Math.hypot(p.x, p.z) - p.R * 1.15).toBeGreaterThanOrEqual(320);
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it('rims the lake continuously (no steps anywhere along a transect)', () => {
    expect(isleProfile(-200, 14, 4)).toBeCloseTo(-4, 3);
    expect(isleProfile(6, 14, 4)).toBeCloseTo(14, 3);
    const s = new GroundShape(opts(31, FULL, { ...baseGenome(31, 'mirror'), isles: 0.95 }));
    const isle = findIsle(s.wild!);
    let prev = s.heightAt(isle.x - isle.R * 1.3, isle.z);
    let lake = 0;
    for (let x = isle.x - isle.R * 1.3; x < isle.x + isle.R * 1.3; x += 0.5) {
      const h = s.heightAt(x, isle.z);
      expect(Math.abs(h - prev)).toBeLessThan(1.2);
      prev = h;
      lake = Math.max(lake, s.riverAt(x, isle.z));
    }
    expect(lake).toBeGreaterThan(0.9);
  });

  it('turns lake currents along the shore', () => {
    const s = new GroundShape(opts(31, FULL, { ...baseGenome(31, 'mirror'), isles: 0.95 }));
    const isle = findIsle(s.wild!);
    const f = { x: 0, y: 0 };
    let found = false;
    for (let a = 0; a < 6.28 && !found; a += 0.05) {
      for (let r = isle.R; r > 0; r -= 4) { // outside in: the first lake point lies near the shore
        const x = isle.x + Math.cos(a) * r, z = isle.z + Math.sin(a) * r;
        if (s.riverAt(x, z) > 0.8) {
          s.flowAt(x, z, f);
          expect(Math.hypot(f.x, f.y)).toBeGreaterThan(3);
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe('terrain field v2', () => {
  it('is deterministic, and the legacy field is unchanged with every feature off', () => {
    const a = new GroundShape(opts(4242));
    const b = new GroundShape(opts(4242));
    for (const [x, z] of [[0, 0], [400, -300], [-5000, 7000], [12345, 678]]) expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
    // neutral genome + no features = the pre-P1 Wilds (warp 2.2, ridge 1.0)
    const legacy = new WildField(4242, 'seedbed', neutralGenome(), NO_FEATURES);
    const n = makeNoise2D(4242 ^ 0xb0b);
    const n1 = makeNoise2D(4242 ^ 0xa11ce);
    const fbm = (f: typeof n, x: number, z: number, oct: number, gain = 0.5) => {
      let s = 0, a = 0.5, q = 1;
      for (let i = 0; i < oct; i++) { s += f(x * q, z * q) * a; q *= 2.02; a *= gain; }
      return s;
    };
    const x = 3000, z = -1700, s = 0.0055;
    const qx = fbm(n1, x * s, z * s, 3), qz = fbm(n1, x * s + 5.2, z * s + 1.3, 3);
    const rolling = fbm(n, x * s + 2.2 * qx, z * s + 2.2 * qz, 4, 0.42) * 18;
    const b0 = legacy.biomeAt(x, z);
    if (b0.biome === 0) expect(legacy.height(x, z)).toBeCloseTo(rolling * (1 - 0.45 * b0.core), 9);
  });

  it('stays mostly walkable with every feature on', () => {
    for (const seed of [99, 7, 31337]) {
      const g = { ...baseGenome(seed, 'mirror'), erosion: 1, terrace: 1, ridge: 1.4, isles: 0.9 };
      const s = new GroundShape(opts(seed, FULL, g));
      const rng = new Rng(3);
      let steep = 0;
      const N = 3000;
      for (let i = 0; i < N; i++) {
        const a = rng.range(0, 6.28);
        const r = rng.range(150, 2500);
        if (Math.atan(s.slopeAt(Math.cos(a) * r, Math.sin(a) * r)) > Math.PI / 4) steep++;
      }
      expect(steep / N).toBeLessThan(0.05);
    }
  }, 60000);

  it('keeps heightAt within its main-thread budget', () => {
    const s = new GroundShape(opts(99));
    const rng = new Rng(1);
    for (let i = 0; i < 30000; i++) s.heightAt(rng.range(700, 1400), rng.range(800, 1300)); // warm caches and JIT
    const N = 60000;
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < N; i++) acc += s.heightAt(800 + (i % 300) * 1.7, 900 + Math.floor(i / 300) * 1.3);
    const us = ((performance.now() - t0) * 1000) / N;
    console.log(`heightAt ${us.toFixed(2)} µs (all features)`);
    expect(acc).not.toBeNaN();
    expect(us).toBeLessThan(8); // target ≤ 3 µs on a desktop core; loose bound for shared CI runners
  }, 30000);

  it('builds the same chunk arrays in any thread (pure function of the options)', () => {
    const a = buildChunkArrays(new GroundShape(opts(5)), 9, -4, 24);
    const b = buildChunkArrays(new GroundShape(JSON.parse(JSON.stringify(opts(5)))), 9, -4, 24);
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(Array.from(a.tint)).toEqual(Array.from(b.tint));
    // the chunk's own height grid is the surface
    const s = new GroundShape(opts(5));
    expect(a.heights[3 * 25 + 7]).toBeCloseTo(s.heightAt(9 * 48 + 7 * 2, -4 * 48 + 3 * 2), 4);
  });
});

describe('OKLab colour', () => {
  it('round-trips and blends without a lightness dip', () => {
    const c = hexLinear(0x33ccaa);
    const lab = linearToOklab(...c);
    const back = oklabToLinear(lab[0], lab[1], lab[2]);
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(c[i], 6);
    const cyan = oklch(0.75, 0.13, 190);
    const red = oklch(0.75, 0.13, 10);
    const mid = mixOklab(cyan, red, 0.5);
    expect(toOklch(...mid)[0]).toBeCloseTo(0.75, 2);
    for (const v of oklch(0.9, 0.4, 140)) expect(v).toBeLessThanOrEqual(1);
  });
});

describe('living field', () => {
  const mk = (support: (x: number, z: number) => number) => {
    const f = new LivingField({ size: 96, cell: 1.5, excite: 1, mercy: 1 }, support);
    f.follow(0, 0);
    return f;
  };
  const o = { c: 0, u: 0 };

  it('grows corruption on the Blight and lets it fade where nothing feeds it', () => {
    const f = mk((x) => (x < -30 ? 1 : 0));
    for (let i = 0; i < 4 * 30; i++) f.step();
    expect(f.at(-50, 0, o).c).toBeGreaterThan(0.8);
    expect(f.at(50, 0, o).c).toBeLessThan(0.05);
  });

  it('sends a purification ring outward that burns corruption as it passes', () => {
    const f = mk(() => 0.35);
    for (let i = 0; i < 4 * 20; i++) f.step();
    const before = f.at(20, 0, o).c;
    expect(before).toBeGreaterThan(0.3);
    f.pulse(0, 0, 3);
    let reached = false;
    for (let i = 0; i < 4 * 6; i++) {
      f.step();
      if (f.at(20, 0, o).u > 0.5) reached = true;
    }
    expect(reached).toBe(true);
    expect(f.at(20, 0, o).c).toBeLessThan(before * 0.8);
  });

  it('cannot push a ring through heavy corruption (rings break there)', () => {
    const f = mk((x) => (x > 12 ? 1 : 0));
    for (let i = 0; i < 4 * 30; i++) f.step();
    f.pulse(0, 0, 3);
    let deep = 0;
    for (let i = 0; i < 4 * 10; i++) {
      f.step();
      deep = Math.max(deep, f.at(40, 0, o).u);
    }
    expect(deep).toBeLessThan(0.5);
  });

  it('costs well under a millisecond per tick at 128²', () => {
    const f = new LivingField({ size: 128, cell: 1.5, excite: 1, mercy: 1 }, () => 0.3);
    f.follow(10, 10);
    f.pulse(10, 10, 5);
    for (let i = 0; i < 20; i++) f.step();
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) f.step();
    const ms = (performance.now() - t0) / 40;
    console.log(`living field tick ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThan(3);
  });
});

describe('genome colour, glyphs and narration', () => {
  it('biome tints are luminance-neutral and differ by biome; off is neutral', async () => {
    const { biomeStyle, nullColour } = await import('../src/world/biomeStyle');
    const g = baseGenome(31, 'river');
    const s = biomeStyle(g, true);
    expect(s.tints).toHaveLength(12);
    for (let b = 0; b < 4; b++) {
      const [r, gg, bb] = s.tints.slice(b * 3, b * 3 + 3);
      expect(0.2126 * r + 0.7152 * gg + 0.0722 * bb).toBeCloseTo(1, 3);
    }
    expect(s.tints.slice(0, 3)).not.toEqual(s.tints.slice(3, 6));
    expect(biomeStyle(g, false).tints.every((v) => v === 1)).toBe(true);
    const n = nullColour(g);
    expect(n[0]).toBeGreaterThan(n[1]); // the Null stays magenta-red
  });

  it('the region Julia glyph has a boundary line and an interior', async () => {
    const { juliaGlyph } = await import('../src/engine/proctexGen');
    const c = juliaConstant(baseGenome(5, 'seedbed'));
    const px = juliaGlyph(c[0], c[1], 64);
    let line = 0, inside = 0;
    for (let k = 0; k < 64 * 64; k++) {
      if (px[k * 4 + 1] > 0) inside++;
      else if (px[k * 4] > 128) line++;
    }
    expect(inside).toBeGreaterThan(50);
    expect(line).toBeGreaterThan(20);
  });

  it('narrates the strongest drift', async () => {
    const { strongestDrift } = await import('../src/world/genome');
    expect(strongestDrift([])).toBeNull();
    const ds = lineageDrifts({ remembrances: ['embrace', 'embrace', 'purify'], history: [], latent: [0, 0, 0, 0], cycle: 1, tiers: { root: 0, echo: 0, flow: 0 } } as never);
    expect(strongestDrift(ds)!.why).toMatch(/embraced/);
  });

  it('nearestBaked never bakes', () => {
    const f = new WildField(9, 'seedbed', baseGenome(9, 'seedbed'), FULL);
    const isle = findIsle(f);
    const fresh = new OrbitIsles(9 ^ 0x0b17, baseGenome(9, 'seedbed'));
    expect(fresh.nearestBaked(isle.x, isle.z)).toBeNull();
    expect(f.isles!.nearestBaked(isle.x, isle.z)).toBe(isle);
  });
});
