/**
 * Storycards — the "punch card" save format.
 *
 * A Storycard is a self-contained, portable snapshot of a player's story: the full RunState (so it can be
 * continued anywhere, including the browser build), the Library of finished Cycles, and a chronological log of
 * human-readable story beats ("punches"). It serialises to pretty JSON and to a readable Markdown card that ends
 * with a fenced ```storycard block holding the same JSON, so either file can be uploaded back.
 *
 * Everything here is pure and DOM-free. Uploaded cards are untrusted: `validateStorycard` rebuilds every object
 * from known fields only, checks types, ranges and lengths, and throws a `StorycardError` with a readable message.
 * The UI must still render card strings with textContent, never innerHTML.
 */
import type {
  Affinity, EchoRecord, HistoryEntry, Item, LibraryEntry, Mission, MissionKind, Punch, PunchKind, Rarity, Remembrance, RunState, Skin, Slot,
  StatKey, StratumId,
} from '../types';
import { STRATA } from '../story/strata';
import { AFFINITY_META } from '../story/story';
import { freshTelemetry, type PlayerTelemetry } from '../bio/mindState';
import { fmtTime } from '../util/math';

export const STORYCARD_FORMAT = 'wisdomkeeper.storycard';
export const STORYCARD_VERSION = 1;
/** Upload size cap (bytes / characters). */
export const MAX_CARD_BYTES = 2 * 1024 * 1024;
/** Punches kept on a run; older ones fall off the front. */
export const MAX_PUNCHES = 200;
/** Finished stories kept in the Library (matches the game's own cap). */
export const MAX_LIBRARY = 30;
export const DECK_KEY = 'wk.storycards.v1';
export const DECK_SIZE = 5;

export interface Storycard {
  format: typeof STORYCARD_FORMAT;
  version: typeof STORYCARD_VERSION;
  /** ISO timestamp of when the card was punched. */
  savedAt: string;
  /** e.g. "Cycle 2 · The River of Becoming · Lv 7" */
  title: string;
  punches: Punch[];
  /** The run itself (its `punches` live at the card's top level, not duplicated here). */
  run: RunState;
  library: LibraryEntry[];
}

export class StorycardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorycardError';
  }
}

// ------------------------------------------------------------------------------------------------ punches

const PUNCH_KINDS: readonly PunchKind[] = ['cycle', 'stratum', 'camp', 'pylon', 'remembrance', 'contact', 'choice', 'mission', 'boss', 'level', 'death', 'ending', 'note'];
const MAX_PUNCH_TEXT = 280;

const stratumName = (i: number) => STRATA[i]?.name ?? `Region ${i + 1}`;

/** Rebuilds a plausible punch log for an older save that predates Storycards. */
export function derivePunches(run: RunState): Punch[] {
  const out: Punch[] = [];
  const p = (kind: PunchKind, text: string, stratum: number, level = run.level) =>
    out.push({ kind, text: text.slice(0, MAX_PUNCH_TEXT), stratum, cycle: run.cycle, level });
  p('cycle', `Cycle ${run.cycle} began`, 0, 1);
  for (const h of run.history) {
    const idx = Math.max(0, STRATA.findIndex((s) => s.id === h.stratum));
    p('stratum', `Walked ${h.stratumName} — ${h.kills} Static purified, ${h.echoes} echo-tree${h.echoes === 1 ? '' : 's'}${h.deaths ? `, reseeded ${h.deaths}×` : ''}`, idx);
    if (h.choice) p('choice', `Chose “${h.choice.title}” (${AFFINITY_META[h.choice.affinity].name})`, idx);
  }
  run.remembrances.forEach((r, i) => p('remembrance', `Remembrance ${i + 1} ${r === 'purify' ? 'purified' : 'embraced — the Null spoke through it'}`, run.stratumIndex));
  if (!run.history.some((h) => h.stratum === STRATA[run.stratumIndex]?.id)) p('stratum', `Now walking ${stratumName(run.stratumIndex)}`, run.stratumIndex);
  return out.slice(-MAX_PUNCHES);
}

