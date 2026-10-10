import { GOLDEN_ANGLE } from '../../util/math';

/**
 * Vogel's model of the sunflower head: floret n sits at radius c·√n and angle n·137.508°.
 * The golden divergence angle packs florets with no gaps or spokes — the arrangement plants
 * converge on for seeds, scales, florets and (here) whole mushroom rings.
 */
export function vogel(n: number, c: number, offset = 0) {
  const r = c * Math.sqrt(n + 0.5);
  const a = (n + offset) * GOLDEN_ANGLE;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, r, a };
}
