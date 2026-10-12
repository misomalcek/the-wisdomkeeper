import { describe, expect, it } from 'vitest';
import { clampStrain, MAX_THREAT, STRAIN_LIMITS } from '../src/entities/strain';

describe('strains', () => {
  it('an empty strain is the plain kind', () => {
    expect(clampStrain({})).toEqual({ size: 1, vigor: 1, haste: 1, hue: 0 });
  });

  it('every trait stays in its range, and junk is neutral', () => {
    const c = clampStrain({ size: 9, vigor: -3, haste: Number.NaN, hue: 2 });
    expect(c.size).toBe(STRAIN_LIMITS.size[1]);
    expect(c.vigor).toBe(STRAIN_LIMITS.vigor[0]);
    expect(c.haste).toBe(1);
    expect(c.hue).toBe(STRAIN_LIMITS.hue[1]);
    expect(clampStrain({ size: 'big' as unknown as number }).size).toBe(1);
  });

  it('a strain is tougher or faster, not both at the top', () => {
    const c = clampStrain({ vigor: 1.5, haste: 1.25 });
    expect(c.haste).toBe(1.25);
    expect(c.vigor * c.haste).toBeCloseTo(MAX_THREAT, 6);
    expect(clampStrain({ vigor: 1.4, haste: 1 }).vigor).toBe(1.4);
  });
});
