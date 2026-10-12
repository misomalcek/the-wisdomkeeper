/**
 * The Wilds' site lattice: every 380 m cell may raise a fractal formation or an Atlas Station. Pure and
 * deterministic per world seed, so the main thread (which builds and places them) and the network worker (which
 * feeds the slime mould from them) agree on every site without talking.
 */
import type { GroundShape, GroundSample } from './shape';
import { Biome } from './field';

export const SITE_CELL = 380;

export interface Site {
  kind: 'formation' | 'station';
  i: number;
  j: number;
  x: number;
  z: number;
  /** formation: 0, 2 or 4 by landform (+ pick), station: 0..1 variant fraction. */
  form: number;
  /** 0..1 per-site randoms (size, rotation). */
  r1: number;
  r2: number;
}

export function siteHash(seed: number, i: number, j: number, k: number) {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

const _gs: GroundSample = { h: 0, river: 0, blight: 0, biome: Biome.Meadow, core: 0, wild: 0, isleSd: 1e4, rock: 0, strata: 0, sand: 0, ero: 0 };

/** The site of lattice cell (i, j), or null. `stations` turns Atlas Stations on. */
export function latticeSite(shape: GroundShape, seed: number, i: number, j: number, stations: boolean): Site | null {
  const H = (k: number) => siteHash(seed, i, j, k);
  const formation = H(1) <= 0.42;
  if (!formation && !(stations && H(8) < 0.6)) return null;
  const x = (i + 0.2 + 0.6 * H(2)) * SITE_CELL;
  const z = (j + 0.2 + 0.6 * H(3)) * SITE_CELL;
  if (Math.hypot(x, z) < shape.radius * 2.6 || shape.wildness(x, z) < 0.5 || shape.riverAt(x, z) > 0.05) return null;
  shape.sample(x, z, _gs);
  if (_gs.isleSd < 6) return null;
  if (formation) {
    // the land chooses the fractal: canyonlands raise Menger ruins, ranges Julia towers, open ground Mandelbulbs
    const kind = _gs.strata > 0.35 ? 2 : _gs.rock > 0.35 ? 4 : _gs.sand > 0.35 ? 0 : [0, 2, 4][Math.floor(H(5) * 3)];
    return { kind: 'formation', i, j, x, z, form: kind + (H(4) < 0.5 ? 0 : 1), r1: H(6), r2: H(7) };
  }
  // stations want open, gentle ground, not a range or a dune sea: of a few spots in the cell, the flattest
  if (_gs.rock > 0.5 || _gs.sand > 0.6) return null;
  let bx = x;
  let bz = z;
  let bs = shape.slopeAt(x, z);
  for (let k = 0; k < 4 && bs > 0.12; k++) {
    const px = (i + 0.15 + 0.7 * H(20 + k)) * SITE_CELL;
    const pz = (j + 0.15 + 0.7 * H(30 + k)) * SITE_CELL;
    if (shape.riverAt(px, pz) > 0.05 || Math.hypot(px, pz) < shape.radius * 2.6) continue;
    const sl = shape.slopeAt(px, pz);
    if (sl < bs) {
      bs = sl;
      bx = px;
      bz = pz;
    }
  }
  if (bs > 0.32) return null;
  return { kind: 'station', i, j, x: bx, z: bz, form: H(9), r1: H(10), r2: H(11) };
}
