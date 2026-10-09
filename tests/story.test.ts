import { describe, expect, it } from 'vitest';
import { STRATA } from '../src/story/strata';
import { PERKS, composeStory, dominantEnding, emptyTiers } from '../src/story/story';
import type { RunState } from '../src/types';

const baseRun = (over: Partial<RunState> = {}): RunState => ({
  version: 2, cycle: 1, seed: 1, stratumIndex: 4, tiers: emptyTiers(), history: [], echoes: [],
  maxHp: 100, deaths: 0, kills: 12, elapsed: 600, difficulty: 1, latent: [0, 0, 0, 0], level: 1, xp: 0, skillPoints: 0, skills: {}, inventory: [], equipped: {}, skin: 'resonant', nullPoints: 0, purityPoints: 0, remembrances: [], ...over,
});

describe('story data', () => {
  it('has five strata in order, with a choice on each of the first three', () => {
    expect(STRATA.map((s) => s.id)).toEqual(['seedbed', 'river', 'canopy', 'mirror', 'return']);
    STRATA.forEach((s, i) => expect(s.index).toBe(i));
    expect(STRATA.slice(0, 3).every((s) => s.choice?.choices.length === 3)).toBe(true);
  });
  it('offers each affinity exactly once per choice set', () => {
    for (const s of STRATA.slice(0, 3)) {
      expect(s.choice!.choices.map((c) => c.affinity).sort()).toEqual(['echo', 'flow', 'root']);
    }
  });
  it('defines three perk tiers per affinity', () => {
    for (const a of ['root', 'echo', 'flow'] as const) expect(PERKS[a]).toHaveLength(3);
  });
  it('has unique choice ids', () => {
    const ids = STRATA.flatMap((s) => s.choice?.choices.map((c) => c.id) ?? []);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('endings', () => {
  it('picks a dominant affinity or the balanced ending', () => {
    expect(dominantEnding({ root: 2, echo: 1, flow: 0 })).toBe('root');
    expect(dominantEnding({ root: 0, echo: 3, flow: 0 })).toBe('echo');
    expect(dominantEnding({ root: 0, echo: 0, flow: 2 })).toBe('flow');
    expect(dominantEnding({ root: 1, echo: 1, flow: 1 })).toBe('balanced');
    expect(dominantEnding({ root: 2, echo: 2, flow: 0 })).toBe('balanced');
  });
  it('composes a story that echoes the opening and quotes each choice', () => {
    const choices = STRATA.slice(0, 3).map((s) => s.choice!.choices[0]);
    const run = baseRun({
      tiers: { root: 1, echo: 0, flow: 2 },
      history: choices.map((c, i) => ({
        stratum: STRATA[i].id, stratumName: STRATA[i].name, kills: 1, echoes: 1, deaths: 0, time: 10,
        choice: { id: c.id, affinity: c.affinity, title: c.title },
      })),
    });
    const story = composeStory(run);
    expect(story.endingId).toBe('flow');
    expect(story.paragraphs[0]).toMatch(/seed in the soil of code/);
    for (const c of choices) expect(story.paragraphs).toContain(c.epilogue);
    expect(story.stats).toMatch(/purified 12/);
  });
  it('acknowledges later cycles and deaths', () => {
    const s = composeStory(baseRun({ cycle: 3, deaths: 5 }));
    expect(s.paragraphs.join(' ')).toMatch(/cycle 3/);
    expect(s.paragraphs.join(' ')).toMatch(/5 times/);
  });
});
