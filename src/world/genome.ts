/**
 * World Genome: one small, bounded parameter vector that every procedural generator of a region reads (landforms,
 * Orbit Isles, palettes, glyphs, the living field). It is *derived*, never stored: seed + region + the choices
 * already recorded on the run (remembrances, affinity choices, the Mycelial Mind's latent code, the cycle). So a
 * Storycard regenerates the same genome, and the world visibly inherits what the player did in the region before.
 *
 * Phase 2 (desktop) imports this module unchanged: its local models propose extra mutations, which are clamped to the
 * same GENES table and recorded in the Chronicle. `genomeGrammar()` emits the GBNF grammar for those proposals from
 * the table, so web and desktop can never disagree about a gene's range.
 *
 * Every gene lives in its natural units inside [min, max]; mutations are applied in the normalised 0..1 coordinate
 * of that range and clamped, so one "step" means the same thing for every gene.
 */
import type { RunState, StratumId } from '../types';
import { Rng, hashString } from '../util/rng';
import { clamp } from '../util/math';

export interface GeneDef {
  min: number;
  max: number;
  /** One line for tooltips, the Storycard and the P2 model prompt. */
  about: string;
}

export const GENES = {
  warp: { min: 1.0, max: 3.4, about: 'domain-warp strength of the rolling land (higher: more flowing, folded hills)' },
  ridge: { min: 0.5, max: 1.5, about: 'height of crystal ridges and Orbit Isle rims' },
  erosion: { min: 0, max: 1, about: 'depth of slope-following gullies' },
  terrace: { min: 0, max: 1, about: 'how strongly meadows step into mushroom mesas' },
  isles: { min: 0.25, max: 0.95, about: 'share of the Wilds that carry an Orbit Isle' },
  isleSize: { min: 0.8, max: 1.25, about: 'scale of Orbit Isles' },
  vegHue: { min: 165, max: 200, about: 'OKLCH hue of living light (cyan to green, the 480-520 nm band)' },
  nullHue: { min: 340, max: 375, about: 'OKLCH hue of the Null (magenta to red, the 620-700 nm band; wraps past 360)' },
  chroma: { min: 0.7, max: 1.25, about: 'colour intensity of grounds and glow' },
  growth: { min: 0.75, max: 1.3, about: 'flora vigour' },
  excite: { min: 0.6, max: 1.6, about: 'excitability of the living corruption field (speed of Null fronts)' },
  mercy: { min: 0.6, max: 1.6, about: 'strength of purification waves' },
  juliaA: { min: 0, max: 1, about: 'family and angle of the region Julia constant (selects which fractal the land remembers)' },
  juliaB: { min: 0, max: 1, about: 'depth of the Julia constant inside its bulb (rounder lakes vs wilder shores)' },
} as const satisfies Record<string, GeneDef>;

export type GeneKey = keyof typeof GENES;
export type Genome = Record<GeneKey, number>;
export const GENE_KEYS = Object.keys(GENES) as GeneKey[];

const norm = (k: GeneKey, v: number) => (v - GENES[k].min) / (GENES[k].max - GENES[k].min);
const denorm = (k: GeneKey, t: number) => GENES[k].min + clamp(t, 0, 1) * (GENES[k].max - GENES[k].min);

/** A mutation in normalised units (+0.1 = a tenth of the gene's range). */
export type Mutation = Partial<Record<GeneKey, number>>;

export function mutate(g: Genome, m: Mutation): Genome {
  const out = { ...g };
  for (const k of Object.keys(m) as GeneKey[]) {
    const t = norm(k, g[k]) + (m[k] ?? 0);
    // juliaA selects a fractal family by angle: it wraps, so later cycles keep rotating through families
    out[k] = k === 'juliaA' ? t - Math.floor(t) : denorm(k, t);
  }
  return out;
}

