import { describe, expect, it } from 'vitest';
import { MyceliumReservoir } from '../src/bio/reservoir';
import { FungalMemristor, SeedPool } from '../src/bio/entropy';
import { MycelialMindState, freshTelemetry } from '../src/bio/mindState';
import { NeuralDirector } from '../src/bio/director';

describe('biocomputing', () => {
  it('FHN reservoir propagates a stimulus as a travelling wave and repolarises', () => {
    const r = new MyceliumReservoir(32, 3, 0);
    r.stimulate(0.5, 0.5, 1.5, 1);
    let peak = 0;
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const s = r.step();
      peak = Math.max(peak, s);
      total += s;
    }
    expect(peak).toBeGreaterThan(4);
    expect(total).toBeGreaterThan(60);
    for (let i = 0; i < 600; i++) r.step();
    expect(r.meanPotential()).toBeLessThan(0.3);
  });

  it('small-world shortcuts shorten paths while keeping clustering', () => {
    const lattice = new MyceliumReservoir(24, 5, 0).topology(12);
    const sw = new MyceliumReservoir(24, 5, 0.08).topology(12);
    expect(sw.apl).toBeLessThan(lattice.apl * 0.6);
    expect(sw.clustering).toBeGreaterThan(0.12);
  });

  it('memristor shows a pinched hysteresis loop: zero current at zero voltage, state depends on history', () => {
    const m = new FungalMemristor();
    const up: number[] = [];
    const down: number[] = [];
    for (let k = 0; k < 400; k++) {
      const v = Math.sin((k / 400) * Math.PI * 2);
      const i = m.drive(v, 50, 0.01);
      if (k === 50) up.push(i / v);
      if (k === 150) down.push(i / v);
    }
    expect(m.drive(0, 50, 0.01)).toBe(0);
    expect(up[0]).not.toBeCloseTo(down[0], 5);
  });

  it('whitening removes bias and the pool reseeds through SHA-256', async () => {
    const m = new FungalMemristor();
    for (let k = 0; k < 4000; k++) m.drive(Math.sin(k * 0.37) * 0.9 + Math.sin(k * 1.31) * 0.4, 900, 0.003);
    const bytes = m.whiten(64);
    expect(bytes.length).toBeGreaterThan(8);
    const pool = new SeedPool();
    const before = pool.u32();
    await pool.absorb(bytes, 0.123);
    expect(pool.extractions).toBe(1);
    expect(pool.digest).toMatch(/^[0-9a-f]{16}$/);
    let ones = 0;
    for (let k = 0; k < 2000; k++) ones += pool.u32() & 1;
    expect(ones).toBeGreaterThan(900);
    expect(ones).toBeLessThan(1100);
    expect(pool.u32()).not.toBe(before);
  });

  it('mind reads outputs 0–3 and the Hollow Crown locks in at four embraces', () => {
    const m = new MycelialMindState();
    const d = m.evaluate(freshTelemetry());
    for (const v of Object.values(d)) expect(Number.isFinite(v)).toBe(true);
    expect(d.pylonPurgeDifficulty).toBeGreaterThanOrEqual(0.5);
    expect(d.floraGlowIntensity).toBeLessThanOrEqual(3);
    expect(m.evaluate({ ...freshTelemetry(), embrace: 4 }).hollowCrownProbability).toBe(1);
    const a = m.evaluate({ ...freshTelemetry(), meleeKills: 90, flightTime: 10 });
    const b = m.evaluate({ ...freshTelemetry(), meleeKills: 0, flightTime: 280 });
    expect(a.nullCorruptionAggression).not.toBeCloseTo(b.nullCorruptionAggression, 4);
  });

  it('director paces calm → stirring → surge → respite and never surges a hurt hero', () => {
    const d = new NeuralDirector(9);
    const seen = new Set<string>();
    for (let t = 0; t < 400; t += 0.1) {
      if (Math.floor(t * 10) % 37 === 0) d.stimulate(Math.sin(t) * 30, Math.cos(t) * 30, 60, 1.6);
      seen.add(d.update(0.1, { hp: 1, engaged: 0, sinceHurt: 30, difficulty: 1 }, freshTelemetry()).phase);
    }
    expect([...seen]).toEqual(expect.arrayContaining(['calm', 'stirring', 'surge', 'respite']));
    const h = new NeuralDirector(9);
    for (let t = 0; t < 300; t += 0.1) {
      h.stimulate(0, 0, 60, 1.6);
      expect(h.update(0.1, { hp: 0.2, engaged: 3, sinceHurt: 0.5, difficulty: 1 }, freshTelemetry()).phase).not.toBe('surge');
    }
  });
});
