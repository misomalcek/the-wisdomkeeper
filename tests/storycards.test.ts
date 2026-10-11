import { describe, expect, it } from 'vitest';
import { emptyTiers } from '../src/story/story';
import type { LibraryEntry, RunState } from '../src/types';
import {
  DECK_KEY, MAX_CARD_BYTES, MAX_PUNCHES, StoryDeck, StorycardError, addPunch, buildStorycard, derivePunches, mergeLibrary, parseStorycard,
  runFromCard, storycardFilename, storycardToJSON, storycardToMarkdown, validateStorycard, type StorageLike,
} from '../src/systems/storycards';

const baseRun = (over: Partial<RunState> = {}): RunState => ({
  version: 2, cycle: 2, seed: 12345, stratumIndex: 1, tiers: { ...emptyTiers(), root: 1 },
  history: [{ stratum: 'seedbed', stratumName: 'The Seedbed', choice: { id: 'fusion', affinity: 'root', title: 'The Fusion of Roots and Silicon' }, kills: 14, echoes: 3, deaths: 1, time: 312.5, purified: 1, embraced: 0, mindNote: 'You fight close.' }],
  echoes: [{ x: 10.5, z: -4, affinity: 'root', stratum: 'seedbed', radius: 140 }],
  maxHp: 120, deaths: 1, kills: 14, elapsed: 330.25, difficulty: 1.1, latent: [0.1, -0.2, 0, 0.3], level: 7, xp: 40, skillPoints: 2,
  skills: { deep_root: 1 }, inventory: [{ id: 'iabc1', slot: 'helm', name: 'Spore Helm', rarity: 'rare', level: 5, stats: { life: 20, dr: 0.04 } }],
  equipped: { blade: { id: 'iabc0', slot: 'blade', name: 'Root-Blade Unit', rarity: 'common', level: 1, stats: { damage: 0.1 } } },
  skin: 'resonant', nullPoints: 0, purityPoints: 1, remembrances: ['purify'], fiber: 40, crystals: 9,
  telemetry: { embrace: 0, purify: 1, flightTime: 12, meleeKills: 8, resonanceSpent: 140 },
  missions: [{ id: 1, kind: 'hunt', title: 'Hunt `drones`', brief: 'Down three drones.', stratum: 1, x: 10, z: 20, need: 3, have: 1, reward: 6, target: 1, state: 'active' }],
  ...over,
});
const lib: LibraryEntry[] = [{ cycle: 1, title: 'The Rooted Keeper', ending: 'root', text: 'I was a seed.\n\nNow I am a forest.', date: '2026-10-01' }];
const NOW = new Date('2026-10-11T14:03:00Z');

describe('storycard punches', () => {
  it('punches beats onto the run, skips exact repeats and caps the log', () => {
    const run = baseRun({ punches: [] });
    addPunch(run, 'camp', 'Spore Hollow purged', NOW);
    addPunch(run, 'camp', 'Spore Hollow purged', NOW);
    expect(run.punches).toHaveLength(1);
    expect(run.punches![0]).toMatchObject({ kind: 'camp', stratum: 1, cycle: 2, level: 7, at: NOW.toISOString() });
    for (let i = 0; i < MAX_PUNCHES + 30; i++) addPunch(run, 'level', `Reached level ${i}`, NOW);
    expect(run.punches).toHaveLength(MAX_PUNCHES);
    expect(run.punches!.at(-1)!.text).toBe(`Reached level ${MAX_PUNCHES + 29}`);
  });
  it('reconstructs a log for an old save without punches', () => {
    const p = derivePunches(baseRun());
    expect(p[0].kind).toBe('cycle');
    expect(p.some((x) => x.kind === 'choice' && x.text.includes('Fusion of Roots'))).toBe(true);
    expect(p.some((x) => x.kind === 'remembrance')).toBe(true);
    expect(p.at(-1)!.text).toContain('River of Becoming');
  });
});