/** Region flavour priors: each stratum leans its genes a little (normalised centre of the prior). */
const PRIOR: Partial<Record<StratumId, Mutation>> = {
  seedbed: { terrace: 0.15, isles: -0.1, growth: 0.05 },
  river: { warp: 0.15, erosion: 0.15, isles: 0.05 },
  canopy: { growth: 0.2, ridge: -0.1, terrace: -0.1 },
  veil: { excite: 0.2, nullHue: 0.1, isles: 0.1 },
  mirror: { ridge: 0.25, isles: 0.25, isleSize: 0.15, erosion: 0.1 },
  return: { mercy: 0.15, chroma: 0.1 },
};

/** The genome a fresh world of this seed and region is born with, before any choice. */
export function baseGenome(seed: number, stratum: StratumId): Genome {
  const rng = new Rng(hashString(`genome:${seed}:${stratum}`));
  const g = {} as Genome;
  const prior = PRIOR[stratum] ?? {};
  for (const k of GENE_KEYS) {
    // centred prior with a modest spread: worlds differ, none are extreme at birth
    const t = 0.5 + (prior[k] ?? 0) + (rng.next() - 0.5) * 0.5;
    g[k] = denorm(k, t);
  }
  g.juliaA = rng.next();
  g.juliaB = rng.next();
  return g;
}

export interface Drift {
  /** Mutation that was applied. */
  m: Mutation;
  /** Why, in story words (shown on region entry and punched to the Storycard). */
  why: string;
}

/**
 * What the run so far does to the next region's genome. Pure function of recorded run state, so loading a Storycard
 * reproduces it. Returns the individual drifts (for the narration) in a fixed order.
 */
export function lineageDrifts(run: Pick<RunState, 'remembrances' | 'history' | 'latent' | 'cycle' | 'tiers'>): Drift[] {
  const out: Drift[] = [];
  const emb = run.remembrances.filter((r) => r === 'embrace').length;
  const pur = run.remembrances.length - emb;
  if (emb) out.push({ m: { excite: 0.08 * emb, nullHue: 0.06 * emb, chroma: 0.03 * emb, mercy: -0.04 * emb }, why: `${emb} embraced remembrance${emb > 1 ? 's' : ''}: the Null runs quicker here, its red deeper` });
  if (pur) out.push({ m: { mercy: 0.08 * pur, vegHue: 0.05 * pur, erosion: -0.04 * pur, excite: -0.04 * pur }, why: `${pur} purified remembrance${pur > 1 ? 's' : ''}: purification waves carry further, the land is gentler` });
  const t = run.tiers;
  if (t.root) out.push({ m: { growth: 0.07 * t.root, terrace: 0.06 * t.root }, why: 'roots chosen: flora grows thicker, meadows step into mesas' });
  if (t.echo) out.push({ m: { isles: 0.07 * t.echo, juliaB: 0.08 * t.echo }, why: 'memory chosen: more Orbit Isles remember their fractal' });
  if (t.flow) out.push({ m: { warp: 0.07 * t.flow, erosion: 0.06 * t.flow }, why: 'flow chosen: the land folds and gullies deepen' });
  const l = run.latent;
  if (l.some((v) => Math.abs(v) > 0.05)) out.push({ m: { ridge: 0.12 * l[0], growth: 0.1 * l[1], vegHue: 0.12 * l[2], isleSize: 0.1 * l[3] }, why: 'the Mycelial Mind answered your style' });
  if (run.cycle > 1) out.push({ m: { juliaA: 0.137 * (run.cycle - 1), isles: 0.03 * (run.cycle - 1) }, why: `cycle ${run.cycle}: the soil remembers older worlds` });
  return out;
}

/** The drift that moved the genome furthest (for the region-entry narration), or null. */
export function strongestDrift(ds: Drift[]): Drift | null {
  let best: Drift | null = null;
  let bm = 0;
  for (const d of ds) {
    const m = Object.values(d.m).reduce((a, v) => a + Math.abs(v ?? 0), 0);
    if (m > bm) {
      bm = m;
      best = d;
    }
  }
  return best;
}

