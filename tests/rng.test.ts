import { describe, expect, it } from 'vitest';
import { Rng, fbm, hashString, makeNoise2D } from '../src/util/rng';

describe('Rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 50; i++) expect(a.next()).toBe(b.next());
  });
  it('differs across seeds and stays in [0,1)', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
    const r = new Rng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('int() is inclusive and bounded', () => {
    const r = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });
  it('hashString is stable', () => {
    expect(hashString('seedbed')).toBe(hashString('seedbed'));
    expect(hashString('seedbed')).not.toBe(hashString('river'));
  });
});

describe('noise', () => {
  it('is deterministic and roughly bounded', () => {
    const n1 = makeNoise2D(5);
    const n2 = makeNoise2D(5);
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37;
      const y = i * 0.11;
      expect(n1(x, y)).toBe(n2(x, y));
      expect(Math.abs(fbm(n1, x, y))).toBeLessThanOrEqual(1.5);
    }
  });
});
