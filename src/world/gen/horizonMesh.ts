/**
 * The far land: one polar grid around the hero from just inside the streamed chunks out to the horizon, with ring
 * radii in geometric progression (≈ 14 m apart near the chunks, ≈ 200 m at 4.5 km), sampled from the same ground shape.
 * Pure arrays, built in a chunk worker. Vertices near the inner edge sink a little so the detailed chunks always win.
 */
import type { GroundShape, GroundSample } from './shape';
import { Biome } from './field';
import { tintAt, NEUTRAL_STYLE, type ChunkStyle } from './chunkMesh';

export const HORIZON_RINGS = 64;
export const HORIZON_SEGS = 168;
export const HORIZON_R0 = 225;
export const HORIZON_R1 = 4600;

export interface HorizonArrays {
  pos: Float32Array;
  nor: Float32Array;
  /** rock, strata, sand, erosion (as in chunk meshes). */
  form: Float32Array;
  /** OKLab biome tint (as in chunk meshes). */
  tint: Float32Array;
  /** river/lake, blight. */
  misc: Float32Array;
  idx: Uint16Array;
}

const _s: GroundSample = { h: 0, river: 0, blight: 0, biome: Biome.Meadow, core: 0, wild: 0, isleSd: 1e4, rock: 0, strata: 0, sand: 0, ero: 0 };

export function buildHorizon(shape: GroundShape, cx: number, cz: number, style: ChunkStyle = NEUTRAL_STYLE): HorizonArrays {
  const R = HORIZON_RINGS;
  const S = HORIZON_SEGS;
  const n = R * S;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const form = new Float32Array(n * 4);
  const tint = new Float32Array(n * 3);
  const misc = new Float32Array(n * 2);
  const q = Math.pow(HORIZON_R1 / HORIZON_R0, 1 / (R - 1));
  for (let k = 0; k < R; k++) {
    const r = HORIZON_R0 * Math.pow(q, k);
    const step = r * (q - 1);
    // sink the inner rings under the streamed chunks (whose square reaches ~265 m, its corners ~375 m)
    const sink = 7 * (1 - Math.min(1, Math.max(0, (r - HORIZON_R0) / 170)));
    for (let s = 0; s < S; s++) {
      const a = ((s + (k & 1) * 0.5) / S) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const v = k * S + s;
      shape.sample(x, z, _s);
      pos[v * 3] = x;
      pos[v * 3 + 1] = _s.h - sink;
      pos[v * 3 + 2] = z;
      form[v * 4] = _s.rock;
      form[v * 4 + 1] = _s.strata;
      form[v * 4 + 2] = _s.sand;
      form[v * 4 + 3] = _s.ero;
      misc[v * 2] = _s.river;
      misc[v * 2 + 1] = _s.blight;
      tintAt(style, _s.biome, _s.core * _s.wild, tint, v * 3);
      // normal from central differences at about half the local spacing
      const e = Math.max(2, step * 0.5);
      const dx = shape.heightAt(x + e, z) - shape.heightAt(x - e, z);
      const dz = shape.heightAt(x, z + e) - shape.heightAt(x, z - e);
      const l = Math.hypot(dx, 2 * e, dz);
      nor[v * 3] = -dx / l;
      nor[v * 3 + 1] = (2 * e) / l;
      nor[v * 3 + 2] = -dz / l;
    }
  }
  const idx = new Uint16Array((R - 1) * S * 6);
  let t = 0;
  for (let k = 0; k < R - 1; k++) {
    for (let s = 0; s < S; s++) {
      const a = k * S + s;
      const b = k * S + ((s + 1) % S);
      const c = (k + 1) * S + s;
      const d = (k + 1) * S + ((s + 1) % S);
      // odd rings are rotated half a segment: alternate the diagonal so triangles stay fat
      if (k & 1) {
        idx[t++] = a; idx[t++] = b; idx[t++] = d;
        idx[t++] = a; idx[t++] = d; idx[t++] = c;
      } else {
        idx[t++] = a; idx[t++] = b; idx[t++] = c;
        idx[t++] = b; idx[t++] = d; idx[t++] = c;
      }
    }
  }
  return { pos, nor, form, tint, misc, idx };
}

export const horizonTransfer = (h: HorizonArrays): ArrayBuffer[] => [h.pos, h.nor, h.form, h.tint, h.misc, h.idx].map((a) => a.buffer as ArrayBuffer);
