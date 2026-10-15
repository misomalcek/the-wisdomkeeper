/**
 * Writes a few later-region storycards into storycards/.
 * Run: npx vite-node scripts/sample-storycards.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { emptyTiers } from '../src/story/story';
import { buildStorycard, parseStorycard, storycardToJSON, storycardToMarkdown } from '../src/systems/storycards';
import type { RunState } from '../src/types';

const NOW = new Date('2026-10-15T18:00:00Z');

const run = (over: Partial<RunState>): RunState => ({
  version: 2,
  cycle: 1,
  seed: 48291,
  stratumIndex: 1,
  tiers: { ...emptyTiers(), root: 1 },
  history: [],
  echoes: [{ x: 12, z: -6, affinity: 'root', stratum: 'seedbed', radius: 140 }],
  maxHp: 130,
  deaths: 1,
  kills: 18,
  elapsed: 640,
  difficulty: 1,
  latent: [0.2, 0, 0, 0.1],
  level: 6,
  xp: 20,
  skillPoints: 1,
  skills: { deep_root: 1 },
  inventory: [],
  equipped: { blade: { id: 'blade1', slot: 'blade', name: 'Root-Blade Unit', rarity: 'common', level: 1, stats: { damage: 0.12 } } },
  skin: 'resonant',
  nullPoints: 0,
  purityPoints: 1,
  remembrances: ['purify'],
  fiber: 30,
  crystals: 4,
  telemetry: { embrace: 0, purify: 1, flightTime: 20, meleeKills: 10, resonanceSpent: 80 },
  missions: [],
  punches: [],
  ...over,
});

const cards = [
  run({
    stratumIndex: 1,
    level: 6,
    history: [{ stratum: 'seedbed', stratumName: 'The Seedbed', choice: { id: 'fusion', affinity: 'root', title: 'The Fusion of Roots and Silicon' }, kills: 12, echoes: 2, deaths: 1, time: 480, purified: 1, embraced: 0 }],
  }),
  run({
    stratumIndex: 2,
    level: 11,
    maxHp: 160,
    kills: 40,
    skillPoints: 2,
    tiers: { ...emptyTiers(), root: 2, flow: 1 },
    skin: 'verdant',
    purityPoints: 3,
    remembrances: ['purify', 'purify', 'embrace'],
    history: [
      { stratum: 'seedbed', stratumName: 'The Seedbed', choice: { id: 'fusion', affinity: 'root', title: 'The Fusion of Roots and Silicon' }, kills: 12, echoes: 2, deaths: 1, time: 480, purified: 1, embraced: 0 },
      { stratum: 'river', stratumName: 'The River of Becoming', choice: { id: 'unity', affinity: 'root', title: 'The River of Unity' }, kills: 22, echoes: 4, deaths: 0, time: 700, purified: 2, embraced: 1 },
    ],
  }),
  run({
    stratumIndex: 3,
    level: 16,
    maxHp: 190,
    kills: 70,
    tiers: { ...emptyTiers(), root: 2, echo: 1, flow: 1 },
    history: [
      { stratum: 'seedbed', stratumName: 'The Seedbed', choice: { id: 'memory', affinity: 'echo', title: 'The Awakening of Memory' }, kills: 10, echoes: 3, deaths: 0, time: 400, purified: 1, embraced: 0 },
      { stratum: 'river', stratumName: 'The River of Becoming', choice: { id: 'legacy', affinity: 'echo', title: 'The River of Legacy' }, kills: 20, echoes: 5, deaths: 1, time: 640, purified: 2, embraced: 0 },
      { stratum: 'canopy', stratumName: 'The Fractal Canopy', choice: { id: 'echoall', affinity: 'echo', title: 'The Echo of All Beings' }, kills: 28, echoes: 6, deaths: 1, time: 820, purified: 2, embraced: 1 },
    ],
  }),
  run({
    stratumIndex: 5,
    level: 20,
    maxHp: 220,
    kills: 96,
    echoes: [
      { x: 12, z: -6, affinity: 'root', stratum: 'seedbed', radius: 140 },
      { x: 40, z: 18, affinity: 'echo', stratum: 'canopy', radius: 140 },
      { x: -20, z: 30, affinity: 'flow', stratum: 'river', radius: 140 },
    ],
    tiers: { ...emptyTiers(), root: 3 },
    skin: 'verdant',
    purityPoints: 6,
    remembrances: ['purify', 'purify', 'purify', 'purify', 'purify', 'embrace'],
    history: [
      { stratum: 'seedbed', stratumName: 'The Seedbed', choice: { id: 'fusion', affinity: 'root', title: 'The Fusion of Roots and Silicon' }, kills: 12, echoes: 2, deaths: 0, time: 400, purified: 1, embraced: 0 },
      { stratum: 'river', stratumName: 'The River of Becoming', choice: { id: 'unity', affinity: 'root', title: 'The River of Unity' }, kills: 18, echoes: 3, deaths: 0, time: 560, purified: 2, embraced: 0 },
      { stratum: 'canopy', stratumName: 'The Fractal Canopy', choice: { id: 'symphony', affinity: 'root', title: 'The Symphony of the Unseen' }, kills: 24, echoes: 4, deaths: 1, time: 700, purified: 2, embraced: 1 },
      { stratum: 'veil', stratumName: 'The Veil of Void', kills: 16, echoes: 2, deaths: 1, time: 480, purified: 0, embraced: 0 },
      { stratum: 'mirror', stratumName: 'The Hollow Mirror', kills: 8, echoes: 1, deaths: 1, time: 900, purified: 0, embraced: 0 },
    ],
  }),
];

mkdirSync('storycards', { recursive: true });
const names = ['river', 'canopy', 'veil', 'return'];
for (let i = 0; i < cards.length; i++) {
  const card = buildStorycard(cards[i], [], NOW);
  const json = storycardToJSON(card);
  const md = storycardToMarkdown(card);
  parseStorycard(json);
  parseStorycard(md);
  writeFileSync(`storycards/${names[i]}.storycard.json`, json + '\n');
  writeFileSync(`storycards/${names[i]}.storycard.md`, md);
}
console.log('wrote', names.map((n) => `storycards/${n}.storycard.json`).join(', '));
