/**
 * The living field: Null corruption fronts and purification waves on the ground around the hero, simulated on a
 * small toroidal grid that follows the hero (the P1 twin of the P2 morphogenesis track).
 *
 *  - Corruption C (Fisher-KPP): ∂C/∂t = D∇²C + r·C(1−C)(s₀ + S) − d·C(1 − S)
 *    S is the support: Blight ground and live Null camps. Fronts creep out of the Blight at ≈ 2√(rD) and fall back
 *    where nothing feeds them. r and D scale with the genome's `excite`.
 *  - Purification (stochastic Greenberg-Hastings excitable medium): resting → excited → refractory (R ticks) →
 *    resting. A resting cell fires with a probability that grows with its excited neighbours (orthogonal p_o,
 *    diagonal p_d), so fronts grow round and organic rather than as grid squares.
 *    A purification (a kill, a purge, Surge) excites a disk; it expands as a ring of light, annihilates where two
 *    rings meet and burns corruption as it passes. Corruption lowers the firing odds, so rings fray and break on it and curl into
 *    spirals: emergent patterns nobody authored. The genome's `mercy` raises the odds.
 *    (A continuous Barkley medium was tried first: at 1.5-3 m cells its fronts are thinner than a cell and pin to the
 *    grid; the discrete medium propagates robustly at any resolution and costs 8 reads per cell per tick.)
 *
 * Pure TypeScript, allocation-free per step. Ephemeral (never saved), visual plus small resonance nudges.
 */
export interface LivingOpts {
  /** Cells per side (power of two not required). */
  size: number;
  /** Metres per cell. */
  cell: number;
  excite: number;
  mercy: number;
}

/** Corruption support of a world point (0..1): Blight ground. */
export type SupportFn = (x: number, z: number) => number;

/** Purification ticks per second, refractory length and corruption steps per tick. */
const TICK = 4;
const REFRACT = 6;
export class LivingField {
  readonly S: number;
  readonly cell: number;
  /** Corruption 0..1. */
  readonly C: Float32Array;
  /** Purification state: 0 resting, 1 excited, 2..REFRACT refractory. */
  readonly G: Uint8Array;
  private G2: Uint8Array;
  /** Static support from the ground (Blight) and dynamic support from Null camps. */
  private ground: Float32Array;
  private camp: Float32Array;
  private tmpC: Float32Array;
  /** World cell held by each slot. */
  private slotX: Int32Array;
  private slotZ: Int32Array;
  private acc = 0;
  private campT = 0;
  /** Base firing probability per excited orthogonal neighbour (mercy raises it). */
  private T0: number;
  private r: number;
  private Dc: number;
  private rnd = 0x9e3779b9;
  /** Live corruption sources (x, z, radius, strength), e.g. Null camps. */
  sources: { x: number; z: number; r: number; s: number }[] = [];
  /** Window centre in cells. */
  private cx = 0;
  private cz = 0;

  constructor(readonly opts: LivingOpts, private support: SupportFn) {
    const S = (this.S = opts.size);
    this.cell = opts.cell;
    const n = S * S;
    this.C = new Float32Array(n);
    this.G = new Uint8Array(n);
    this.G2 = new Uint8Array(n);
    this.ground = new Float32Array(n);
    this.camp = new Float32Array(n);
    this.tmpC = new Float32Array(n);
    this.slotX = new Int32Array(n).fill(-0x7fffffff);
    this.slotZ = new Int32Array(n).fill(-0x7fffffff);
    this.T0 = 0.92 + 0.15 * (opts.mercy - 1);
    this.r = 0.45 * opts.excite;
    // 2.2 m²/s of spread at excite 1 (front ≈ 2 m/s), in cells²/s
    this.Dc = (2.2 * opts.excite) / (opts.cell * opts.cell);
  }

  private slot(ix: number, iz: number) {
    const S = this.S;
    return (((iz % S) + S) % S) * S + (((ix % S) + S) % S);
  }

