/**
 * Physarum transport network (Jones 2010, "Characteristics of pattern formation and evolution in approximations of
 * Physarum transport networks"): a slime mould approximated by many simple agents on a chemoattractant field.
 * Each agent senses the trail ahead, ahead-left and ahead-right (sensor angle SA, offset SO), turns toward the
 * strongest (rotation RA), steps one cell and deposits; the field diffuses (3×3 mean) and decays every step.
 * Food sources (landmarks, stations, pylons) keep depositing, so the mass condenses into a network of veins that
 * links them by short, redundant, fault-tolerant paths, the way the real organism rebuilt the Tokyo rail map
 * (Tero et al. 2010). Cliffs block it, Blight starves it, and a purification feeds it for a while, so the network
 * keeps reshaping itself as the world changes.
 *
 * The grid is a toroidal window of S × S cells that follows the hero (like the living field): cells that leave
 * the window are handed to cells that enter it. Pure TypeScript, allocation-free per step; run in a worker.
 */
import type { GroundShape, GroundSample } from './shape';
import { Biome } from './field';

export interface NetOpts {
  /** Cells per side. */
  size: number;
  /** Metres per cell. */
  cell: number;
  /** Agent count. */
  agents: number;
  seed: number;
}

export interface Food {
  x: number;
  z: number;
  /** Deposit per step (1 ≈ a landmark). */
  w: number;
  /** Seconds left (Infinity for permanent sources). */
  ttl: number;
}

/** Ground of a cell: 0 free, 1 blocked (cliff, lake); starve: extra decay (Blight). */
export type CellGround = { block: number; starve: number };

const SA = 0.6;
const RA = 0.55;
const SO = 7;
const DEP = 4;
const DECAY = 0.08;
/** Trail at which a vein reads ≈ 63 % bright: only the condensed veins saturate, not the diffuse haze. */
const VEIN_K = DEP * 10;
const UNSET = -0x7fffffff;

export class Physarum {
  readonly S: number;
  readonly cell: number;
  readonly trail: Float32Array;
  private tmp: Float32Array;
  /** 0 free, 1 blocked. */
  private block: Uint8Array;
  /** Per-step keep factor of the trail (1 − decay, lower on Blight). */
  private keep: Float32Array;
  private slotX: Int32Array;
  private slotZ: Int32Array;
  private ax: Float32Array;
  private az: Float32Array;
  private ah: Float32Array;
  private dist: Uint16Array;
  private queue: Int32Array;
  foods: Food[] = [];
  /** Window centre (cells). */
  cx = 0;
  cz = 0;
  private rnd: number;
  private gs: GroundSample = { h: 0, river: 0, blight: 0, biome: Biome.Meadow, core: 0, wild: 0, isleSd: 1e4, rock: 0, strata: 0, sand: 0, ero: 0 };
  private coarse = new Map<number, number>();

  constructor(
    readonly opts: NetOpts,
    private shape: GroundShape | null,
  ) {
    const S = (this.S = opts.size);
    this.cell = opts.cell;
    const n = S * S;
    this.trail = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.block = new Uint8Array(n);
    this.keep = new Float32Array(n).fill(1 - DECAY);
    this.slotX = new Int32Array(n).fill(UNSET);
    this.slotZ = new Int32Array(n).fill(UNSET);
    this.ax = new Float32Array(opts.agents);
    this.az = new Float32Array(opts.agents);
    this.ah = new Float32Array(opts.agents);
    this.dist = new Uint16Array(n);
    this.queue = new Int32Array(n);
    this.rnd = (opts.seed ^ 0x2545f491) >>> 0 || 1;
  }

  private rand() {
    // xorshift32
    let x = this.rnd;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rnd = x >>> 0;
    return this.rnd / 4294967296;
  }

  private slot(ix: number, iz: number) {
    const S = this.S;
    return (((iz % S) + S) % S) * S + (((ix % S) + S) % S);
  }

  /** True when world cell (ix, iz) is inside the current window. */
  private inside(ix: number, iz: number) {
    const h = this.S >> 1;
    return ix >= this.cx - h && ix < this.cx - h + this.S && iz >= this.cz - h && iz < this.cz - h + this.S;
  }

