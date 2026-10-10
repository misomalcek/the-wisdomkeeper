import * as THREE from 'three';
import type { Terrain } from './terrain';

export const CHUNK = 48;
/** Segments per chunk side for each level of detail. */
const LOD_SEG = [48, 24, 12];
/** Chebyshev ring → LOD level. Ring 5 reaches ~260 m, past where fog swallows the ground. */
const lodFor = (ring: number) => (ring <= 1 ? 0 : ring <= 3 ? 1 : 2);
export const VIEW_RINGS = 5;
const SKIRT = 9;

interface Chunk {
  cx: number;
  cz: number;
  lod: number;
  slot: number;
}

const key = (cx: number, cz: number) => `${cx},${cz}`;

/**
 * Streams the ground as square chunks around the camera with three levels of detail.
 * Every chunk is a geometry inside one `BatchedMesh`, so the whole terrain is a single draw call
 * (WebGPU multi-draw / WEBGL_multi_draw) with per-chunk frustum culling. LOD seams are hidden by skirts.
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
  /** Chunks built so far (debug / tests). */
  built = 0;

  constructor(private terrain: Terrain) {
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
  }
  private reserveV: number;
  private reserveI: number;

  get count() {
    return this.chunks.size;
  }

  /** Synchronously build everything around (x, z) — used on region entry and teleports. */
  prime(x: number, z: number) {
    this.lastCx = 1e9;
    this.update(x, z, 1e6);
  }

  update(x: number, z: number, budget = 2) {
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
        }
      }
      // queue missing chunks and LOD changes, nearest first
      this.queue.length = 0;
      for (let j = -VIEW_RINGS; j <= VIEW_RINGS; j++) {
        for (let i = -VIEW_RINGS; i <= VIEW_RINGS; i++) {
          const ring = Math.max(Math.abs(i), Math.abs(j));
          const lod = lodFor(ring);
          const c = this.chunks.get(key(cx + i, cz + j));
          if (!c || c.lod !== lod) this.queue.push({ cx: cx + i, cz: cz + j, lod, d: i * i + j * j });
        }
      }
      this.queue.sort((a, b) => b.d - a.d);
    }
    let n = 0;
    while (this.queue.length && n < budget) {
      const q = this.queue.pop()!;
      this.build(q.cx, q.cz, q.lod);
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
    placeholder.setIndex([0, 1, 2]);
    const g = this.mesh.addGeometry(placeholder, this.reserveV, this.reserveI);
    this.slotGeo.push(g);
    this.slotInst.push(this.mesh.addInstance(g));
    return slot;
  }

  private build(cx: number, cz: number, lod: number) {
    const k = key(cx, cz);
    let c = this.chunks.get(k);
    if (!c) {
      c = { cx, cz, lod, slot: this.acquire() };
      this.chunks.set(k, c);
    }
    c.lod = lod;
    const geo = this.geometry(cx, cz, LOD_SEG[lod]);
    this.mesh.setGeometryAt(this.slotGeo[c.slot], geo);
    this.mesh.setVisibleAt(this.slotInst[c.slot], true);
    geo.dispose();
    this.built++;
  }

  /** Grid + skirt geometry with analytic normals (central differences on a 1-cell apron, so seams match). */
  geometry(cx: number, cz: number, n: number) {
    const t = this.terrain;
    const step = CHUNK / n;
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const W = n + 3; // heights with a 1-sample apron on every side
    const H = new Float32Array(W * W);
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) H[j * W + i] = t.heightAt(x0 + (i - 1) * step, z0 + (j - 1) * step);
    }
    const vGrid = (n + 1) * (n + 1);
    const vCount = vGrid + 4 * (n + 1);
    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);
    const riv = new Float32Array(vCount);
    const bli = new Float32Array(vCount);
    const _n = new THREE.Vector3();
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const v = j * (n + 1) + i;
        const x = x0 + i * step;
        const z = z0 + j * step;
        const h = H[(j + 1) * W + i + 1];
        pos[v * 3] = x;
        pos[v * 3 + 1] = h;
        pos[v * 3 + 2] = z;
        const dx = H[(j + 1) * W + i + 2] - H[(j + 1) * W + i];
        const dz = H[(j + 2) * W + i + 1] - H[j * W + i + 1];
        _n.set(-dx, 2 * step, -dz).normalize();
        nor[v * 3] = _n.x;
        nor[v * 3 + 1] = _n.y;
        nor[v * 3 + 2] = _n.z;
        riv[v] = t.riverAt(x, z);
        bli[v] = t.blightAt(x, z);
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
        nor[v * 3] = nor[src * 3];
        nor[v * 3 + 1] = nor[src * 3 + 1];
        nor[v * 3 + 2] = nor[src * 3 + 2];
        riv[v] = riv[src];
        bli[v] = bli[src];
        v++;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
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
        idx.push(a, b, c, b, d, c, a, c, b, b, c, d);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aRiver', new THREE.BufferAttribute(riv, 1));
    g.setAttribute('aBlight', new THREE.BufferAttribute(bli, 1));
    g.setIndex(idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  dispose() {
    this.mesh.dispose();
  }
}
