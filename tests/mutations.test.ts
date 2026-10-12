import { describe, expect, it } from 'vitest';
import { emptyTiers } from '../src/story/story';
import type { RunState } from '../src/types';
import { GENES, MAX_MUTATIONS, clampMutation, lineageDrifts, recordMutation, regionGenome, type LineageRun } from '../src/world/genome';
import { StorycardError, buildStorycard, parseStorycard, runFromCard, storycardToJSON } from '../src/systems/storycards';

const lineage = (over: Partial<LineageRun> = {}): LineageRun => ({ remembrances: [], history: [], latent: [0, 0, 0, 0], cycle: 1, tiers: emptyTiers(), ...over });
const run = (over: Partial<RunState> = {}): RunState => ({
  version: 2, cycle: 1, seed: 777, stratumIndex: 1, tiers: emptyTiers(), history: [], echoes: [], maxHp: 100, deaths: 0, kills: 0, elapsed: 0,
  difficulty: 1, latent: [0, 0, 0, 0], level: 1, xp: 0, skillPoints: 0, skills: {}, inventory: [], equipped: {}, skin: 'resonant',
  nullPoints: 0, purityPoints: 0, remembrances: [], ...over,
});
const norm = (k: keyof typeof GENES, v: number) => (v - GENES[k].min) / (GENES[k].max - GENES[k].min);

describe('recorded genome mutations (P2: the mind reshapes a region)', () => {
  it('clamps a proposal to three known genes of at most ±0.2', () => {
    const m = clampMutation({ excite: 0.9, nullHue: -0.15, erosion: 0.05, warp: 0.01, bogus: 0.2, isles: Number.NaN, ridge: 0 });
    expect(m).toEqual({ excite: 0.2, nullHue: -0.15, erosion: 0.05 });
  });

  it('reshapes only the region it was recorded for, by exactly its steps', () => {
    const r = lineage();
    recordMutation(r, { stratum: 'river', cycle: 1, m: { excite: 0.2, erosion: -0.1 }, by: 'warden', why: 'the Warden quickened the Null' });
    const before = regionGenome(5, 'river', lineage());
    const after = regionGenome(5, 'river', r);
    expect(norm('excite', after.excite) - norm('excite', before.excite)).toBeCloseTo(Math.min(0.2, 1 - norm('excite', before.excite)), 9);
    expect(norm('erosion', after.erosion) - norm('erosion', before.erosion)).toBeCloseTo(-Math.min(0.1, norm('erosion', before.erosion)), 9);
    expect(after.warp).toBe(before.warp);
    expect(regionGenome(5, 'canopy', r)).toEqual(regionGenome(5, 'canopy', lineage()));
    expect(lineageDrifts(r, 'river').at(-1)?.why).toBe('the Warden quickened the Null');
    expect(lineageDrifts(r, 'canopy')).toEqual([]);
  });

  it('keeps one decision per region and cycle, the later replacing the earlier, and a bounded list', () => {
    const r = lineage();
    recordMutation(r, { stratum: 'river', cycle: 1, m: { excite: 0.2 }, by: 'warden', why: 'a' });
    recordMutation(r, { stratum: 'river', cycle: 1, m: { mercy: 0.2 }, by: 'symbiote', why: 'b' });
    recordMutation(r, { stratum: 'river', cycle: 2, m: { mercy: 0.1 }, by: 'rule', why: 'c' });
    expect(r.mutations?.map((x) => x.why)).toEqual(['b', 'c']);
    for (let i = 0; i < MAX_MUTATIONS + 10; i++) recordMutation(r, { stratum: 'veil', cycle: i + 1, m: { isles: 0.1 }, by: 'rule', why: `${i}` });
    expect(r.mutations?.length).toBe(MAX_MUTATIONS);
  });

  it('survives a storycard round trip, so both editions grow the same land', () => {
    const a = run();
    recordMutation(a, { stratum: 'canopy', cycle: 1, m: { growth: 0.2, ridge: -0.1 }, by: 'symbiote', why: 'the forest asked for more green' });
    const b = runFromCard(parseStorycard(storycardToJSON(buildStorycard(a))));
    expect(b.mutations).toEqual(a.mutations);
    expect(regionGenome(b.seed, 'canopy', b)).toEqual(regionGenome(a.seed, 'canopy', a));
  });

  it('rejects a card whose mutation names an unknown gene, and clamps oversized steps', () => {
    const card = JSON.parse(storycardToJSON(buildStorycard(run())));
    card.run.mutations = [{ stratum: 'river', cycle: 1, m: { flight: 0.1 }, by: 'warden', why: 'x' }];
    expect(() => parseStorycard(JSON.stringify(card))).toThrow(StorycardError);
    card.run.mutations = [{ stratum: 'river', cycle: 1, m: { excite: 0.9, mercy: -0.5 }, by: 'warden', why: 'x' }];
    expect(runFromCard(parseStorycard(JSON.stringify(card))).mutations?.[0].m).toEqual({ excite: 0.2, mercy: -0.2 });
  });
});