  /**
   * Keep the window around (x, z). It recentres in steps of an eighth of the window, so the cost of sampling the
   * ground for the cells that enter comes in occasional strips, not every frame. Returns true when it moved.
   */
  follow(x: number, z: number) {
    const S = this.S;
    const q = S >> 3;
    const fresh = this.slotX[0] === UNSET;
    const cx = Math.round(x / this.cell / q) * q;
    const cz = Math.round(z / this.cell / q) * q;
    if (!fresh && cx === this.cx && cz === this.cz) return false;
    const dx = cx - this.cx;
    const dz = cz - this.cz;
    this.cx = cx;
    this.cz = cz;
    const h = S >> 1;
    const x0 = cx - h;
    const z0 = cz - h;
    if (fresh || Math.abs(dx) >= S || Math.abs(dz) >= S) this.claim(x0, x0 + S, z0, z0 + S);
    else {
      if (dx > 0) this.claim(x0 + S - dx, x0 + S, z0, z0 + S);
      else if (dx < 0) this.claim(x0, x0 - dx, z0, z0 + S);
      if (dz > 0) this.claim(x0, x0 + S, z0 + S - dz, z0 + S);
      else if (dz < 0) this.claim(x0, x0 + S, z0, z0 - dz);
    }
    // agents left outside the window come back at a food source
    for (let a = 0; a < this.ax.length; a++) if (fresh || !this.inside(Math.floor(this.ax[a]), Math.floor(this.az[a]))) this.respawn(a);
    return true;
  }

  private claim(ix0: number, ix1: number, iz0: number, iz1: number) {
    for (let iz = iz0; iz < iz1; iz++) {
      for (let ix = ix0; ix < ix1; ix++) {
        const k = this.slot(ix, iz);
        if (this.slotX[k] === ix && this.slotZ[k] === iz) continue;
        this.slotX[k] = ix;
        this.slotZ[k] = iz;
        const g = this.groundAt(ix, iz);
        this.block[k] = g & 1;
        this.keep[k] = g & 2 ? 1 - DECAY * 3 : 1 - DECAY;
        this.trail[k] = 0;
      }
    }
  }

  /**
   * Ground of a cell, sampled on a 2-cell lattice and cached: bit 0 blocked (a cliff steeper than ~40°, a lake of
   * light), bit 1 starved (Blight). Without a shape (tests) everything is open ground.
   */
  private groundAt(ix: number, iz: number) {
    const sh = this.shape;
    if (!sh) return 0;
    const sx = ix >> 1;
    const sz = iz >> 1;
    const key = (sx + 0x8000) * 0x10000 + (sz + 0x8000);
    let g = this.coarse.get(key);
    if (g === undefined) {
      const c = this.cell * 2;
      const x = (sx + 0.5) * c;
      const z = (sz + 0.5) * c;
      const s = sh.sample(x, z, this.gs);
      const hx = sh.heightAt(x + c, z);
      const hz = sh.heightAt(x, z + c);
      const slope = Math.hypot(hx - s.h, hz - s.h) / c;
      g = (slope > 0.85 || s.isleSd < -4 ? 1 : 0) | (s.blight > 0.4 ? 2 : 0);
      if (this.coarse.size > 120000) this.coarse.clear();
      this.coarse.set(key, g);
    }
    return g;
  }

  private respawn(a: number) {
    const S = this.S;
    const h = S >> 1;
    for (let tries = 0; tries < 8; tries++) {
      let x: number;
      let z: number;
      const live = this.foods.length && this.rand() < 0.75;
      if (live) {
        const f = this.foods[Math.floor(this.rand() * this.foods.length)];
        const r = 2 + this.rand() * 10;
        const t = this.rand() * 6.2832;
        x = f.x / this.cell + Math.cos(t) * r;
        z = f.z / this.cell + Math.sin(t) * r;
      } else {
        x = this.cx - h + this.rand() * S;
        z = this.cz - h + this.rand() * S;
      }
      const ix = Math.floor(x);
      const iz = Math.floor(z);
      if (!this.inside(ix, iz) || this.block[this.slot(ix, iz)]) continue;
      this.ax[a] = x;
      this.az[a] = z;
      this.ah[a] = this.rand() * 6.2832;
      return;
    }
    this.ax[a] = this.cx + 0.5;
    this.az[a] = this.cz + 0.5;
    this.ah[a] = this.rand() * 6.2832;
  }

  /** Trail ahead of an agent at angle a (outside the window reads as nothing). */
  private sense(x: number, z: number, a: number) {
    const ix = Math.floor(x + Math.sin(a) * SO);
    const iz = Math.floor(z + Math.cos(a) * SO);
    if (!this.inside(ix, iz)) return -1;
    const k = this.slot(ix, iz);
    return this.block[k] ? -1 : this.trail[k];
  }

