/**
 * A strain: how an edition's designer breeds one kind of Null (in the desktop edition, the Null Warden picks one
 * per region against how the hero plays). The web game never breeds strains itself; it owns the clamp, so no
 * strain can leave the game's balance: each trait has a range, and a strain that is both tougher and faster than
 * `MAX_THREAT` gives back toughness.
 */
export interface Strain {
  /** Body scale (and hit radius). */
  size?: number;
  /** Health multiplier. */
  vigor?: number;
  /** Speed multiplier. */
  haste?: number;
  /** Turn of the core's glow hue, in turns (a strain reads at a glance). */
  hue?: number;
}

export const STRAIN_LIMITS = {
  size: [0.85, 1.3],
  vigor: [0.8, 1.5],
  haste: [0.85, 1.25],
  hue: [-0.15, 0.15],
} as const satisfies Record<keyof Strain, readonly [number, number]>;

/** vigor × haste may not exceed this: a strain is tougher or faster, not both at the top of their ranges. */
export const MAX_THREAT = 1.45;

const fit = (v: unknown, [lo, hi]: readonly [number, number], neutral: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : neutral;

export function clampStrain(s: Strain): Required<Strain> {
  const haste = fit(s.haste, STRAIN_LIMITS.haste, 1);
  let vigor = fit(s.vigor, STRAIN_LIMITS.vigor, 1);
  if (vigor * haste > MAX_THREAT) vigor = Math.max(STRAIN_LIMITS.vigor[0], MAX_THREAT / haste);
  return { size: fit(s.size, STRAIN_LIMITS.size, 1), vigor, haste, hue: fit(s.hue, STRAIN_LIMITS.hue, 0) };
}
