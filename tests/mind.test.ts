import { describe, expect, it } from 'vitest';
import { MycelialMind, adaptDifficulty, describeStyle, digest, freshStats, latentToParams } from '../src/systems/mind';

describe('MycelialMind', () => {
  const f = { aggression: 0.7, accuracy: 0.5, vulnerability: 0.3, roaming: 0.4, evasion: 0.2 };
  it('is deterministic per seed and bounded in [-1,1]', () => {
    const a = new MycelialMind(42).latent(f);
    const b = new MycelialMind(42).latent(f);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
    a.forEach((v) => expect(Math.abs(v)).toBeLessThanOrEqual(1));
  });
  it('different seeds give different worlds for the same player', () => {
    expect(new MycelialMind(1).latent(f)).not.toEqual(new MycelialMind(2).latent(f));
  });
  it('maps a neutral latent to unit parameters', () => {
    expect(latentToParams([0, 0, 0, 0])).toEqual({ ruggedness: 1, floraDensity: 1, hueShift: 0, arenaScale: 1 });
  });
  it('keeps latent params within sane ranges', () => {
    for (const v of [-1, 1]) {
      const p = latentToParams([v, v, v, v]);
      expect(p.arenaScale).toBeGreaterThan(0.85);
      expect(p.arenaScale).toBeLessThan(1.15);
      expect(Math.abs(p.hueShift)).toBeLessThanOrEqual(0.08);
    }
  });
});

describe('director', () => {
  it('digests stats into normalised features', () => {
    const s = freshStats();
    Object.assign(s, { shots: 120, hits: 60, damageTaken: 50, distance: 600, time: 60, dashes: 6 });
    const d = digest(s, 100);
    for (const v of Object.values(d)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(d.accuracy).toBeCloseTo(0.5);
  });
  it('eases off when the player is struggling and pushes when cruising', () => {
    const hurt = { aggression: 0.5, accuracy: 0.3, vulnerability: 0.9, roaming: 0.5, evasion: 0.5 };
    const easy = { aggression: 0.5, accuracy: 0.5, vulnerability: 0.05, roaming: 0.5, evasion: 0.5 };
    expect(adaptDifficulty(1.2, hurt)).toBeLessThan(1.2);
    expect(adaptDifficulty(1.2, easy)).toBeGreaterThan(1.2);
    let d = 1;
    for (let i = 0; i < 40; i++) d = adaptDifficulty(d, easy);
    expect(d).toBeLessThanOrEqual(1.9);
  });
  it('narrates what it noticed', () => {
    const note = describeStyle({ aggression: 0.9, accuracy: 0.8, vulnerability: 0.7, roaming: 0.8, evasion: 0.1 }, [0, 0, 0.3, 0]);
    expect(note.length).toBeGreaterThan(10);
  });
});