/** The genome of a region on this run: birth genome plus every recorded drift. */
export function regionGenome(seed: number, stratum: StratumId, run?: Pick<RunState, 'remembrances' | 'history' | 'latent' | 'cycle' | 'tiers'>): Genome {
  let g = baseGenome(seed, stratum);
  if (run) for (const d of lineageDrifts(run)) g = mutate(g, d.m);
  return g;
}

export const neutralGenome = (): Genome => Object.fromEntries(GENE_KEYS.map((k) => [k, denorm(k, 0.5)])) as Genome;

// ------------------------------------------------------------------------------------------------ Julia constant

/**
 * Hyperbolic Julia constants: c inside the main cardioid or a p/q bulb of the Mandelbrot set, so the filled Julia set
 * has an interior (the lakes) and a fractal boundary (the rims). juliaA picks the bulb and the angle, juliaB how deep
 * inside it (deep: round lakes; near the edge: wild, spiralling shores).
 */
export function juliaConstant(g: Pick<Genome, 'juliaA' | 'juliaB'>): [number, number] {
  const a = ((g.juliaA % 1) + 1) % 1;
  const depth = 0.55 + 0.4 * (1 - g.juliaB); // fraction of the component's radius (never at the very edge)
  const fam = Math.floor(a * 5);
  const u = a * 5 - fam;
  if (fam === 0) {
    // main cardioid: c = μ/2 − μ²/4 with |μ| < 1 (μ = multiplier of the attracting fixed point)
    const th = u * Math.PI * 2;
    const mr = 0.25 + 0.72 * depth; // 0.65..0.93: near the boundary, where the coastline gets its bays and fingers
    const mx = mr * Math.cos(th);
    const my = mr * Math.sin(th);
    return [mx / 2 - (mx * mx - my * my) / 4, my / 2 - (2 * mx * my) / 4];
  }
  // p/q bulbs: period 2 (basilica), 3 (rabbit), 4 and 5; centred at the bulb's nucleus, offset by depth
  const BULBS: [number, number, number][] = [
    [-1, 0, 0.25],
    [-0.1225611668766536, 0.7448617666197442, 0.094],
    [0.2822713907669139, 0.5300606175785253, 0.043],
    [0.3795135880159236, 0.3349323055974974, 0.023],
  ];
  const [cx, cy, r] = BULBS[fam - 1];
  const th = u * Math.PI * 2;
  const k = (1 - depth) * r * 0.9;
  const sign = Math.floor(u * 997) % 2 ? 1 : -1; // conjugate bulb half the time
  return [cx + k * Math.cos(th), sign * (cy + k * Math.sin(th))];
}

// ------------------------------------------------------------------------------------------------ P2 bridge

/** GBNF grammar for a genome mutation proposal (P2 System Two). Keys are optional; values are signed steps ≤ 0.2. */
export function genomeGrammar(): string {
  const keys = GENE_KEYS.map((k) => `"\\"${k}\\""`).join(' | ');
  return [
    'root ::= "{" ws pair (ws "," ws pair)* ws "}"',
    `pair ::= key ws ":" ws step`,
    `key ::= ${keys}`,
    'step ::= "-"? "0." ("0" [0-9]? | "1" [0-9]? | "2" "0"?)',
    'ws ::= [ \\t\\n]*',
  ].join('\n');
}

/** Parse and clamp a proposed mutation (P2 model output or a test). Unknown keys dropped, steps clamped to ±0.2. */
export function parseMutation(json: string): Mutation {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const m: Mutation = {};
  for (const k of GENE_KEYS) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) m[k] = clamp(v, -0.2, 0.2);
  }
  return m;
}

/** Compact, stable text form for the Storycard ("warp 2.31 · ridge 1.02 · …"). */
export function describeGenome(g: Genome): string {
  return GENE_KEYS.map((k) => `${k} ${g[k].toFixed(2)}`).join(' · ');
}