  /** Keep the window centred on (x, z): slots whose world cell left the window take the cells that entered. */
  follow(x: number, z: number) {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const fresh = this.slotX[0] === -0x7fffffff;
    if (cx === this.cx && cz === this.cz && !fresh) return;
    const S = this.S;
    const h = S >> 1;
    const dx = cx - this.cx;
    const dz = cz - this.cz;
    this.cx = cx;
    this.cz = cz;
    const x0 = cx - h;
    const z0 = cz - h;
    if (fresh || Math.abs(dx) >= S || Math.abs(dz) >= S) {
      this.claim(x0, x0 + S, z0, z0 + S);
      return;
    }
    // only the columns and rows that entered the window change hands
    if (dx > 0) this.claim(x0 + S - dx, x0 + S, z0, z0 + S);
    else if (dx < 0) this.claim(x0, x0 - dx, z0, z0 + S);
    if (dz > 0) this.claim(x0, x0 + S, z0 + S - dz, z0 + S);
    else if (dz < 0) this.claim(x0, x0 + S, z0, z0 - dz);
  }

  /** Give the slots of world cells [ix0, ix1) × [iz0, iz1) to those cells (skipping slots that already hold them). */
  private claim(ix0: number, ix1: number, iz0: number, iz1: number) {
    for (let iz = iz0; iz < iz1; iz++) {
      for (let ix = ix0; ix < ix1; ix++) {
        const k = this.slot(ix, iz);
        if (this.slotX[k] === ix && this.slotZ[k] === iz) continue;
        this.slotX[k] = ix;
        this.slotZ[k] = iz;
        const g = this.supportAt(ix, iz);
        this.ground[k] = g;
        this.C[k] = g * 0.85;
        this.G[k] = 0;
        this.camp[k] = 0;
      }
    }
  }

  /**
   * Ground support of a cell, sampled on a 2-cell lattice and cached: Blight varies over tens of metres, and the
   * support function walks the whole ground field (several µs), so a window row costs a quarter of the samples.
   */
  private supportAt(ix: number, iz: number) {
    const sx = ix >> 1;
    const sz = iz >> 1;
    const key = (sx + 0x8000) * 0x10000 + (sz + 0x8000);
    let g = this.coarse.get(key);
    if (g === undefined) {
      g = Math.min(1, this.support((sx * 2 + 1) * this.cell, (sz * 2 + 1) * this.cell) * 1.3);
      if (this.coarse.size > 40000) this.coarse.clear();
      this.coarse.set(key, g);
    }
    return g;
  }
  private coarse = new Map<number, number>();

  /** A purification event: stimulates a disk that grows into a travelling ring. */
  pulse(x: number, z: number, radius: number) {
    const rc = Math.max(1, Math.round(radius / this.cell));
    const ix0 = Math.floor(x / this.cell);
    const iz0 = Math.floor(z / this.cell);
    const h = this.S >> 1;
    for (let j = -rc; j <= rc; j++) {
      for (let i = -rc; i <= rc; i++) {
        if (i * i + j * j > rc * rc) continue;
        const ix = ix0 + i;
        const iz = iz0 + j;
        if (Math.abs(ix - this.cx) >= h || Math.abs(iz - this.cz) >= h) continue;
        const k = this.slot(ix, iz);
        if (this.G[k] === 0) this.G[k] = 1; // refractory cells ignore new stimuli
      }
    }
  }

  private updateCamps() {
    this.camp.fill(0);
    const S = this.S;
    const h = S >> 1;
    for (const s of this.sources) {
      if (s.s <= 0) continue;
      const rc = Math.ceil((s.r * 1.6) / this.cell);
      const ix0 = Math.floor(s.x / this.cell);
      const iz0 = Math.floor(s.z / this.cell);
      for (let j = -rc; j <= rc; j++) {
        for (let i = -rc; i <= rc; i++) {
          const ix = ix0 + i;
          const iz = iz0 + j;
          if (Math.abs(ix - this.cx) >= h || Math.abs(iz - this.cz) >= h) continue;
          const d = (Math.hypot(i, j) * this.cell) / (s.r * 1.6);
          if (d >= 1) continue;
          const k = this.slot(ix, iz);
          this.camp[k] = Math.max(this.camp[k], s.s * (1 - d * d));
        }
      }
    }
  }

