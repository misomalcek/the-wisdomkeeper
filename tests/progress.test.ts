import { describe, expect, it } from 'vitest';
import { Rng } from '../src/util/rng';
import {
  MAX_LEVEL, RARITY, SKILLS, addXp, canRank, derive, generateItem, itemScore, rankUp, rollRarity, skinUnlocked, xpToNext,
} from '../src/systems/progress';
import { NULL_ENDING_THRESHOLD, endingFor } from '../src/story/story';
import { emptyTiers } from '../src/story/story';
import type { RunState } from '../src/types';

const run = (over: Partial<RunState> = {}): RunState => ({
  version: 2, cycle: 1, seed: 1, stratumIndex: 0, tiers: emptyTiers(), history: [], echoes: [], maxHp: 100, deaths: 0, kills: 0,
  elapsed: 0, difficulty: 1, latent: [0, 0, 0, 0], level: 1, xp: 0, skillPoints: 0, skills: {}, inventory: [], equipped: {},
  skin: 'resonant', nullPoints: 0, purityPoints: 0, remembrances: [], ...over,
});

describe('items', () => {
  it('rarer items roll more stats and stronger values', () => {
    const r = new Rng(3);
    const rand = () => r.next();
    const common = generateItem(rand, 5, 'common', 'blade');
    const legendary = generateItem(rand, 5, 'legendary', 'modulator');
    expect(Object.keys(common.stats)).toHaveLength(1);
    expect(Object.keys(legendary.stats).length).toBeGreaterThan(Object.keys(common.stats).length);
    // averaged over many rolls, rarity multiplies power
    let cs = 0;
    let ls = 0;
    for (let i = 0; i < 200; i++) {
      cs += itemScore(generateItem(rand, 5, 'common'));
      ls += itemScore(generateItem(rand, 5, 'legendary'));
    }
    expect(ls).toBeGreaterThan(cs * 2.5);
  });
  it('slot stat pools make sense (blades hit hard, boots are fast)', () => {
    const r = new Rng(9);
    for (let i = 0; i < 50; i++) {
      const b = generateItem(() => r.next(), 3, 'epic', 'blade');
      expect(Object.keys(b.stats).every((k) => ['damage', 'voidDmg', 'power'].includes(k))).toBe(true);
      const boots = generateItem(() => r.next(), 3, 'epic', 'boots');
      expect(Object.keys(boots.stats).every((k) => ['speed', 'dashCd', 'life'].includes(k))).toBe(true);
    }
  });
  it('rollRarity honours weights', () => {
    const r = new Rng(4);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const x = rollRarity(() => r.next(), { rare: 1, legendary: 3 });
      counts[x] = (counts[x] ?? 0) + 1;
    }
    expect(counts.common).toBeUndefined();
    expect(counts.legendary).toBeGreaterThan(counts.rare * 2);
  });
  it('has a colour for every rarity', () => {
    for (const k of Object.keys(RARITY)) expect(RARITY[k as keyof typeof RARITY].color).toMatch(/^#/);
  });
});

describe('xp and levels', () => {
  it('levels up, grants skill points, carries remainder, and caps', () => {
    const r = run();
    const gained = addXp(r, xpToNext(1) + 10);
    expect(gained).toBe(1);
    expect(r.level).toBe(2);
    expect(r.skillPoints).toBe(1);
    expect(r.xp).toBe(10);
    addXp(r, 1e9);
    expect(r.level).toBe(MAX_LEVEL);
    expect(addXp(r, 1000)).toBe(0);
  });
});

describe('skill tree', () => {
  it('enforces points and prerequisites', () => {
    const r = run({ skillPoints: 1 });
    expect(canRank(r, 'spore_mastery')).toBe(false); // locked behind deep_root
    expect(rankUp(r, 'deep_root')).toBe(true);
    expect(r.skillPoints).toBe(0);
    expect(rankUp(r, 'spore_mastery')).toBe(false); // no points left
    r.skillPoints = 5;
    expect(canRank(r, 'spore_mastery')).toBe(true);
    expect(rankUp(r, 'deep_root')).toBe(false); // already maxed
  });
  it('every skill requires a real skill in its own branch', () => {
    for (const s of SKILLS) {
      if (!s.requires) continue;
      const req = SKILLS.find((x) => x.id === s.requires);
      expect(req?.branch).toBe(s.branch);
    }
  });
});

describe('derived stats', () => {
  it('starts at baseline and responds to gear, skills, level and the Null', () => {
    const base = derive(run());
    expect(base.maxHp).toBe(100);
    expect(base.dmgMul).toBe(1);
    const r = run({
      level: 5, nullPoints: 2, skills: { deep_root: 1, thorn_bark: 2, spiral_tempo: 1 },
      equipped: { blade: { id: 'x', slot: 'blade', name: 'b', rarity: 'rare', level: 1, stats: { damage: 0.2 } } },
    });
    const d = derive(r);
    expect(d.maxHp).toBe(100 + 24 - 12);
    expect(d.dmgMul).toBeCloseTo(1 + 0.2 + 0.2);
    expect(d.voidMul).toBeCloseTo(1.15);
    expect(d.dr).toBeCloseTo(0.08);
    expect(d.attackSpeed).toBeCloseTo(1.08);
  });
  it('caps damage reduction and floors dash cooldown', () => {
    const d = derive(run({ skills: { thorn_bark: 3 }, equipped: { armor: { id: 'a', slot: 'armor', name: 'a', rarity: 'legendary', level: 1, stats: { dr: 0.9, dashCd: 0.9 } } } }));
    expect(d.dr).toBeLessThanOrEqual(0.6);
    expect(d.dashCdMul).toBeGreaterThanOrEqual(0.35);
  });
});

describe('armor variants and the Null ending', () => {
  it('unlocks skins from choices', () => {
    expect(skinUnlocked(run(), 'resonant')).toBe(true);
    expect(skinUnlocked(run(), 'verdant')).toBe(false);
    expect(skinUnlocked(run({ purityPoints: 3 }), 'verdant')).toBe(true);
    expect(skinUnlocked(run({ nullPoints: 3 }), 'void')).toBe(true);
  });
  it('embracing the Null enough overrides the affinity ending', () => {
    const tiers = { root: 3, echo: 0, flow: 0 };
    expect(endingFor({ tiers, nullPoints: NULL_ENDING_THRESHOLD - 1 }).id).toBe('root');
    expect(endingFor({ tiers, nullPoints: NULL_ENDING_THRESHOLD }).id).toBe('null');
    expect(endingFor({ tiers, nullPoints: NULL_ENDING_THRESHOLD }).title).toBe('The Hollow Crown');
  });
});
