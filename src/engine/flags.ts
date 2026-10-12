/**
 * Procedural P1 feature flags. Every P1 technique sits behind one key so it can be A/B'd on a fixed seed and switched
 * off alone if it misbehaves on a player's machine.
 *
 * Two kinds, on purpose:
 *  - **shape** flags change the land itself (height, rivers, lakes). They never depend on the quality tier, because the
 *    same seed must grow the same world on every machine; only the URL can turn them off, for A/B runs.
 *  - **look** flags change rendering or off-thread work only, so each tier picks its own default.
 *
 * URL: `?pf=-orbit,-erosion` turns keys off, `?pf=+living` on, `?pf=none` starts from everything off (the pre-P1
 * baseline) and `?pf=none,+workers` adds single keys back.
 */
export type Tier = 'low' | 'medium' | 'high' | 'ultra';

const SHAPE = {
  /** Slope-following gullies carved from the field's own gradient (analytic erosion look). */
  erosion: true,
  /** Mesa terraces on meadow plateaus. */
  terrace: true,
  /** Orbit Isles: Julia-set rims around lakes of light, laid on the Wilds. */
  orbit: true,
  /** World Genome: recorded choices evolve each region's land, colours, glyphs and living field. */
  genome: true,
} as const;

const LOOK: Record<string, Record<Tier, boolean>> = {
  /** Terrain chunks built in module workers (main thread only uploads). */
  workers: { low: true, medium: true, high: true, ultra: true },
  /** Biome tints generated and blended in OKLab. */
  oklab: { low: true, medium: true, high: true, ultra: true },
  /** Full-resolution Julia coastline drawn in light around Orbit Isle lakes (the "v" of f = u + v). */
  coast: { low: false, medium: true, high: true, ultra: true },
  /** Living corruption / purification fronts (excitable medium around the hero). */
  living: { low: true, medium: true, high: true, ultra: true },
  /** Glyph atlas regenerated per region from the genome's Julia constant. */
  glyphs: { low: true, medium: true, high: true, ultra: true },
  /** Vertex wind on Wilds flora. */
  wind: { low: false, medium: true, high: true, ultra: true },
};

export type ShapeFlag = keyof typeof SHAPE;
export type LookFlag = 'workers' | 'oklab' | 'coast' | 'living' | 'glyphs' | 'wind';
export type Flag = ShapeFlag | LookFlag;
export const ALL_FLAGS = [...Object.keys(SHAPE), ...Object.keys(LOOK)] as Flag[];

let overrides: Partial<Record<Flag, boolean>> = {};
let baseline = false;

/** Parse a `pf` value ("none,-orbit,+wind"). Unknown keys are ignored. */
export function parseFlags(spec: string | null) {
  overrides = {};
  baseline = false;
  if (!spec) return;
  for (const raw of spec.split(',')) {
    const s = raw.trim();
    if (s === 'none') baseline = true;
    else if (s === 'all') baseline = false;
    else {
      const on = !s.startsWith('-');
      const k = s.replace(/^[+-]/, '') as Flag;
      if ((ALL_FLAGS as string[]).includes(k)) overrides[k] = on;
    }
  }
}
parseFlags(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('pf'));

let tier: Tier = 'high';
/** The render tier picks look-flag defaults (set once the renderer knows its quality). */
export function setFlagTier(t: Tier) {
  tier = t;
}

export function flag(k: Flag): boolean {
  if (k in overrides) return overrides[k]!;
  if (baseline) return false;
  if (k in SHAPE) return SHAPE[k as ShapeFlag];
  return LOOK[k][tier];
}

/** Test hook: replace the URL spec. */
export function setFlags(spec: string | null) {
  parseFlags(spec);
}

/** Current state of every flag (perf overlay, bench reports). */
export function flagState(): Record<string, boolean> {
  return Object.fromEntries(ALL_FLAGS.map((k) => [k, flag(k)]));
}
