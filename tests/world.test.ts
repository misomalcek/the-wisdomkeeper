import { describe, expect, it } from 'vitest';
import { STRATA } from '../src/story/strata';
import { World } from '../src/world/world';
import { emptyTiers } from '../src/story/story';
import type { RunState } from '../src/types';
import { Rng } from '../src/util/rng';

const mkRun = (seed: number, latent: number[]): RunState => ({
  version: 2, cycle: 1, seed, stratumIndex: 0, tiers: emptyTiers(), history: [], echoes: [],
  maxHp: 100, deaths: 0, kills: 0, elapsed: 0, difficulty: 1, latent,
  level: 1, xp: 0, skillPoints: 0, skills: {}, inventory: [], equipped: {}, skin: 'resonant', nullPoints: 0, purityPoints: 0, remembrances: [],
});

describe('world generation invariants', () => {
  const rng = new Rng(2024);
  const seeds = Array.from({ length: 14 }, () => Math.floor(rng.next() * 1e9));
  for (const def of STRATA) {
    it(`${def.id}: valid layout across ${seeds.length} seeds`, () => {
      for (const seed of seeds) {
        const latent = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
        const w = new World(def, mkRun(seed, latent));
        const R = w.radius;
        expect(R).toBeGreaterThan(def.radius * 0.85);
        expect(R).toBeLessThan(def.radius * 1.15);
        expect(w.nodes).toHaveLength(def.nodes);
        // start + gate stand on dry land and well apart
        expect(w.terrain.riverAt(w.startPos.x, w.startPos.z)).toBeLessThan(0.05);
        if (w.gate && !def.boss) {
          expect(w.terrain.riverAt(w.gate.pos.x, w.gate.pos.z)).toBeLessThan(0.05);
          expect(Math.hypot(w.gate.pos.x - w.startPos.x, w.gate.pos.z - w.startPos.z)).toBeGreaterThan(R);
        }
        w.nodes.forEach((n, i) => {
          expect(Math.hypot(n.pos.x, n.pos.z)).toBeLessThanOrEqual(R * 0.86);
          expect(w.terrain.riverAt(n.pos.x, n.pos.z)).toBeLessThan(0.05);
          for (let j = 0; j < i; j++) expect(Math.hypot(n.pos.x - w.nodes[j].pos.x, n.pos.z - w.nodes[j].pos.z)).toBeGreaterThan(14);
        });
        // heights are finite everywhere we might stand
        for (let k = 0; k < 20; k++) expect(Number.isFinite(w.terrain.heightAt(rng.range(-R, R), rng.range(-R, R)))).toBe(true);
        w.dispose();
      }
    });
  }

  it('the Return regrows every echo from the run history', () => {
    const run = mkRun(5, [0, 0, 0, 0]);
    run.stratumIndex = 4;
    run.echoes = Array.from({ length: 40 }, (_, i) => ({ x: Math.cos(i) * 20, z: Math.sin(i) * 20, affinity: (['root', 'echo', 'flow'] as const)[i % 3], stratum: 'river' as const, radius: 54 }));
    const w = new World(STRATA[4], run);
    expect(w.grove.echoes.length).toBeGreaterThanOrEqual(36);
    expect(w.grove.echoes.every((e) => e.grown)).toBe(true);
    w.dispose();
  });

  it('is deterministic for the same seed', () => {
    const a = new World(STRATA[1], mkRun(77, [0.2, -0.4, 0.1, 0.3]));
    const b = new World(STRATA[1], mkRun(77, [0.2, -0.4, 0.1, 0.3]));
    expect(a.startPos.toArray()).toEqual(b.startPos.toArray());
    expect(a.nodes.map((n) => n.pos.toArray())).toEqual(b.nodes.map((n) => n.pos.toArray()));
  });
});
