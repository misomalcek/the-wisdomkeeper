import type { Affinity, Item, Rarity, RunState, Slot, StatKey } from '../types';

// ---------------------------------------------------------------- items

export const SLOTS: Slot[] = ['helm', 'armor', 'boots', 'blade', 'modulator', 'core'];

export const SLOT_LABEL: Record<Slot, string> = {
  helm: 'Helm', armor: 'Armor', boots: 'Boots', blade: 'Root-Blade', modulator: 'Modulator', core: 'Core',
};

export const RARITY: Record<Rarity, { name: string; color: string; mul: number; stats: number }> = {
  common: { name: 'Common', color: '#c9d6d2', mul: 1, stats: 1 },
  uncommon: { name: 'Uncommon', color: '#6bff8a', mul: 1.25, stats: 2 },
  rare: { name: 'Rare', color: '#4fb4ff', mul: 1.6, stats: 2 },
  epic: { name: 'Epic', color: '#b084ff', mul: 2.1, stats: 3 },
  legendary: { name: 'Legendary', color: '#ffc14a', mul: 2.8, stats: 4 },
};
export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const STAT_LABEL: Record<StatKey, string> = {
  life: 'Life', damage: 'Damage', resRegen: 'Resonance regen', resMax: 'Max Resonance', dr: 'Damage reduction',
  speed: 'Move speed', dashCd: 'Dash recovery', power: 'Ability power', voidDmg: 'Damage vs Void',
};
const PCT: StatKey[] = ['damage', 'dr', 'speed', 'dashCd', 'power', 'voidDmg'];
export const fmtStat = (k: StatKey, v: number) => (PCT.includes(k) ? `+${Math.round(v * 100)}%` : k === 'resRegen' ? `+${v.toFixed(1)}/s` : `+${Math.round(v)}`);

const SLOT_STATS: Record<Slot, StatKey[]> = {
  helm: ['life', 'dr', 'resMax'],
  armor: ['life', 'dr', 'voidDmg'],
  boots: ['speed', 'dashCd', 'life'],
  blade: ['damage', 'voidDmg', 'power'],
  modulator: ['resRegen', 'resMax', 'power'],
  core: ['power', 'life', 'resRegen'],
};
const BASE: Record<StatKey, number> = {
  life: 14, damage: 0.05, resRegen: 0.7, resMax: 8, dr: 0.02, speed: 0.03, dashCd: 0.04, power: 0.06, voidDmg: 0.06,
};
const NAMES: Record<Slot, string[]> = {
  helm: ['Spore-Crown', 'Verdant Circlet', 'Mycelial Visor', 'Rootvein Helm'],
  armor: ['Heartwood Carapace', 'Silicon Bark Plate', 'Verdant Weave', 'Thornguard Mantle'],
  boots: ['Rootstride Greaves', 'Tidewalkers', 'Sporeprint Boots', 'Current Treads'],
  blade: ['Root-Blade Unit', 'Thornglaive', 'Heartwood Lance', 'Silicon Briar'],
  modulator: ['Phyto-Mycelial Modulator', 'Spore Resonator', 'Hyphal Tuner', 'Chlorophyll Coil'],
  core: ['Nano-Silicon Core', 'Memory Seed Core', 'Fractal Heart', 'Echo Kernel'],
};
const SUFFIX = ['of the Seedbed', 'of Quiet Roots', 'of the Spiral', 'of Remembrance', 'of the River', 'of Fractal Light'];

let itemSeq = 0;
export type Rand = () => number;

export function rollRarity(rand: Rand, weights: Partial<Record<Rarity, number>>): Rarity {
  const entries = RARITY_ORDER.map((r) => [r, weights[r] ?? 0] as const);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let roll = rand() * total;
  for (const [r, w] of entries) {
    roll -= w;
    if (roll <= 0) return r;
  }
  return 'common';
}

