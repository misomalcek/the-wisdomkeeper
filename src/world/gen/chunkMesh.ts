/**
 * Terrain chunk geometry as plain typed arrays (no three.js), so the same code runs on the main thread and inside the
 * chunk module workers. Grid + skirts, normals by central differences on a 1-sample apron (seams match between
 * neighbours), and per-vertex attributes: river/lake, blight, an OKLab-blended biome tint and the Orbit Isle distance.
 */
import type { GroundShape, GroundSample } from './shape';
import { Biome } from './field';
import { linearToOklab, oklabToLinear, type RGB } from '../../engine/color';

export const CHUNK = 48;
const SKIRT = 9;

/** Per-biome albedo multipliers in linear RGB, generated on the main thread from the genome and region palette. */
export interface ChunkStyle {
  /** 4 biomes × 3 (Meadow, Forest, Crystal, Blight). All 1 = no tint. */
  tints: number[];
}
export const NEUTRAL_STYLE: ChunkStyle = { tints: new Array(12).fill(1) };

export interface ChunkArrays {
  pos: Float32Array;
  nor: Float32Array;
  riv: Float32Array;
  bli: Float32Array;
  tint: Float32Array;
  isle: Float32Array;
  /** Landform shading cues per vertex: rock, strata, sand, erosion (see WildSample). */
  form: Float32Array;
  idx: Uint16Array;
  /** Height grid (n+1)² of the chunk itself (row-major, z rows), reused for physics heightfields. */
  heights: Float32Array;
}

const _s: GroundSample = { h: 0, river: 0, blight: 0, biome: Biome.Meadow, core: 0, wild: 0, isleSd: 1e4, rock: 0, strata: 0, sand: 0, ero: 0 };
const _lab: RGB = [0, 0, 0];
const _rgb: RGB = [0, 0, 0];

/** Biome tint in OKLab: from neutral (1,1,1) toward the biome's tint by how deep into the cell and the Wilds. */
export function tintAt(style: ChunkStyle, biome: Biome, k: number, out: Float32Array, o: number) {
  const t = style.tints;
  if (k <= 0.001) {
    out[o] = out[o + 1] = out[o + 2] = 1;
    return;
  }
  linearToOklab(t[biome * 3], t[biome * 3 + 1], t[biome * 3 + 2], _lab);
  // white in OKLab is (1, 0, 0)
  oklabToLinear(1 + (_lab[0] - 1) * k, _lab[1] * k, _lab[2] * k, _rgb);
  out[o] = _rgb[0];
  out[o + 1] = _rgb[1];
  out[o + 2] = _rgb[2];
}

export function buildChunkArrays(shape: GroundShape, cx: number, cz: number, n: number, style: ChunkStyle = NEUTRAL_STYLE): ChunkArrays {
  const step = CHUNK / n;
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const W = n + 3; // heights with a 1-sample apron on every side
  const H = new Float32Array(W * W);
  const vGrid = (n + 1) * (n + 1);
  const vCount = vGrid + 4 * (n + 1);
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const riv = new Float32Array(vCount);
  const bli = new Float32Array(vCount);
  const tint = new Float32Array(vCount * 3);
  const isle = new Float32Array(vCount);
  const form = new Float32Array(vCount * 4);
  const heights = new Float32Array(vGrid);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const x = x0 + (i - 1) * step;
      const z = z0 + (j - 1) * step;
      const inner = i >= 1 && j >= 1 && i <= n + 1 && j <= n + 1;
      if (!inner) {
        H[j * W + i] = shape.heightAt(x, z);
        continue;
      }
      // grid vertices: one full sample gives height and every attribute
      const s = shape.sample(x, z, _s);
      H[j * W + i] = s.h;
      const v = (j - 1) * (n + 1) + (i - 1);
      heights[v] = s.h;
      riv[v] = s.river;
      bli[v] = s.blight;
      isle[v] = Math.max(-60, Math.min(60, s.isleSd));
      form[v * 4] = s.rock;
      form[v * 4 + 1] = s.strata;
      form[v * 4 + 2] = s.sand;
      form[v * 4 + 3] = s.ero;
      tintAt(style, s.biome, s.core * s.wild, tint, v * 3);
    }
  }
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = j * (n + 1) + i;
      pos[v * 3] = x0 + i * step;
      pos[v * 3 + 1] = H[(j + 1) * W + i + 1];
      pos[v * 3 + 2] = z0 + j * step;
      const dx = H[(j + 1) * W + i + 2] - H[(j + 1) * W + i];
      const dz = H[(j + 2) * W + i + 1] - H[j * W + i + 1];
      const ny = 2 * step;
      const l = Math.hypot(dx, ny, dz);
      nor[v * 3] = -dx / l;
      nor[v * 3 + 1] = ny / l;
      nor[v * 3 + 2] = -dz / l;
    }
  }
  // skirts: duplicate each edge row, dropped below the surface
  const edges: number[][] = [[], [], [], []];
  for (let i = 0; i <= n; i++) {
    edges[0].push(i); // z0 edge
    edges[1].push(n * (n + 1) + i); // z1 edge
    edges[2].push(i * (n + 1)); // x0 edge
    edges[3].push(i * (n + 1) + n); // x1 edge
  }
  let v = vGrid;
  const skirtStart: number[] = [];
  for (const e of edges) {
    skirtStart.push(v);
    for (const src of e) {
      pos[v * 3] = pos[src * 3];
      pos[v * 3 + 1] = pos[src * 3 + 1] - SKIRT;
      pos[v * 3 + 2] = pos[src * 3 + 2];
      for (let c = 0; c < 3; c++) {
        nor[v * 3 + c] = nor[src * 3 + c];
        tint[v * 3 + c] = tint[src * 3 + c];
      }
      riv[v] = riv[src];
      bli[v] = bli[src];
      isle[v] = isle[src];
      for (let c = 0; c < 4; c++) form[v * 4 + c] = form[src * 4 + c];
      v++;
    }
  }
  const idx = new Uint16Array(n * n * 6 + 4 * n * 12);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  // skirt quads, emitted with both windings so they hide cracks from either side
  edges.forEach((e, ei) => {
    const s = skirtStart[ei];
    for (let i = 0; i < n; i++) {
      const a = e[i];
      const b = e[i + 1];
      const c = s + i;
      const d = s + i + 1;
      for (const q of [a, b, c, b, d, c, a, c, b, b, c, d]) idx[k++] = q;
    }
  });
  return { pos, nor, riv, bli, tint, isle, form, idx, heights };
}

/** Buffers to transfer (zero-copy) when a worker posts a chunk back. */
export const chunkTransfer = (a: ChunkArrays): ArrayBuffer[] => [a.pos, a.nor, a.riv, a.bli, a.tint, a.isle, a.form, a.idx, a.heights].map((t) => t.buffer as ArrayBuffer);
