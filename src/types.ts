import type { PlayerTelemetry } from './bio/mindState';
export type Affinity = 'root' | 'echo' | 'flow';
export type StratumId = 'seedbed' | 'river' | 'canopy' | 'veil' | 'mirror' | 'return';
export type EnemyKind = 'mite' | 'spitter' | 'brute' | 'drone' | 'stalker' | 'bloater' | 'prism' | 'lasher' | 'pylon' | 'boss';
/** Which boss a stratum fields: the Null Warden (Interlude) or the Void-Infused Construct (Act IV). */
export type BossVariant = 'warden' | 'construct';
export type Slot = 'helm' | 'armor' | 'boots' | 'blade' | 'modulator' | 'core';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export type StatKey = 'life' | 'damage' | 'resRegen' | 'resMax' | 'dr' | 'speed' | 'dashCd' | 'power' | 'voidDmg';
export type Skin = 'resonant' | 'verdant' | 'void';
export type Remembrance = 'purify' | 'embrace';

export interface Item {
  id: string;
  slot: Slot;
  name: string;
  rarity: Rarity;
  level: number;
  stats: Partial<Record<StatKey, number>>;
}

export interface Choice {
  id: string;
  affinity: Affinity;
  title: string;
  blurb: string;
  /** First-person line stitched into the final story. */
  epilogue: string;
}

export interface ChoiceSet {
  act: string;
  prompt: string;
  choices: Choice[];
}

export interface HistoryEntry {
  stratum: StratumId;
  stratumName: string;
  choice?: { id: string; affinity: Affinity; title: string };
  kills: number;
  echoes: number;
  deaths: number;
  time: number;
  purified?: number;
  embraced?: number;
  /** What the Mycelial Mind noticed about the player in this stratum. */
  mindNote?: string;
}

export interface EchoRecord {
  x: number;
  z: number;
  affinity: Affinity;
  stratum: StratumId;
  /** Stratum radius at planting time, so the Return can rescale positions. */
  radius: number;
}

export interface PlayStats {
  /** ranged shots + melee swings */
  shots: number;
  hits: number;
  damageTaken: number;
  distance: number;
  time: number;
  combatTime: number;
  dashes: number;
}

export interface RunState {
  version: 2;
  cycle: number;
  seed: number;
  stratumIndex: number;
  tiers: Record<Affinity, number>;
  history: HistoryEntry[];
  echoes: EchoRecord[];
  maxHp: number;
  deaths: number;
  kills: number;
  elapsed: number;
  difficulty: number;
  /** Latent world code produced by the Mycelial Mind from player style. */
  latent: number[];
  level: number;
  xp: number;
  skillPoints: number;
  skills: Record<string, number>;
  inventory: Item[];
  equipped: Partial<Record<Slot, Item>>;
  skin: Skin;
  nullPoints: number;
  purityPoints: number;
  remembrances: Remembrance[];
  /** Mycelial Fiber carried between regions (flight/levitation fuel). Optional for older saves. */
  fiber?: number;
  /** Void Crystals: currency from pylon purges and Null defeats, spent to infuse gear. */
  crystals?: number;
  /** Blueprint player telemetry fed to the Mycelial Mind state machine. */
  telemetry?: PlayerTelemetry;
  /** Side missions offered by the Neural World Director. */
  missions?: Mission[];
  /** Storycard punches: the chronological log of story beats (optional for older saves). */
  punches?: Punch[];
}

export type PunchKind =
  | 'cycle' | 'stratum' | 'camp' | 'pylon' | 'remembrance' | 'contact' | 'choice' | 'mission' | 'boss' | 'level' | 'death' | 'ending' | 'note' | 'land';
/** One human-readable story beat punched onto the player's Storycard. */
export interface Punch {
  kind: PunchKind;
  text: string;
  /** Stratum index the beat happened in. */
  stratum: number;
  cycle: number;
  level: number;
  /** ISO timestamp; absent on punches reconstructed from an older save. */
  at?: string;
}

export interface LibraryEntry {
  cycle: number;
  title: string;
  ending: string;
  text: string;
  date: string;
}

export type MissionKind = 'pool' | 'harvest' | 'hunt' | 'contact';
export interface Mission {
  id: number;
  kind: MissionKind;
  title: string;
  brief: string;
  /** stratum index the mission belongs to */
  stratum: number;
  x: number;
  z: number;
  need: number;
  have: number;
  reward: number;
  /** pool: camp id · hunt: 1 drones / 0 fiends · otherwise -1 */
  target: number;
  state: 'active' | 'done';
}