/** Punches a story beat onto the run. Skips an exact repeat of the latest beat; keeps the last MAX_PUNCHES. */
export function addPunch(run: RunState, kind: PunchKind, text: string, now: Date = new Date()): Punch | null {
  const list = (run.punches ??= derivePunches(run));
  const t = text.trim().slice(0, MAX_PUNCH_TEXT);
  if (!t) return null;
  const last = list[list.length - 1];
  if (last && last.kind === kind && last.text === t && last.stratum === run.stratumIndex) return null;
  const punch: Punch = { kind, text: t, stratum: run.stratumIndex, cycle: run.cycle, level: run.level, at: now.toISOString() };
  list.push(punch);
  if (list.length > MAX_PUNCHES) list.splice(0, list.length - MAX_PUNCHES);
  return punch;
}

/** The latest punch of a kind (from the reconstructed log on an older save). */
export function lastPunchOf(run: RunState, kind: PunchKind): Punch | undefined {
  const list = run.punches ?? derivePunches(run);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === kind) return list[i];
  return undefined;
}

// ------------------------------------------------------------------------------------------------ building

export function cardTitle(run: RunState) {
  return `Cycle ${run.cycle} · ${stratumName(run.stratumIndex)} · Lv ${run.level}`;
}

/** Punches a Storycard from a run. The run is deep-copied, so later play does not mutate the card. */
export function buildStorycard(run: RunState, library: LibraryEntry[] = [], now: Date = new Date()): Storycard {
  const copy = JSON.parse(JSON.stringify(run)) as RunState;
  const punches = copy.punches ?? derivePunches(copy);
  delete copy.punches;
  return {
    format: STORYCARD_FORMAT,
    version: STORYCARD_VERSION,
    savedAt: now.toISOString(),
    title: cardTitle(run),
    punches,
    run: copy,
    library: JSON.parse(JSON.stringify(library.slice(-MAX_LIBRARY))) as LibraryEntry[],
  };
}

/** The run a card continues: its own deep copy with the punches re-attached. */
export function runFromCard(card: Storycard): RunState {
  const run = JSON.parse(JSON.stringify(card.run)) as RunState;
  run.punches = JSON.parse(JSON.stringify(card.punches)) as Punch[];
  return run;
}