describe('storycard serialisation', () => {
  it('round-trips through JSON', () => {
    const run = baseRun({ punches: [] });
    addPunch(run, 'boss', 'The Null Warden falls', NOW);
    const card = buildStorycard(run, lib, NOW);
    expect(card.title).toBe('Cycle 2 · The River of Becoming · Lv 7');
    expect(card.run.punches).toBeUndefined();
    const back = parseStorycard(storycardToJSON(card));
    expect(back).toEqual(card);
    const restored = runFromCard(back);
    expect(restored.punches).toEqual(run.punches);
    expect({ ...restored, punches: undefined }).toEqual({ ...run, punches: undefined });
  });
  it('round-trips through Markdown via the fenced storycard block', () => {
    const run = baseRun();
    addPunch(run, 'note', 'A `tricky` line with | pipes and ``` fences', NOW);
    const card = buildStorycard(run, lib, NOW);
    const md = storycardToMarkdown(card);
    expect(md).toMatch(/^# Wisdomkeeper Storycard — Cycle 2/);
    expect(md).toContain('## Punches');
    expect(md).toContain('The Rooted Keeper');
    expect(md.trimEnd().endsWith('```')).toBe(true);
    expect(parseStorycard(md)).toEqual(card);
    // Windows line endings and a BOM survive too
    expect(parseStorycard('﻿' + md.replace(/\n/g, '\r\n'))).toEqual(card);
  });
  it('names downloads after the stratum and local time', () => {
    const card = buildStorycard(baseRun(), [], NOW);
    expect(storycardFilename(card, 'json', new Date(2026, 9, 11, 9, 5))).toBe('wisdomkeeper-river-20261011-0905.storycard.json');
    expect(storycardFilename(card, 'md')).toMatch(/^wisdomkeeper-river-\d{8}-\d{4}\.storycard\.md$/);
  });
});

describe('storycard validation', () => {
  const good = () => JSON.parse(storycardToJSON(buildStorycard(baseRun(), lib, NOW)));
  const rejects = (mut: (c: any) => void, msg?: RegExp) => {
    const c = good();
    mut(c);
    expect(() => validateStorycard(c)).toThrow(msg ?? StorycardError);
  };

  it('accepts a valid card', () => expect(() => validateStorycard(good())).not.toThrow());
  it('rejects wrong format and newer versions', () => {
    rejects((c) => (c.format = 'something.else'), /not a Wisdomkeeper storycard/);
    rejects((c) => (c.version = 99), /newer Wisdomkeeper/);
    rejects((c) => (c.run.version = 1), /run\.version/);
  });
  it('rejects bad types, ranges and bounds', () => {
    rejects((c) => (c.run.stratumIndex = 6), /run\.stratumIndex/);
    rejects((c) => (c.run.stratumIndex = -1));
    rejects((c) => (c.run.level = 1.5), /whole number/);
    rejects((c) => (c.run.kills = 'many'), /run\.kills/);
    rejects((c) => (c.run.tiers.root = 4), /run\.tiers\.root/);
    rejects((c) => (c.run.skin = 'gold'), /run\.skin/);
    rejects((c) => (c.run.echoes[0].x = null), /echoes\[0\]\.x/);
    rejects((c) => (c.run.history[0].stratum = 'moon'), /history\[0\]\.stratum/);
    rejects((c) => (c.run.inventory[0].stats.hax = 3), /stats key/);
    rejects((c) => (c.run.equipped.helm = c.run.equipped.blade), /equipped\.helm\.slot/);
    rejects((c) => (c.run.skills = JSON.parse('{"__proto__": 1}')), /identifier/);
    rejects((c) => (c.punches[0].kind = 'hack'), /punches\[0\]\.kind/);
    rejects((c) => (c.punches[0].text = 'x'.repeat(5000)), /punches\[0\]\.text/);
    rejects((c) => (c.run.history = Array.from({ length: 65 }, () => c.run.history[0])), /too many/);
    rejects((c) => (c.library[0].text = 7), /library\[0\]\.text/);
  });
  it('treats non-finite numbers in JSON as invalid', () => {
    const text = storycardToJSON(buildStorycard(baseRun(), [], NOW)).replace('"maxHp": 120', '"maxHp": 1e999');
    expect(() => parseStorycard(text)).toThrow(/run\.maxHp/);
  });
  it('rejects malformed, empty, oversized and fenceless input', () => {
    expect(() => parseStorycard('{ not json')).toThrow(/not valid JSON/);
    expect(() => parseStorycard('   ')).toThrow(/empty/);
    expect(() => parseStorycard('# Just some notes\n\nno data here')).toThrow(/No storycard data/);
    expect(() => parseStorycard('x'.repeat(MAX_CARD_BYTES + 1))).toThrow(/too large/);
    expect(() => parseStorycard('[1,2,3]')).toThrow(StorycardError);
    expect(() => parseStorycard('null')).toThrow(StorycardError);
  });
  it('strips unknown fields instead of carrying them along', () => {
    const c = good();
    c.run.evil = '<img src=x onerror=alert(1)>';
    c.extra = 1;
    const v = validateStorycard(c) as any;
    expect(v.run.evil).toBeUndefined();
    expect(v.extra).toBeUndefined();
  });
  it('loads an old save without punches, crystals, telemetry or missions', () => {
    const old = baseRun();
    delete old.punches;
    delete (old as Partial<RunState>).crystals;
    delete (old as Partial<RunState>).telemetry;
    delete (old as Partial<RunState>).missions;
    delete (old as Partial<RunState>).fiber;
    const card = validateStorycard({ format: 'wisdomkeeper.storycard', version: 1, run: old });
    expect(card.punches.length).toBeGreaterThan(0);
    expect(card.run.crystals).toBe(0);
    expect(card.run.telemetry).toEqual({ embrace: 0, purify: 0, flightTime: 0, meleeKills: 0, resonanceSpent: 0 });
    expect(card.run.missions).toEqual([]);
    expect(card.library).toEqual([]);
    expect(card.title).toContain('Cycle 2');
  });
});

describe('library merge & autosave deck', () => {
  it('merges libraries without duplicates', () => {
    const extra: LibraryEntry = { ...lib[0], cycle: 2, title: 'The Echoing Keeper' };
    expect(mergeLibrary(lib, [lib[0], extra])).toEqual([lib[0], extra]);
    expect(mergeLibrary([], Array.from({ length: 40 }, (_, i) => ({ ...lib[0], cycle: i + 1 })))).toHaveLength(30);
  });

  const memStore = (quota = Infinity) => {
    const m = new Map<string, string>();
    const s: StorageLike & { m: Map<string, string> } = {
      m,
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => {
        if (v.length > quota) throw new DOMException('full', 'QuotaExceededError');
        m.set(k, v);
      },
    };
    return s;
  };

  it('keeps the last five distinct cards, newest first, and persists them', () => {
    const s = memStore();
    const deck = new StoryDeck(() => s);
    const run = baseRun();
    for (let i = 0; i < 7; i++) {
      run.kills = 100 + i;
      expect(deck.push(buildStorycard(run, lib, NOW))).toBe(true);
    }
    expect(deck.push(buildStorycard(run, lib, new Date()))).toBe(false); // same content, later time
    expect(deck.list().map((e) => e.card.run.kills)).toEqual([106, 105, 104, 103, 102]);
    expect(deck.list()[0].card.library).toEqual([]);
    const reread = new StoryDeck(() => s);
    expect(reread.list().map((e) => e.card.run.kills)).toEqual([106, 105, 104, 103, 102]);
    expect(s.m.has(DECK_KEY)).toBe(true);
  });
  it('shrinks to fit the storage quota and survives corrupt or missing storage', () => {
    const one = JSON.stringify([{ card: { ...buildStorycard(baseRun(), [], NOW), library: [] } }]).length;
    const s = memStore(one * 2.5);
    const deck = new StoryDeck(() => s);
    const run = baseRun();
    for (let i = 0; i < 5; i++) {
      run.kills = i;
      deck.push(buildStorycard(run, [], NOW));
    }
    expect(deck.list().length).toBe(2);
    s.m.set(DECK_KEY, '[{"card": {"format": "nope"}}, "junk"]');
    expect(new StoryDeck(() => s).list()).toEqual([]);
    s.m.set(DECK_KEY, '{{{');
    expect(new StoryDeck(() => s).list()).toEqual([]);
    const none = new StoryDeck(() => {
      throw new Error('SecurityError');
    });
    expect(none.list()).toEqual([]);
    expect(none.push(buildStorycard(baseRun(), [], NOW))).toBe(false);
    expect(none.list()).toHaveLength(1);
  });
});