export function generateItem(rand: Rand, level: number, rarity: Rarity, slot?: Slot): Item {
  const sl = slot ?? SLOTS[Math.floor(rand() * SLOTS.length)];
  const pool = SLOT_STATS[sl];
  const n = Math.min(RARITY[rarity].stats, pool.length);
  const picks = [...pool].sort(() => rand() - 0.5).slice(0, n);
  const stats: Partial<Record<StatKey, number>> = {};
  for (const k of picks) {
    const v = BASE[k] * (1 + level * 0.1) * RARITY[rarity].mul * (0.85 + rand() * 0.3);
    stats[k] = k === 'life' || k === 'resMax' ? Math.round(v) : Math.round(v * 1000) / 1000;
  }
  const name = NAMES[sl][Math.floor(rand() * NAMES[sl].length)] + (rarity === 'epic' || rarity === 'legendary' ? ' ' + SUFFIX[Math.floor(rand() * SUFFIX.length)] : '');
  return { id: `i${Date.now().toString(36)}${(itemSeq++).toString(36)}`, slot: sl, name, rarity, level, stats };
}

export function itemScore(it: Item | undefined): number {
  if (!it) return 0;
  return Object.entries(it.stats).reduce((a, [k, v]) => a + (v ?? 0) / BASE[k as StatKey], 0);
}

// ---------------------------------------------------------------- xp

export const MAX_LEVEL = 20;
export const xpToNext = (level: number) => 80 + level * 70;

/** Adds xp, returns how many levels were gained. */
export function addXp(run: RunState, amount: number): number {
  if (run.level >= MAX_LEVEL) return 0;
  run.xp += amount;
  let gained = 0;
  while (run.level < MAX_LEVEL && run.xp >= xpToNext(run.level)) {
    run.xp -= xpToNext(run.level);
    run.level++;
    run.skillPoints++;
    gained++;
  }
  return gained;
}

// ---------------------------------------------------------------- skill tree

export interface SkillDef {
  id: string;
  branch: Affinity;
  name: string;
  desc: string;
  max: number;
  requires?: string;
}

export const SKILLS: SkillDef[] = [
  { id: 'deep_root', branch: 'root', name: 'Deep Root Resonance', desc: 'Tap into the Null’s fractal echo. +15% damage vs Void entities.', max: 1 },
  { id: 'spore_mastery', branch: 'root', name: 'Spore Mastery', desc: 'Entangling effects hold longer and slow harder; Root Spike roots +0.5s per rank.', max: 2, requires: 'deep_root' },
  { id: 'verdant_mend', branch: 'root', name: 'Verdant Mend', desc: 'Purified Static restores +2 life per rank.', max: 2, requires: 'spore_mastery' },
  { id: 'thorn_bark', branch: 'root', name: 'Thorn Bark', desc: '+4% damage reduction per rank.', max: 3, requires: 'verdant_mend' },
  { id: 'mother_network', branch: 'root', name: 'Mother Network', desc: 'Root Spike erupts 3 extra spikes.', max: 1, requires: 'thorn_bark' },
  { id: 'resonant_memory', branch: 'echo', name: 'Resonant Memory', desc: '+1.2 Resonance regeneration per second per rank.', max: 3 },
  { id: 'echo_strike', branch: 'echo', name: 'Echo Strike', desc: '+8% damage per rank.', max: 2, requires: 'resonant_memory' },
  { id: 'crystal_resolve', branch: 'echo', name: 'Crystal Resolve', desc: 'Fractal Shield absorbs +35 damage per rank.', max: 2, requires: 'echo_strike' },
  { id: 'library_roots', branch: 'echo', name: 'Library of Roots', desc: '+12% Resonance from every hit per rank.', max: 2, requires: 'crystal_resolve' },
  { id: 'afterimage', branch: 'echo', name: 'Afterimage', desc: 'Your dash detonates a resonant echo where it began.', max: 1, requires: 'library_roots' },
  { id: 'tidal_step', branch: 'flow', name: 'Tidal Step', desc: 'Dash recovers 10% faster per rank.', max: 3 },
  { id: 'current_rider', branch: 'flow', name: 'Current Rider', desc: 'Free flight drains 25% less Resonance per rank.', max: 2, requires: 'tidal_step' },
  { id: 'windbreaker', branch: 'flow', name: 'Windbreaker', desc: '+4% movement speed per rank.', max: 3, requires: 'current_rider' },
  { id: 'spiral_tempo', branch: 'flow', name: 'Spiral Tempo', desc: '+8% attack speed per rank.', max: 2, requires: 'windbreaker' },
  { id: 'chrono_bloom', branch: 'flow', name: 'Chrono Bloom', desc: 'Surge reaches 30% farther and dilates time around foes.', max: 1, requires: 'spiral_tempo' },
];