/** JSON with every backtick escaped (only possible inside strings), so it can never close a Markdown fence. */
export function storycardToJSON(card: Storycard): string {
  return JSON.stringify(card, null, 2).replace(/`/g, '\\u0060');
}

const mdEsc = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').replace(/[\\`*_[\]<>|#~]/g, '\\$&');
const pad2 = (n: number) => String(n).padStart(2, '0');

export function storycardToMarkdown(card: Storycard): string {
  const r = card.run;
  const def = STRATA[r.stratumIndex];
  const purified = r.remembrances.filter((x) => x === 'purify').length;
  const tiers = (['root', 'echo', 'flow'] as Affinity[]).map((a) => `${AFFINITY_META[a].name} ${r.tiers[a]}/3`).join(' · ');
  const L: string[] = [];
  L.push(`# Wisdomkeeper Storycard — ${mdEsc(card.title)}`, '');
  L.push(`> Punched ${mdEsc(card.savedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'))} · ${STORYCARD_FORMAT} v${card.version}`, '');
  L.push('| | |', '|---|---|');
  const row = (k: string, v: string | number) => L.push(`| ${k} | ${mdEsc(String(v))} |`);
  row('Cycle', r.cycle);
  row('Region', `${def.act} — ${def.name} (${r.stratumIndex + 1}/${STRATA.length})`);
  row('Level', `${r.level} · ${r.skillPoints} unspent skill point${r.skillPoints === 1 ? '' : 's'}`);
  row('Max life', r.maxHp);
  row('Static purified', r.kills);
  row('Reseeded', `${r.deaths}×`);
  row('Echo-trees', r.echoes.length);
  row('Remembrances', `${purified} purified · ${r.remembrances.length - purified} embraced`);
  row('Affinities', tiers);
  row('Void Crystals', r.crystals ?? 0);
  row('Armor', r.skin);
  row('Time in the world', fmtTime(r.elapsed));
  L.push('');

  if (r.history.length) {
    L.push('## Chapters', '');
    for (const h of r.history) {
      const bits = [`${h.kills} Static purified`, `${h.echoes} echo-trees`, fmtTime(h.time)];
      if (h.deaths) bits.push(`reseeded ${h.deaths}×`);
      L.push(`- **${mdEsc(h.stratumName)}**${h.choice ? ` — chose *${mdEsc(h.choice.title)}* (${AFFINITY_META[h.choice.affinity].name})` : ''} · ${bits.join(' · ')}`);
      if (h.mindNote) L.push(`  - The Mycelial Mind noticed: ${mdEsc(h.mindNote)}`);
    }
    L.push('');
  }

  L.push('## Punches', '');
  if (!card.punches.length) L.push('*No beats punched yet.*');
  let chapter = -1;
  for (const p of card.punches) {
    if (p.stratum !== chapter) {
      chapter = p.stratum;
      if (L[L.length - 1] !== '') L.push('');
      L.push(`### ${mdEsc(stratumName(p.stratum))}`, '');
    }
    const when = p.at ? `${p.at.slice(0, 10)} ${p.at.slice(11, 16)} · ` : '';
    L.push(`- \`${p.kind}\` ${mdEsc(p.text)} *(${when}Lv ${p.level})*`);
  }
  L.push('');

  if (r.remembrances.length) {
    L.push('## Remembrances', '');
    r.remembrances.forEach((x, i) => L.push(`${i + 1}. ${x === 'purify' ? 'Purified' : 'Embraced the Null'}`));
    L.push('');
  }

  if (card.library.length) {
    L.push('## Library of Cycles', '');
    for (const e of card.library) L.push(`- Cycle ${e.cycle} — **${mdEsc(e.title)}** (${mdEsc(e.date)})`);
    L.push('');
  }

  L.push('## Card data', '');
  L.push('Upload this file (or its .json twin) in Wisdomkeeper → Storycards to continue this story on any device.', '');
  L.push('```storycard', storycardToJSON(card), '```', '');
  return L.join('\n');
}

/** `wisdomkeeper-<stratum>-<yyyymmdd-hhmm>.storycard.<ext>` in the player's local time. */
export function storycardFilename(card: Storycard, ext: 'json' | 'md', now: Date = new Date(card.savedAt)): string {
  const d = Number.isNaN(now.getTime()) ? new Date() : now;
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return `wisdomkeeper-${STRATA[card.run.stratumIndex]?.id ?? 'story'}-${stamp}.storycard.${ext}`;
}

// ------------------------------------------------------------------------------------------------ parsing & validation

const fail = (path: string, what: string): never => {
  throw new StorycardError(`Invalid storycard: ${path} ${what}.`);
};
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown, path: string): Obj => (isObj(v) ? v : fail(path, 'must be an object'));
const num = (v: unknown, path: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  const n = v as number;
  if (n < min || n > max) fail(path, `must be between ${min} and ${max}`);
  return n;
};
const int = (v: unknown, path: string, min: number, max: number): number => {
  const n = num(v, path, min, max);
  if (!Number.isInteger(n)) fail(path, 'must be a whole number');
  return n;
};
const str = (v: unknown, path: string, max: number, min = 0): string => {
  if (typeof v !== 'string') fail(path, 'must be text');
  const s = v as string;
  if (s.length < min || s.length > max) fail(path, `must be ${min}–${max} characters long`);
  return s;
};
const oneOf = <T extends string>(v: unknown, path: string, options: readonly T[]): T =>
  options.includes(v as T) ? (v as T) : fail(path, `must be one of ${options.join(', ')}`);
const arr = (v: unknown, path: string, max: number): unknown[] => {
  if (!Array.isArray(v)) fail(path, 'must be a list');
  const a = v as unknown[];
  if (a.length > max) fail(path, `has too many entries (max ${max})`);
  return a;
};
const opt = <T>(v: unknown, f: (v: unknown) => T): T | undefined => (v === undefined ? undefined : f(v));

const BIG = 1e9;
const COORD = 1e5;
const AFFINITIES: readonly Affinity[] = ['root', 'echo', 'flow'];
const STRATUM_IDS: readonly StratumId[] = ['seedbed', 'river', 'canopy', 'veil', 'mirror', 'return'];
const SLOTS: readonly Slot[] = ['helm', 'armor', 'boots', 'blade', 'modulator', 'core'];
const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const STAT_KEYS: readonly StatKey[] = ['life', 'damage', 'resRegen', 'resMax', 'dr', 'speed', 'dashCd', 'power', 'voidDmg'];
const SKINS: readonly Skin[] = ['resonant', 'verdant', 'void'];
const REMEMBRANCES: readonly Remembrance[] = ['purify', 'embrace'];
const MISSION_KINDS: readonly MissionKind[] = ['pool', 'harvest', 'hunt', 'contact'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ident = (v: unknown, path: string) => {
  const s = str(v, path, 64, 1);
  if (!ID_RE.test(s) || FORBIDDEN_KEYS.has(s)) fail(path, 'is not a valid identifier');
  return s;
};
const stratumIdx = (v: unknown, path: string) => int(v, path, 0, STRATA.length - 1);

function vItem(v: unknown, path: string): Item {
  const o = obj(v, path);
  const statsIn = obj(o.stats, `${path}.stats`);
  const stats: Item['stats'] = {};
  for (const [k, val] of Object.entries(statsIn)) stats[oneOf(k, `${path}.stats key`, STAT_KEYS)] = num(val, `${path}.stats.${k}`, -1e6, 1e6);
  return {
    id: ident(o.id, `${path}.id`),
    slot: oneOf(o.slot, `${path}.slot`, SLOTS),
    name: str(o.name, `${path}.name`, 120, 1),
    rarity: oneOf(o.rarity, `${path}.rarity`, RARITIES),
    level: int(o.level, `${path}.level`, 0, 10000),
    stats,
  };
}

function vHistory(v: unknown, path: string): HistoryEntry {
  const o = obj(v, path);
  const h: HistoryEntry = {
    stratum: oneOf(o.stratum, `${path}.stratum`, STRATUM_IDS),
    stratumName: str(o.stratumName, `${path}.stratumName`, 80),
    kills: int(o.kills, `${path}.kills`, 0, BIG),
    echoes: int(o.echoes, `${path}.echoes`, 0, BIG),
    deaths: int(o.deaths, `${path}.deaths`, 0, BIG),
    time: num(o.time, `${path}.time`, 0, BIG),
  };
  const ch = opt(o.choice, (c) => {
    const co = obj(c, `${path}.choice`);
    return { id: ident(co.id, `${path}.choice.id`), affinity: oneOf(co.affinity, `${path}.choice.affinity`, AFFINITIES), title: str(co.title, `${path}.choice.title`, 160) };
  });
  if (ch) h.choice = ch;
  const purified = opt(o.purified, (x) => int(x, `${path}.purified`, 0, BIG));
  if (purified !== undefined) h.purified = purified;
  const embraced = opt(o.embraced, (x) => int(x, `${path}.embraced`, 0, BIG));
  if (embraced !== undefined) h.embraced = embraced;
  const note = opt(o.mindNote, (x) => str(x, `${path}.mindNote`, 600));
  if (note !== undefined) h.mindNote = note;
  return h;
}

function vEcho(v: unknown, path: string): EchoRecord {
  const o = obj(v, path);
  return {
    x: num(o.x, `${path}.x`, -COORD, COORD),
    z: num(o.z, `${path}.z`, -COORD, COORD),
    affinity: oneOf(o.affinity, `${path}.affinity`, AFFINITIES),
    stratum: oneOf(o.stratum, `${path}.stratum`, STRATUM_IDS),
    radius: num(o.radius, `${path}.radius`, 0.001, COORD),
  };
}

function vMission(v: unknown, path: string): Mission {
  const o = obj(v, path);
  return {
    id: int(o.id, `${path}.id`, 0, BIG),
    kind: oneOf(o.kind, `${path}.kind`, MISSION_KINDS),
    title: str(o.title, `${path}.title`, 160),
    brief: str(o.brief, `${path}.brief`, 600),
    stratum: stratumIdx(o.stratum, `${path}.stratum`),
    x: num(o.x, `${path}.x`, -COORD, COORD),
    z: num(o.z, `${path}.z`, -COORD, COORD),
    need: num(o.need, `${path}.need`, 0, BIG),
    have: num(o.have, `${path}.have`, 0, BIG),
    reward: num(o.reward, `${path}.reward`, 0, BIG),
    target: int(o.target, `${path}.target`, -1, BIG),
    state: oneOf(o.state, `${path}.state`, ['active', 'done'] as const),
  };
}

function vTelemetry(v: unknown, path: string): PlayerTelemetry {
  const o = obj(v, path);
  const t = freshTelemetry();
  for (const k of Object.keys(t) as (keyof PlayerTelemetry)[]) if (o[k] !== undefined) t[k] = num(o[k], `${path}.${k}`, 0, 1e12);
  return t;
}

export function vPunch(v: unknown, path: string): Punch {
  const o = obj(v, path);
  const p: Punch = {
    kind: oneOf(o.kind, `${path}.kind`, PUNCH_KINDS),
    text: str(o.text, `${path}.text`, MAX_PUNCH_TEXT, 1),
    stratum: stratumIdx(o.stratum, `${path}.stratum`),
    cycle: int(o.cycle, `${path}.cycle`, 1, 9999),
    level: int(o.level, `${path}.level`, 1, 1000),
  };
  const at = opt(o.at, (x) => str(x, `${path}.at`, 40));
  if (at !== undefined) p.at = at;
  return p;
}

function vLibrary(v: unknown, path: string): LibraryEntry {
  const o = obj(v, path);
  return {
    cycle: int(o.cycle, `${path}.cycle`, 1, 9999),
    title: str(o.title, `${path}.title`, 200),
    ending: str(o.ending, `${path}.ending`, 40),
    text: str(o.text, `${path}.text`, 20000),
    date: str(o.date, `${path}.date`, 40),
  };
}

/**
 * Edition hook: a build that adds its own block to the run (the desktop edition's `evolution` chronicle) registers
 * a validator here. Without one, an unknown block is dropped like any other unknown field.
 */
export const runExtensions: { evolution?: (v: unknown, path: string) => unknown } = {};

/** Validates an untrusted RunState and rebuilds it from known fields only (older optional fields are filled in). */
export function validateRun(v: unknown, path = 'run'): RunState {
  const o = obj(v, path);
  if (o.version !== 2) fail(`${path}.version`, 'must be 2 (an unsupported save version)');
  const tiersIn = obj(o.tiers, `${path}.tiers`);
  const tiers = { root: 0, echo: 0, flow: 0 } as Record<Affinity, number>;
  for (const a of AFFINITIES) tiers[a] = int(tiersIn[a], `${path}.tiers.${a}`, 0, 3);

  const skillsIn = obj(o.skills, `${path}.skills`);
  const skillEntries = Object.entries(skillsIn);
  if (skillEntries.length > 64) fail(`${path}.skills`, 'has too many entries (max 64)');
  const skills = Object.fromEntries(skillEntries.map(([k, r]) => [ident(k, `${path}.skills key`), int(r, `${path}.skills.${k}`, 0, 99)]));

  const equippedIn = obj(o.equipped, `${path}.equipped`);
  const equipped: RunState['equipped'] = {};
  for (const [k, it] of Object.entries(equippedIn)) {
    const slot = oneOf(k, `${path}.equipped key`, SLOTS);
    const item = vItem(it, `${path}.equipped.${slot}`);
    if (item.slot !== slot) fail(`${path}.equipped.${slot}.slot`, `must be ${slot}`);
    equipped[slot] = item;
  }

  const run: RunState = {
    version: 2,
    cycle: int(o.cycle, `${path}.cycle`, 1, 9999),
    seed: int(o.seed, `${path}.seed`, 0, 0xffffffff),
    stratumIndex: stratumIdx(o.stratumIndex, `${path}.stratumIndex`),
    tiers,
    history: arr(o.history, `${path}.history`, 64).map((h, i) => vHistory(h, `${path}.history[${i}]`)),
    echoes: arr(o.echoes, `${path}.echoes`, 4000).map((e, i) => vEcho(e, `${path}.echoes[${i}]`)),
    maxHp: num(o.maxHp, `${path}.maxHp`, 1, 1e6),
    deaths: int(o.deaths, `${path}.deaths`, 0, BIG),
    kills: int(o.kills, `${path}.kills`, 0, BIG),
    elapsed: num(o.elapsed, `${path}.elapsed`, 0, BIG),
    difficulty: num(o.difficulty, `${path}.difficulty`, 0.05, 100),
    latent: arr(o.latent, `${path}.latent`, 32).map((x, i) => num(x, `${path}.latent[${i}]`, -1e3, 1e3)),
    level: int(o.level, `${path}.level`, 1, 1000),
    xp: num(o.xp, `${path}.xp`, 0, 1e12),
    skillPoints: int(o.skillPoints, `${path}.skillPoints`, 0, 100000),
    skills,
    inventory: arr(o.inventory, `${path}.inventory`, 400).map((it, i) => vItem(it, `${path}.inventory[${i}]`)),
    equipped,
    skin: oneOf(o.skin, `${path}.skin`, SKINS),
    nullPoints: int(o.nullPoints, `${path}.nullPoints`, 0, 1000),
    purityPoints: int(o.purityPoints, `${path}.purityPoints`, 0, 1000),
    remembrances: arr(o.remembrances, `${path}.remembrances`, 100).map((r, i) => oneOf(r, `${path}.remembrances[${i}]`, REMEMBRANCES)),
    crystals: opt(o.crystals, (x) => int(x, `${path}.crystals`, 0, BIG)) ?? 0,
    telemetry: opt(o.telemetry, (x) => vTelemetry(x, `${path}.telemetry`)) ?? freshTelemetry(),
    missions: opt(o.missions, (x) => arr(x, `${path}.missions`, 300).map((m, i) => vMission(m, `${path}.missions[${i}]`))) ?? [],
  };
  const fiber = opt(o.fiber, (x) => num(x, `${path}.fiber`, 0, 1e6));
  if (fiber !== undefined) run.fiber = fiber;
  const punches = opt(o.punches, (x) => arr(x, `${path}.punches`, MAX_PUNCHES * 5).map((p, i) => vPunch(p, `${path}.punches[${i}]`)));
  if (punches) run.punches = punches.slice(-MAX_PUNCHES);
  if (o.evolution !== undefined && runExtensions.evolution) run.evolution = runExtensions.evolution(o.evolution, `${path}.evolution`);
  return run;
}

/** Validates an untrusted, already-parsed Storycard object and returns a clean, migrated copy. */
export function validateStorycard(v: unknown): Storycard {
  const o = obj(v, 'card');
  if (o.format !== STORYCARD_FORMAT) throw new StorycardError('This is not a Wisdomkeeper storycard (missing "format": "wisdomkeeper.storycard").');
  if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) fail('card.version', 'must be a positive whole number');
  if ((o.version as number) > STORYCARD_VERSION) {
    throw new StorycardError(`This storycard was made by a newer Wisdomkeeper (card v${o.version}; this game reads v${STORYCARD_VERSION}). Update the game to load it.`);
  }
  const run = validateRun(o.run, 'run');
  const punchesIn = opt(o.punches, (x) => arr(x, 'punches', MAX_PUNCHES * 5).map((p, i) => vPunch(p, `punches[${i}]`)));
  const punches = (punchesIn ?? run.punches ?? derivePunches(run)).slice(-MAX_PUNCHES);
  delete run.punches;
  const library = (opt(o.library, (x) => arr(x, 'library', 100).map((e, i) => vLibrary(e, `library[${i}]`))) ?? []).slice(-MAX_LIBRARY);
  return {
    format: STORYCARD_FORMAT,
    version: STORYCARD_VERSION,
    savedAt: opt(o.savedAt, (x) => str(x, 'savedAt', 40)) ?? new Date(0).toISOString(),
    title: opt(o.title, (x) => str(x, 'title', 200)) ?? cardTitle(run),
    punches,
    run,
    library,
  };
}

const FENCE_RE = /^```storycard[ \t]*\n([\s\S]*?)\n```[ \t]*$/m;

/** Parses an uploaded .json or .md storycard. Throws StorycardError with a readable message on anything else. */
export function parseStorycard(text: string): Storycard {
  if (typeof text !== 'string') throw new StorycardError('The storycard file could not be read as text.');
  if (text.length > MAX_CARD_BYTES) throw new StorycardError(`This file is too large to be a storycard (limit ${MAX_CARD_BYTES / 1024 / 1024} MB).`);
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!src) throw new StorycardError('The file is empty.');
  let json = src;
  if (!src.startsWith('{')) {
    const m = FENCE_RE.exec(src);
    if (!m) throw new StorycardError('No storycard data found. A Markdown card must still contain the ```storycard block it was downloaded with.');
    json = m[1];
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new StorycardError(`The storycard data is not valid JSON (${(e as Error).message}).`);
  }
  return validateStorycard(data);
}

