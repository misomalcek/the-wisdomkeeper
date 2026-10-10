import { describe, expect, it } from 'vitest';
import { STRATA } from '../src/story/strata';
import { infuse, infuseCost, offerMissions } from '../src/systems/missions';
import { Rng } from '../src/util/rng';
import type { Item } from '../src/types';

describe('Director side missions and Void Crystal infusion', () => {
  const camps = [
    { id: 0, x: 10, z: 10, r: 15, kind: 'node' as const, nodeIndex: 0, name: 'Grove' },
    { id: 1, x: -40, z: 30, r: 13, kind: 'roam' as const, nodeIndex: null, name: 'Null Nest' },
  ];
  it('offers up to three distinct missions per region, none in boss arenas', () => {
    const rng = new Rng(9);
    for (const def of STRATA) {
      const got = offerMissions(def, camps, () => rng.next(), 1, () => ({ x: 50, z: 50 }));
      if (def.boss || def.ambient <= 0) expect(got).toHaveLength(0);
      else {
        expect(got.length).toBeGreaterThan(0);
        expect(got.length).toBeLessThanOrEqual(3);
        expect(new Set(got.map((m) => m.kind)).size).toBe(got.length);
        for (const m of got) {
          expect(m.reward).toBeGreaterThan(0);
          if (m.kind === 'pool') expect(m.target).toBe(1);
        }
      }
    }
  });
  it('infusing raises level, every stat and the next cost', () => {
    const it0: Item = { id: 'a', slot: 'helm', name: 'Helm', rarity: 'rare', level: 3, stats: { life: 20, dr: 0.05 } };
    const c0 = infuseCost(it0);
    infuse(it0);
    expect(it0.level).toBe(4);
    expect(it0.stats.life).toBeCloseTo(22.4);
    expect(it0.stats.dr).toBeCloseTo(0.056);
    expect(infuseCost(it0)).toBeGreaterThan(c0);
  });
});