export const skillById = (id: string) => SKILLS.find((s) => s.id === id)!;

export function canRank(run: RunState, id: string): boolean {
  const s = skillById(id);
  if (!s || run.skillPoints <= 0) return false;
  if ((run.skills[id] ?? 0) >= s.max) return false;
  if (s.requires && (run.skills[s.requires] ?? 0) < skillById(s.requires).max) return false;
  return true;
}

export function rankUp(run: RunState, id: string): boolean {
  if (!canRank(run, id)) return false;
  run.skills[id] = (run.skills[id] ?? 0) + 1;
  run.skillPoints--;
  return true;
}

// ---------------------------------------------------------------- derived stats

export interface Derived {
  maxHp: number;
  maxRes: number;
  resRegen: number;
  dmgMul: number;
  voidMul: number;
  dr: number;
  speedMul: number;
  dashCdMul: number;
  power: number;
  shieldCap: number;
  flightDrain: number;
  spikeCount: number;
  healOnKill: number;
  attackSpeed: number;
  slowBonus: number;
  rootBonus: number;
  resGain: number;
  afterimage: boolean;
  chrono: boolean;
}

export function derive(run: RunState): Derived {
  const g: Record<StatKey, number> = { life: 0, damage: 0, resRegen: 0, resMax: 0, dr: 0, speed: 0, dashCd: 0, power: 0, voidDmg: 0 };
  for (const it of Object.values(run.equipped)) {
    if (!it) continue;
    for (const [k, v] of Object.entries(it.stats)) g[k as StatKey] += v ?? 0;
  }
  const sk = (id: string) => run.skills[id] ?? 0;
  return {
    maxHp: Math.max(40, Math.round(run.maxHp + 6 * (run.level - 1) + g.life - 6 * run.nullPoints)),
    maxRes: 100 + g.resMax,
    resRegen: 1.6 + g.resRegen + 1.2 * sk('resonant_memory'),
    dmgMul: 1 + g.damage + 0.1 * run.nullPoints + 0.08 * sk('echo_strike'),
    voidMul: 1 + g.voidDmg + 0.15 * sk('deep_root'),
    dr: Math.min(0.6, g.dr + 0.04 * sk('thorn_bark')),
    speedMul: 1 + g.speed + 0.04 * sk('windbreaker'),
    dashCdMul: Math.max(0.35, 1 - g.dashCd - 0.1 * sk('tidal_step')),
    power: 1 + g.power,
    shieldCap: Math.round(70 + 35 * sk('crystal_resolve') + g.power * 80),
    flightDrain: 1 - 0.25 * sk('current_rider'),
    spikeCount: 7 + 3 * sk('mother_network'),
    healOnKill: 2 * sk('verdant_mend'),
    attackSpeed: 1 + 0.08 * sk('spiral_tempo'),
    slowBonus: 0.15 * sk('spore_mastery'),
    rootBonus: 0.5 * sk('spore_mastery'),
    resGain: 1 + 0.12 * sk('library_roots'),
    afterimage: sk('afterimage') > 0,
    chrono: sk('chrono_bloom') > 0,
  };
}

export const SKINS: Record<string, { name: string; blurb: string; unlock: string }> = {
  resonant: { name: 'Resonant', blurb: 'The Keeper’s first form: cool current-light.', unlock: 'Always available' },
  verdant: { name: 'Verdant Mycelium', blurb: 'Green hyphal veins; grown by those who purify.', unlock: 'Purify 3 Remembrances' },
  void: { name: 'Void Resonant', blurb: 'Crimson null-light threading the armor.', unlock: 'Embrace 3 Remembrances' },
};

export function skinUnlocked(run: RunState, skin: string): boolean {
  if (skin === 'verdant') return run.purityPoints >= 3;
  if (skin === 'void') return run.nullPoints >= 3;
  return true;
}
