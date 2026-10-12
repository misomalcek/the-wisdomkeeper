import * as THREE from 'three';
import type { Terrain } from './terrain';
import { buildChunkArrays, CHUNK, NEUTRAL_STYLE, type ChunkArrays, type ChunkStyle } from './gen/chunkMesh';
import type { ShapeOpts } from './gen/shape';
import { flag } from '../engine/flags';
import type { HorizonArrays } from './gen/horizonMesh';

export { CHUNK };
/** Segments per chunk side for each level of detail. */
const LOD_SEG = [48, 24, 12];
/** Chebyshev ring → LOD level. Ring 5 reaches ~260 m, past where fog swallows the ground. */
const lodFor = (ring: number) => (ring <= 1 ? 0 : ring <= 3 ? 1 : 2);
export const VIEW_RINGS = 5;

interface Chunk {
  cx: number;
  cz: number;
  /** LOD currently drawn (-1: slot reserved, nothing drawn yet). */
  lod: number;
  slot: number;
}

const key = (cx: number, cz: number) => `${cx},${cz}`;

// ------------------------------------------------------------------------------------------------ worker pool

type ChunkMsg = { type: 'chunk'; id: number; ticket: number; cx: number; cz: number; lod: number; a: ChunkArrays };
export type HorizonMsg = { type: 'horizon'; id: number; ticket: number; x: number; z: number; h: HorizonArrays };

/**
 * Up to two module workers shared by every streamer (one region at a time). Each holds its own copy of the ground
 * shape; a new region re-initialises them with a new id so late chunks of the old region are dropped.
 */
export class ChunkPool {
  private static inst: ChunkPool | null | undefined;
  private workers: Worker[] = [];
  private inflight: number[] = [];
  onChunk: ((m: ChunkMsg) => void) | null = null;
  onHorizon: ((m: HorizonMsg) => void) | null = null;

  static get(): ChunkPool | null {
    if (ChunkPool.inst !== undefined) return ChunkPool.inst;
    ChunkPool.inst = null;
    if (typeof Worker === 'undefined' || typeof document === 'undefined') return null;
    try {
      const n = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
      const p = new ChunkPool();
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./chunks.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<ChunkMsg | HorizonMsg>) => {
          p.inflight[i] = Math.max(0, p.inflight[i] - 1);
          if (e.data.type === 'horizon') p.onHorizon?.(e.data);
          else p.onChunk?.(e.data);
        };
        p.workers.push(w);
        p.inflight.push(0);
      }
      ChunkPool.inst = p;
    } catch {
      ChunkPool.inst = null;
    }
    return ChunkPool.inst;
  }
  init(id: number, opts: ShapeOpts, style: ChunkStyle) {
    for (const w of this.workers) w.postMessage({ type: 'init', id, opts, style });
    this.inflight.fill(0);
  }
  /** Total requests not yet answered. */
  get busy() {
    return this.inflight.reduce((a, b) => a + b, 0);
  }
  get size() {
    return this.workers.length;
  }
  /** The far land around (x, z): goes to the least busy worker, answered through `onHorizon`. */
  requestHorizon(id: number, ticket: number, x: number, z: number) {
    let best = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.inflight[i] < this.inflight[best]) best = i;
    this.inflight[best]++;
    this.workers[best].postMessage({ type: 'horizon', id, ticket, x, z });
  }
  request(id: number, ticket: number, cx: number, cz: number, lod: number) {
    let best = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.inflight[i] < this.inflight[best]) best = i;
    this.inflight[best]++;
    this.workers[best].postMessage({ type: 'build', id, ticket, cx, cz, n: LOD_SEG[lod], lod });
  }
}

let nextShapeId = 1;

/**
 * Streams the ground as square chunks around the camera with three levels of detail.
 * Every chunk is a geometry inside one `BatchedMesh`, so the whole terrain is a single draw call
 * (WebGPU multi-draw / WEBGL_multi_draw) with per-chunk frustum culling. LOD seams are hidden by skirts.
 *
 * P1-E: chunk geometry is built by module workers (flag `workers`); the main thread uploads at most a few finished
 * chunks per frame. Without workers (tests, old browsers) it builds synchronously within the same per-frame budget.
 */
