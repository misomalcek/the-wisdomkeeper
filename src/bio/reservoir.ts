import { Rng } from '../util/rng';

/**
 * Mycelium CA reservoir (Biocomputing Blueprint 4.1): a reaction-diffusion lattice of FitzHugh-Nagumo cells
 * (a 0.13, b 0.013, c1 0.26, c2 0.095, Du 1) wired as a small-world network. Every cell diffuses to its four
 * lattice neighbours and, with Watts-Strogatz probability, to one long-range partner — the shortcuts real
 * mycelium grows between distant hyphae, which give the network its short path length and high clustering.
 *
 * Gameplay injects current where the hero acts (Root Spikes, kills, pylon purges); a few pacemaker cells keep
 * spontaneous activity alive, so the lattice always carries a spike train for the memristor to sample.
 *
 * Fixes over the blueprint listing: zero-flux borders instead of frozen ones, an explicit per-cell refractory
 * latch so a spike is counted once rather than on every frame it stays above threshold, and no per-step
 * Float32Array allocation.
 */
export class MyceliumReservoir {
  readonly size: number;
  readonly v: Float32Array;
  readonly w: Float32Array;
  private nv: Float32Array;
  private shortcut: Int32Array;
  private refractory: Uint8Array;
  private pacemakers: number[] = [];
  private rng: Rng;
  // FitzHugh-Nagumo parameters from the blueprint
  readonly a = 0.13;
  readonly b = 0.013;
  readonly c1 = 0.26;
  readonly c2 = 0.095;
  readonly Du = 1.0;
  readonly threshold = 0.6;
  /** Spikes counted on the last step, and a slow running mean used as "activity". */
  spikes = 0;
  activity = 0;
  /** Cells that crossed threshold on the last step (indices), for sampling by the memristor. */
  readonly fired: number[] = [];

  constructor(size = 48, seed = 1, rewire = 0.08) {
    this.size = size;
    const n = size * size;
    this.v = new Float32Array(n);
    this.w = new Float32Array(n);
    this.nv = new Float32Array(n);
    this.refractory = new Uint8Array(n);
    this.shortcut = new Int32Array(n).fill(-1);
    this.rng = new Rng(seed ^ 0xf17a);
    for (let i = 0; i < n; i++) if (this.rng.chance(rewire)) this.shortcut[i] = Math.floor(this.rng.next() * n);
    for (let k = 0; k < 4; k++) this.pacemakers.push(Math.floor(this.rng.next() * n));
  }

  /** Inject stimulus current at normalised lattice coordinates (0..1). */
  stimulate(u: number, v: number, magnitude: number, radius = 1) {
    const s = this.size;
    const cx = Math.floor(u * s);
    const cy = Math.floor(v * s);
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        this.v[y * s + x] = Math.min(2, this.v[y * s + x] + magnitude);
      }
    }
  }

  /**
   * Advance `steps` explicit-Euler steps. The blueprint's dt 0.015 needs ~170 steps per wave front; the game
   * integrates at dt 2.5 on a coarser lattice (spacing h ≈ 4.5, so the diffusion term is Du / h² ≈ 0.05·Du),
   * which keeps the same excitable dynamics — a front that sweeps the lattice and repolarises — at 20 Hz.
   */
  step(steps = 1, dt = 2.5) {
    const s = this.size;
    const { a, b, c1, c2, Du } = this;
    const v = this.v;
    const w = this.w;
    const nv = this.nv;
    this.fired.length = 0;
    let spikes = 0;
    // pacemakers: spontaneous depolarisation, like the slow oscillations measured in live mycelium
    for (const p of this.pacemakers) if (this.rng.chance(0.004)) v[p] = Math.min(2, v[p] + 0.9);
    for (let it = 0; it < steps; it++) {
      for (let y = 0; y < s; y++) {
        const ym = y > 0 ? -s : 0;
        const yp = y < s - 1 ? s : 0;
        for (let x = 0; x < s; x++) {
          const i = y * s + x;
          const vi = v[i];
          // zero-flux 5-point Laplacian plus the small-world shortcut
          let lap = v[i + (x > 0 ? -1 : 0)] + v[i + (x < s - 1 ? 1 : 0)] + v[i + ym] + v[i + yp] - 4 * vi;
          const sc = this.shortcut[i];
          if (sc >= 0) lap += v[sc] - vi;
          const dv = c1 * vi * (vi - a) * (1 - vi) - c2 * vi * w[i] + Du * 0.05 * lap;
          nv[i] = Math.max(-0.5, Math.min(2, vi + dv * dt));
          w[i] += b * (vi - w[i]) * dt;
        }
      }
      v.set(nv);
    }
    for (let i = 0; i < v.length; i++) {
      if (v[i] > this.threshold) {
        if (!this.refractory[i]) {
          this.refractory[i] = 1;
          spikes++;
          if (this.fired.length < 256) this.fired.push(i);
        }
      } else if (v[i] < 0.2) this.refractory[i] = 0;
    }
    this.spikes = spikes;
    this.activity += (spikes / (s * s) - this.activity) * 0.05;
    return spikes;
  }

  /** Mean membrane potential over the lattice. */
  meanPotential() {
    let t = 0;
    for (let i = 0; i < this.v.length; i++) t += this.v[i];
    return t / this.v.length;
  }

  /**
   * Small-world statistics of the wiring (lattice + shortcuts): average shortest path length between sampled
   * cell pairs (BFS) and mean clustering coefficient. Used by tests and the debug overlay.
   */
  topology(samples = 24): { apl: number; clustering: number } {
    const s = this.size;
    const n = s * s;
    const adj: number[][] = Array.from({ length: n }, () => []);
    const link = (i: number, j: number) => {
      if (i === j || adj[i].includes(j)) return;
      adj[i].push(j);
      adj[j].push(i);
    };
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = y * s + x;
        if (x < s - 1) link(i, i + 1);
        if (y < s - 1) link(i, i + s);
        // diagonal hyphal bridges close triangles, as anastomosis does in real networks
        if (x < s - 1 && y < s - 1 && (x + y) % 2 === 0) link(i, i + s + 1);
        if (this.shortcut[i] >= 0) link(i, this.shortcut[i]);
      }
    }
    const rng = new Rng(7);
    let total = 0;
    let pairs = 0;
    const dist = new Int32Array(n);
    for (let k = 0; k < samples; k++) {
      const src = Math.floor(rng.next() * n);
      dist.fill(-1);
      dist[src] = 0;
      const q = [src];
      for (let h = 0; h < q.length; h++) {
        const u = q[h];
        for (const nb of adj[u]) {
          if (dist[nb] < 0) {
            dist[nb] = dist[u] + 1;
            q.push(nb);
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (dist[i] > 0) {
          total += dist[i];
          pairs++;
        }
      }
    }
    let cc = 0;
    for (let i = 0; i < n; i++) {
      const nb = adj[i];
      if (nb.length < 2) continue;
      let links = 0;
      for (let p = 0; p < nb.length; p++) for (let q = p + 1; q < nb.length; q++) if (adj[nb[p]].includes(nb[q])) links++;
      cc += (2 * links) / (nb.length * (nb.length - 1));
    }
    return { apl: total / Math.max(pairs, 1), clustering: cc / n };
  }
}