  /** Advance by dt seconds (fixed ticks; at most `maxSteps` per call to bound the frame cost). */
  update(dt: number, maxSteps = 2) {
    this.campT -= dt;
    if (this.campT <= 0) {
      this.campT = 0.5;
      this.updateCamps();
    }
    this.acc = Math.min(this.acc + dt * TICK, maxSteps);
    let n = 0;
    while (this.acc >= 1 && n < maxSteps) {
      this.step();
      this.acc -= 1;
      n++;
    }
    return n;
  }

  /** One tick: purification medium (discrete) and corruption (explicit Euler, 5-point Laplacian on the torus). */
  step() {
    const S = this.S;
    const { C, G, G2, tmpC, ground, camp } = this;
    const dtc = 1 / TICK;
    const r = this.r;
    const Dc = this.Dc;
    const T0 = this.T0;
    for (let j = 0; j < S; j++) {
      const jm = ((j + S - 1) % S) * S;
      const jp = ((j + 1) % S) * S;
      const jr = j * S;
      for (let i = 0; i < S; i++) {
        const im = (i + S - 1) % S;
        const ip = (i + 1) % S;
        const k = jr + i;
        const c = C[k];
        const g = G[k];
        let burn = 0;
        if (g === 0) {
          const no = (G[jr + im] === 1 ? 1 : 0) + (G[jr + ip] === 1 ? 1 : 0) + (G[jm + i] === 1 ? 1 : 0) + (G[jp + i] === 1 ? 1 : 0);
          const nd = (G[jm + im] === 1 ? 1 : 0) + (G[jm + ip] === 1 ? 1 : 0) + (G[jp + im] === 1 ? 1 : 0) + (G[jp + ip] === 1 ? 1 : 0);
          if (no + nd > 0) {
            // stochastic excitation: each excited orthogonal neighbour fires us with p_o, each diagonal with p_d.
            // Fronts grow round and organic (no grid squares); corruption lowers both, so rings fray and break on it
            const q = 1 - 0.9 * c * c;
            const po = Math.min(0.97, T0 * q);
            const pd = 0.45 * T0 * q;
            const p = 1 - (1 - po) ** no * (1 - pd) ** nd;
            this.rnd = (Math.imul(this.rnd, 1664525) + 1013904223) >>> 0;
            G2[k] = this.rnd / 4294967296 < p ? 1 : 0;
          } else G2[k] = 0;
        } else {
          G2[k] = g >= REFRACT ? 0 : g + 1;
          if (g === 1) burn = 0.55;
        }
        const lapC = C[jr + im] + C[jr + ip] + C[jm + i] + C[jp + i] - 4 * c;
        const sup = ground[k] > camp[k] ? ground[k] : camp[k];
        let nc = c + dtc * (Dc * lapC + r * c * (1 - c) * (0.3 + sup) - 0.22 * c * (1 - sup));
        if (sup > 0.5 && c < 0.02) nc += dtc * 0.05 * sup; // fed ground re-seeds itself
        nc *= 1 - burn;
        tmpC[k] = nc < 0 ? 0 : nc > 1 ? 1 : nc;
      }
    }
    G.set(G2);
    C.set(tmpC);
  }

  /** Display value of the purification medium: 1 on the front, a short fading trail behind it. */
  private glowOf(g: number) {
    if (g === 0) return 0;
    const t = 1 - (g - 1) / REFRACT;
    return t * t;
  }

  /** Corruption and purification at a world point (nearest cell; zero outside the window). */
  at(x: number, z: number, out: { c: number; u: number }) {
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    const h = this.S >> 1;
    if (Math.abs(ix - this.cx) >= h || Math.abs(iz - this.cz) >= h) {
      out.c = out.u = 0;
      return out;
    }
    const k = this.slot(ix, iz);
    out.c = this.C[k];
    out.u = this.glowOf(this.G[k]);
    return out;
  }

  /** Pack into an RG8 texture laid out by slot (the shader samples it with repeat wrapping at world/(S·cell)). */
  write(rg: Uint8Array) {
    const n = this.S * this.S;
    for (let k = 0; k < n; k++) {
      rg[k * 2] = (this.C[k] * 255) | 0;
      rg[k * 2 + 1] = (this.glowOf(this.G[k]) * 255) | 0;
    }
  }

  /** Window centre (world metres) for the shader's distance fade. */
  get centre() {
    return [(this.cx + 0.5) * this.cell, (this.cz + 0.5) * this.cell];
  }
}