  /** Advance n steps; dt is the simulated time per step (s), which ages temporary food. */
  step(n: number, dt = 0.1) {
    const S = this.S;
    const N = this.ax.length;
    const tr = this.trail;
    for (let s = 0; s < n; s++) {
      // food: permanent sources and fading purifications
      for (let f = this.foods.length - 1; f >= 0; f--) {
        const fd = this.foods[f];
        fd.ttl -= dt;
        if (fd.ttl <= 0) {
          this.foods.splice(f, 1);
          continue;
        }
        const fx = Math.floor(fd.x / this.cell);
        const fz = Math.floor(fd.z / this.cell);
        const w = fd.w * DEP * 6 * Math.min(1, fd.ttl);
        for (let j = -2; j <= 2; j++) {
          for (let i = -2; i <= 2; i++) {
            if (i * i + j * j > 5 || !this.inside(fx + i, fz + j)) continue;
            tr[this.slot(fx + i, fz + j)] += w;
          }
        }
      }
      // agents: sense, rotate, move, deposit
      for (let a = 0; a < N; a++) {
        const x = this.ax[a];
        const z = this.az[a];
        let h = this.ah[a];
        const F = this.sense(x, z, h);
        const FL = this.sense(x, z, h - SA);
        const FR = this.sense(x, z, h + SA);
        if (F > FL && F > FR) {
          // keep going
        } else if (F < FL && F < FR) h += this.rand() < 0.5 ? -RA : RA;
        else if (FL < FR) h += RA;
        else if (FR < FL) h -= RA;
        const nx = x + Math.sin(h);
        const nz = z + Math.cos(h);
        const ix = Math.floor(nx);
        const iz = Math.floor(nz);
        if (!this.inside(ix, iz)) {
          this.respawn(a);
          continue;
        }
        const k = this.slot(ix, iz);
        if (this.block[k]) {
          this.ah[a] = this.rand() * 6.2832;
          continue;
        }
        this.ax[a] = nx;
        this.az[a] = nz;
        this.ah[a] = h;
        tr[k] += DEP;
      }
      // diffuse (separable 3-tap mean, toroidal) and decay
      const tmp = this.tmp;
      for (let r = 0; r < S; r++) {
        const o = r * S;
        let prev = tr[o + S - 1];
        let cur = tr[o];
        for (let c = 0; c < S; c++) {
          const next = tr[o + (c + 1 === S ? 0 : c + 1)];
          tmp[o + c] = prev + cur + next;
          prev = cur;
          cur = next;
        }
      }
      for (let c = 0; c < S; c++) {
        let prev = tmp[(S - 1) * S + c];
        let cur = tmp[c];
        for (let r = 0; r < S; r++) {
          const k = r * S + c;
          const next = tmp[(r + 1 === S ? 0 : r + 1) * S + c];
          tr[k] = this.block[k] ? 0 : ((prev + cur + next) / 9) * this.keep[k];
          prev = cur;
          cur = next;
        }
      }
    }
  }

  /** Feed the network at a point for a while (a purification, a purged pylon). */
  feed(x: number, z: number, w: number, ttl: number) {
    this.foods.push({ x, z, w, ttl });
  }

  /**
   * Pack the window for the ground shader: R = vein strength (soft-saturated trail), G = distance along the veins
   * from the nearest food source (multi-source BFS over vein cells, 1/4 cell per unit, wrapping at 256), so the
   * shader can send pulses of light outward from every landmark along the network.
   */
  write(rg: Uint8Array) {
    const S = this.S;
    const n = S * S;
    const tr = this.trail;
    const dist = this.dist;
    const q = this.queue;
    const K = VEIN_K;
    dist.fill(0xffff);
    let head = 0;
    let tail = 0;
    for (const f of this.foods) {
      const ix = Math.floor(f.x / this.cell);
      const iz = Math.floor(f.z / this.cell);
      if (!this.inside(ix, iz)) continue;
      const k = this.slot(ix, iz);
      if (dist[k] === 0) continue;
      dist[k] = 0;
      q[tail++] = k;
    }
    const thr = K * 0.3;
    while (head < tail) {
      const k = q[head++];
      const r = (k / S) | 0;
      const c = k - r * S;
      const d = dist[k] + 1;
      for (let m = 0; m < 4; m++) {
        const rr = m === 0 ? (r + 1) % S : m === 1 ? (r + S - 1) % S : r;
        const cc = m === 2 ? (c + 1) % S : m === 3 ? (c + S - 1) % S : c;
        const kk = rr * S + cc;
        if (dist[kk] <= d || tr[kk] < thr) continue;
        dist[kk] = d;
        q[tail++] = kk;
      }
    }
    for (let k = 0; k < n; k++) {
      rg[k * 2] = Math.min(255, (1 - Math.exp(-tr[k] / K)) * 255) | 0;
      rg[k * 2 + 1] = dist[k] === 0xffff ? 0 : (dist[k] * 4) & 255;
    }
  }

  /** Vein strength 0..1 at a world point (0 outside the window). */
  at(x: number, z: number) {
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    if (!this.inside(ix, iz)) return 0;
    return 1 - Math.exp(-this.trail[this.slot(ix, iz)] / VEIN_K);
  }
}