/** Adds an uploaded card's finished stories to the local Library (deduplicated, oldest first, capped). */
export function mergeLibrary(current: LibraryEntry[], incoming: LibraryEntry[], max = MAX_LIBRARY): LibraryEntry[] {
  const key = (e: LibraryEntry) => `${e.cycle}\u0000${e.date}\u0000${e.title}\u0000${e.text}`;
  const seen = new Set(current.map(key));
  const out = current.slice();
  for (const e of incoming) {
    const k = key(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.slice(-max);
}

// ------------------------------------------------------------------------------------------------ autosave deck

/** FNV-1a (32-bit) — a cheap content fingerprint for deduplicating autosaves. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const contentKey = (card: Storycard) => fingerprint(JSON.stringify([card.run, card.punches]));

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface DeckEntry {
  hash: string;
  card: Storycard;
}

/**
 * The autosave deck: the last few distinct cards, newest first, so a player can roll back.
 * Deck cards leave the Library out (it is kept separately and only ever grows) to spare storage quota.
 * Storage failures (private mode, quota) never throw: the deck shrinks until it fits, or silently stays in memory.
 */
export class StoryDeck {
  private cache: DeckEntry[] | null = null;
  constructor(
    private readonly storage: () => StorageLike | null,
    readonly key = DECK_KEY,
    readonly max = DECK_SIZE,
  ) {}

  list(): DeckEntry[] {
    if (this.cache) return this.cache;
    const out: DeckEntry[] = [];
    try {
      const raw = this.storage()?.getItem(this.key);
      const data: unknown = raw && raw.length <= MAX_CARD_BYTES * this.max ? JSON.parse(raw) : [];
      if (Array.isArray(data)) {
        for (const e of data.slice(0, this.max)) {
          try {
            const card = validateStorycard(isObj(e) ? e.card : null);
            out.push({ hash: contentKey(card), card });
          } catch {
            /* a corrupt slot is dropped, the rest of the deck survives */
          }
        }
      }
    } catch {
      /* unreadable deck: start empty */
    }
    return (this.cache = out);
  }

  /** Pushes a card to the top. Returns false when nothing new was stored (duplicate) or storage refused it. */
  push(card: Storycard): boolean {
    const slim: Storycard = { ...card, library: [] };
    const hash = contentKey(slim);
    const deck = this.list();
    if (deck[0]?.hash === hash) return false;
    const next = [{ hash, card: slim }, ...deck.filter((e) => e.hash !== hash)].slice(0, this.max);
    this.cache = next;
    return this.persist(next);
  }

  private persist(entries: DeckEntry[]): boolean {
    for (let n = entries.length; n >= 1; n--) {
      try {
        const s = this.storage();
        if (!s) return false;
        s.setItem(this.key, JSON.stringify(entries.slice(0, n).map((e) => ({ card: e.card }))));
        if (n < entries.length) this.cache = entries.slice(0, n);
        return true;
      } catch {
        /* quota: retry with fewer cards */
      }
    }
    return false;
  }
}