export class TerrainStreamer {
  readonly mesh: THREE.BatchedMesh;
  private chunks = new Map<string, Chunk>();
  private freeSlots: number[] = [];
  private slotGeo: number[] = [];
  private slotInst: number[] = [];
  private lastCx = 1e9;
  private lastCz = 1e9;
  private queue: { cx: number; cz: number; lod: number; d: number }[] = [];
  /** Requests sent to workers: chunk key → ticket and LOD. */
  private pending = new Map<string, { ticket: number; lod: number }>();
  private ready: ChunkMsg[] = [];
  private pool: ChunkPool | null;
  private shapeId = nextShapeId++;
  private ticket = 0;
  /** LOD0/LOD1 height grids of drawn chunks (physics heightfields reuse them). */
  private heights = new Map<string, { n: number; h: Float32Array }>();
  /** Chunks built so far (debug / tests). */
  built = 0;
  /** The far land out to the horizon (one mesh, rebuilt off-thread as the hero travels); null when off. */
  readonly horizon: THREE.Mesh | null = null;
  private hzAt: { x: number; z: number } | null = null;
  private hzTicket = 0;

  constructor(private terrain: Terrain, private style: ChunkStyle = NEUTRAL_STYLE) {
    const side = 2 * VIEW_RINGS + 1;
    const maxChunks = side * side + 8;
    const n = LOD_SEG[0];
    const maxV = (n + 1) * (n + 1) + 4 * (n + 1);
    const maxI = n * n * 6 + 4 * n * 12;
    this.mesh = new THREE.BatchedMesh(maxChunks, maxV * maxChunks, maxI * maxChunks, terrain.material);
    this.mesh.receiveShadow = true;
    this.mesh.perObjectFrustumCulled = true;
    this.mesh.sortObjects = false;
    this.reserveV = maxV;
    this.reserveI = maxI;
    this.pool = flag('workers') ? ChunkPool.get() : null;
    if (this.pool) {
      this.pool.init(this.shapeId, terrain.shapeOpts, style);
      this.pool.onChunk = (m) => {
        if (m.id === this.shapeId) this.ready.push(m);
      };
      if (terrain.wild && flag('horizon')) {
        this.horizon = new THREE.Mesh(new THREE.BufferGeometry(), terrain.horizonMaterial);
        this.horizon.frustumCulled = false;
        this.horizon.renderOrder = -1;
        this.horizon.visible = false; // until the first far mesh arrives
        this.pool.onHorizon = (m) => {
          if (m.id !== this.shapeId || m.ticket !== this.hzTicket || !this.horizon) return;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(m.h.pos, 3));
          g.setAttribute('normal', new THREE.BufferAttribute(m.h.nor, 3));
          g.setAttribute('aForm', new THREE.BufferAttribute(m.h.form, 4));
          g.setAttribute('aTint', new THREE.BufferAttribute(m.h.tint, 3));
          g.setAttribute('aMisc', new THREE.BufferAttribute(m.h.misc, 2));
          g.setIndex(new THREE.BufferAttribute(m.h.idx, 1));
          this.horizon.geometry.dispose();
          this.horizon.geometry = g;
          this.horizon.visible = true;
        };
      }
    }
  }

  /** Re-centre the far land when the hero has travelled far enough from where it was last built. */
  private updateHorizon(x: number, z: number, force = false) {
    if (!this.horizon || !this.pool) return;
    const h = this.hzAt;
    if (!force && h && Math.hypot(x - h.x, z - h.z) < 140) return;
    // quantised centres: the same spot always yields the same far mesh
    const qx = Math.round(x / 32) * 32;
    const qz = Math.round(z / 32) * 32;
    this.hzAt = { x: qx, z: qz };
    this.pool.requestHorizon(this.shapeId, ++this.hzTicket, qx, qz);
  }
  private reserveV: number;
  private reserveI: number;

  get count() {
    return this.chunks.size;
  }
  /** True when chunks are built off the main thread. */
  get threaded() {
    return !!this.pool;
  }

  /** Synchronously build everything around (x, z) — used on region entry and teleports. */
  prime(x: number, z: number) {
    this.lastCx = 1e9;
    this.pending.clear();
    this.ready.length = 0;
    this.update(x, z, 1e6, true);
  }

  update(x: number, z: number, budget = 2, sync = false) {
    this.updateHorizon(x, z, sync);
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;
      // drop chunks out of view
      for (const [k, c] of this.chunks) {
        if (Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) > VIEW_RINGS) {
          this.release(c);
          this.chunks.delete(k);
          this.pending.delete(k);
          this.heights.delete(k);
        }
      }
      // queue missing chunks and LOD changes, nearest first
      this.queue.length = 0;
      for (let j = -VIEW_RINGS; j <= VIEW_RINGS; j++) {
        for (let i = -VIEW_RINGS; i <= VIEW_RINGS; i++) {
          const ring = Math.max(Math.abs(i), Math.abs(j));
          const lod = lodFor(ring);
          const k = key(cx + i, cz + j);
          const c = this.chunks.get(k);
          const p = this.pending.get(k);
          if ((!c || c.lod !== lod) && !(p && p.lod === lod)) this.queue.push({ cx: cx + i, cz: cz + j, lod, d: i * i + j * j });
        }
      }
      this.queue.sort((a, b) => b.d - a.d);
    }
    if (this.pool && !sync) {
      // keep each worker a few requests deep: enough to stay busy, few enough that a turn re-prioritises quickly
      while (this.queue.length && this.pool.busy < this.pool.size * 3) {
        const q = this.queue.pop()!;
        const t = ++this.ticket;
        this.pending.set(key(q.cx, q.cz), { ticket: t, lod: q.lod });
        this.pool.request(this.shapeId, t, q.cx, q.cz, q.lod);
      }
      // upload finished chunks, nearest first is implied by request order; cap the uploads per frame
      let n = 0;
      while (this.ready.length && n < Math.max(4, budget)) {
        const m = this.ready.shift()!;
        const k = key(m.cx, m.cz);
        const p = this.pending.get(k);
        if (!p || p.ticket !== m.ticket) continue;
        this.pending.delete(k);
        if (Math.max(Math.abs(m.cx - cx), Math.abs(m.cz - cz)) > VIEW_RINGS) continue;
        this.apply(m.cx, m.cz, m.lod, m.a);
        n++;
      }
      return;
    }
    let n = 0;
    while (this.queue.length && n < budget) {
      const q = this.queue.pop()!;
      this.pending.delete(key(q.cx, q.cz));
      this.apply(q.cx, q.cz, q.lod, buildChunkArrays(this.terrain.shape, q.cx, q.cz, LOD_SEG[q.lod], this.style));
      n++;
    }
  }

  private release(c: Chunk) {
    this.mesh.setVisibleAt(this.slotInst[c.slot], false);
    this.freeSlots.push(c.slot);
  }

  private acquire(): number {
    const s = this.freeSlots.pop();
    if (s !== undefined) return s;
    const slot = this.slotGeo.length;
    const placeholder = new THREE.BufferGeometry();
    placeholder.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    placeholder.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
    placeholder.setAttribute('aRiver', new THREE.BufferAttribute(new Float32Array(3), 1));
    placeholder.setAttribute('aBlight', new THREE.BufferAttribute(new Float32Array(3), 1));
    placeholder.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(9).fill(1), 3));
    placeholder.setAttribute('aIsle', new THREE.BufferAttribute(new Float32Array(3).fill(60), 1));
    placeholder.setAttribute('aForm', new THREE.BufferAttribute(new Float32Array(12), 4));
    placeholder.setIndex([0, 1, 2]);
    const g = this.mesh.addGeometry(placeholder, this.reserveV, this.reserveI);
    this.slotGeo.push(g);
    this.slotInst.push(this.mesh.addInstance(g));
    return slot;
  }

  private apply(cx: number, cz: number, lod: number, a: ChunkArrays) {
    const k = key(cx, cz);
    let c = this.chunks.get(k);
    if (!c) {
      c = { cx, cz, lod, slot: this.acquire() };
      this.chunks.set(k, c);
    }
    c.lod = lod;
    const geo = toGeometry(a);
    this.mesh.setGeometryAt(this.slotGeo[c.slot], geo);
    this.mesh.setVisibleAt(this.slotInst[c.slot], true);
    geo.dispose();
    if (lod <= 1) this.heights.set(k, { n: LOD_SEG[lod], h: a.heights });
    else this.heights.delete(k);
    this.built++;
  }

  /**
   * Heights for a physics heightfield chunk of `size` metres at grid (i, j) with `res` cells, taken from a drawn
   * chunk's grid when its resolution allows (no extra field evaluations), else null.
   */
  physicsHeights(i: number, j: number, size: number, res: number): Float32Array | null {
    const x0 = i * size;
    const z0 = j * size;
    const cx = Math.floor(x0 / CHUNK);
    const cz = Math.floor(z0 / CHUNK);
    if (Math.floor((x0 + size - 1e-6) / CHUNK) !== cx || Math.floor((z0 + size - 1e-6) / CHUNK) !== cz) return null;
    const g = this.heights.get(key(cx, cz));
    if (!g) return null;
    const cell = CHUNK / g.n;
    const step = size / res;
    const s = step / cell;
    if (s < 1 || Math.abs(s - Math.round(s)) > 1e-6) return null;
    const oi = (x0 - cx * CHUNK) / cell;
    const oj = (z0 - cz * CHUNK) / cell;
    const out = new Float32Array((res + 1) * (res + 1));
    // Rapier stores heights column-major: rows run along z, columns along x
    for (let col = 0; col <= res; col++) {
      for (let row = 0; row <= res; row++) out[row + col * (res + 1)] = g.h[(oj + row * s) * (g.n + 1) + oi + col * s];
    }
    return out;
  }

  /**
   * Height of the drawn ground at (x, z), bilinear on a cached LOD0/LOD1 grid (what the player sees, no field
   * evaluation); falls back to the exact field where no grid is cached yet.
   */
  surfaceAt(x: number, z: number) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const g = this.heights.get(key(cx, cz));
    if (!g) return this.terrain.heightAt(x, z);
    const cell = CHUNK / g.n;
    const fx = (x - cx * CHUNK) / cell;
    const fz = (z - cz * CHUNK) / cell;
    const i = Math.min(g.n - 1, Math.floor(fx));
    const j = Math.min(g.n - 1, Math.floor(fz));
    const u = fx - i;
    const v = fz - j;
    const W = g.n + 1;
    const h = g.h;
    const a = h[j * W + i] + (h[j * W + i + 1] - h[j * W + i]) * u;
    const b = h[(j + 1) * W + i] + (h[(j + 1) * W + i + 1] - h[(j + 1) * W + i]) * u;
    return a + (b - a) * v;
  }

  /** Grid + skirt geometry (main-thread build; tests and tools). */
  geometry(cx: number, cz: number, n: number) {
    return toGeometry(buildChunkArrays(this.terrain.shape, cx, cz, n, this.style));
  }

  dispose() {
    this.mesh.dispose();
    this.horizon?.geometry.dispose();
    if (this.pool) {
      this.pool.onChunk = null;
      this.pool.onHorizon = null;
    }
  }
}

function toGeometry(a: ChunkArrays) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.nor, 3));
  g.setAttribute('aRiver', new THREE.BufferAttribute(a.riv, 1));
  g.setAttribute('aBlight', new THREE.BufferAttribute(a.bli, 1));
  g.setAttribute('aTint', new THREE.BufferAttribute(a.tint, 3));
  g.setAttribute('aIsle', new THREE.BufferAttribute(a.isle, 1));
  g.setAttribute('aForm', new THREE.BufferAttribute(a.form, 4));
  g.setIndex(new THREE.BufferAttribute(a.idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
