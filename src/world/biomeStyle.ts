/**
 * Colour of a region's biomes, derived from its World Genome in OKLCH (perceptually even hue and chroma), so two seeds
 * never share a palette yet every palette stays readable. Produces the per-biome albedo multipliers the chunk builder
 * blends in OKLab, and the Null's emission colour.
 */
import { oklch, type RGB } from '../engine/color';
import { NEUTRAL_STYLE, type ChunkStyle } from './gen/chunkMesh';
import type { Genome } from './genome';

/** A luminance-neutral tint: OKLCH hue/chroma at a fixed lightness, rescaled so it multiplies albedo without dimming it. */
function tint(C: number, h: number): RGB {
  const c = oklch(0.8, C, h);
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / lum, c[1] / lum, c[2] / lum];
}

/** Per-biome albedo tints (Meadow, Forest, Crystal, Blight). */
export function biomeStyle(g: Genome, on: boolean): ChunkStyle {
  if (!on) return NEUTRAL_STYLE;
  const k = g.chroma;
  const tints = [
    ...tint(0.07 * k, g.vegHue + 20), // meadow: warmer green
    ...tint(0.08 * k, g.vegHue - 10), // forest: deep teal
    ...tint(0.06 * k, 285 + (g.vegHue - 182) * 0.6), // crystal: violet, leaning with the region
    ...tint(0.05 * k, g.nullHue), // blight: stained toward the Null's hue
  ];
  return { tints };
}

/** The Null's glow colour for this region (linear RGB). */
export const nullColour = (g: Genome): RGB => oklch(0.64, 0.25 * g.chroma, g.nullHue % 360);
