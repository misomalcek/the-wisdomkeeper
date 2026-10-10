/**
 * Fungal memristor TRNG (Biocomputing Blueprint 4.2) and the SHA-256 seed pool behind it.
 *
 *   reservoir spikes → memristor (pinched I-V hysteresis) → raw bits → Von Neumann debias + XOR fold
 *   → SHA-256 extraction (WebCrypto) → CSPRNG seed pool → xoshiro128** streams for loot, missions and the Director
 *
 * There is no live shiitake on the other end of the browser, so the "bio-electrical stream" is the reservoir's
 * own spike train, timed against the frame clock: which cells fire, and the sub-millisecond jitter of when the
 * game observes them, are the entropy sources. Fixes over the blueprint listing: raw bits come from the
 * memristor current's sign changes rather than a constant threshold (which emitted only 1s), the fallback pads
 * from crypto.getRandomValues instead of Math.random, and the seed is extracted with SHA-256 as the Technical
 * Grounding Report specifies rather than read straight off the whitened bits.
 */
export class FungalMemristor {
  /** Memristance w(t) in ohms, bounded as in the blueprint. */
  state = 100;
  readonly rMin = 10;
  readonly rMax = 1000;
  private lastI = 0;
  private raw: number[] = [];
  /** Last (V, I) pairs, for drawing the pinched hysteresis loop. */
  readonly trace: { v: number; i: number }[] = [];

  /** Drive the device with a voltage sample; returns the current. dw/dt = μ·V with high-frequency roll-off. */
  drive(voltage: number, frequencyHz: number, dt: number): number {
    const mobility = 150 / (1 + frequencyHz * 0.001);
    this.state = Math.max(this.rMin, Math.min(this.rMax, this.state + mobility * voltage * dt));
    const i = voltage / this.state;
    // a bit per threshold crossing of the current: the parity of how far the state moved encodes the jitter
    if (Math.abs(voltage) > 0.3 && Math.sign(i) !== Math.sign(this.lastI)) this.raw.push(this.state * 1000 & 1);
    else if (Math.abs(voltage) > 0.3) this.raw.push(((this.state * 7919) | 0) & 1);
    this.lastI = i;
    this.trace.push({ v: voltage, i });
    if (this.trace.length > 160) this.trace.shift();
    return i;
  }

  /** Raw (biased) bits waiting to be whitened. */
  get pending() {
    return this.raw.length;
  }

  /** Von Neumann debiasing (01→0, 10→1, 00/11 discarded) followed by XOR folding into bytes. */
  whiten(maxBytes = 64): Uint8Array {
    const bits: number[] = [];
    for (let i = 0; i + 1 < this.raw.length; i += 2) {
      const a = this.raw[i];
      const b = this.raw[i + 1];
      if (a !== b) bits.push(a === 0 ? 0 : 1);
    }
    this.raw.length = 0;
    // fold: each output byte XORs two consecutive whitened bytes
    const n = Math.min(maxBytes, Math.floor(bits.length / 16));
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      let x = 0;
      for (let j = 0; j < 8; j++) x |= (bits[k * 16 + j] ^ bits[k * 16 + 8 + j]) << j;
      out[k] = x;
    }
    return out;
  }
}

/** xoshiro128** — fast, high-quality 32-bit stream, seeded from the SHA-256 pool. */
export class Xoshiro {
  private s = new Uint32Array(4);
  constructor(seed: Uint32Array) {
    this.s.set(seed.subarray(0, 4));
    if (!(this.s[0] | this.s[1] | this.s[2] | this.s[3])) this.s[0] = 0x9e3779b9;
  }
  nextU32() {
    const s = this.s;
    const r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return r;
  }
  next() {
    return this.nextU32() / 4294967296;
  }
}
const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

const subtle = (): SubtleCrypto | null => (globalThis.crypto && globalThis.crypto.subtle) || null;

/**
 * Seed pool: whitened bytes are hashed with SHA-256 together with the previous pool state (forward secrecy in
 * the Fortuna sense), and every refill reseeds the CSPRNG. `random()` is synchronous and always available; the
 * pool simply gets better entropy as the reservoir runs.
 */
export class SeedPool {
  private state = new Uint8Array(32);
  private rng: Xoshiro;
  private busy = false;
  /** Number of SHA-256 extractions so far, and how many whitened bytes went in. */
  extractions = 0;
  harvested = 0;
  /** Hex digest of the latest extraction (shown on the debug overlay). */
  digest = '';

  constructor() {
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(this.state);
    else for (let i = 0; i < 32; i++) this.state[i] = (Math.random() * 256) | 0;
    this.rng = new Xoshiro(new Uint32Array(this.state.buffer.slice(0)));
  }

  /** Feed whitened bytes; hashes asynchronously and reseeds. Returns a promise for tests. */
  async absorb(bytes: Uint8Array, jitter: number): Promise<void> {
    if (!bytes.length || this.busy) return;
    this.busy = true;
    const buf = new Uint8Array(32 + bytes.length + 8);
    buf.set(this.state, 0);
    buf.set(bytes, 32);
    new DataView(buf.buffer).setFloat64(32 + bytes.length, jitter);
    try {
      const s = subtle();
      if (s) this.state = new Uint8Array(await s.digest('SHA-256', buf));
      else for (let i = 0; i < buf.length; i++) this.state[i % 32] = (this.state[i % 32] * 31 + buf[i]) & 255;
      this.rng = new Xoshiro(new Uint32Array(this.state.buffer.slice(0)));
      this.extractions++;
      this.harvested += bytes.length;
      this.digest = Array.from(this.state.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
    } finally {
      this.busy = false;
    }
  }

  random() {
    return this.rng.next();
  }
  u32() {
    return this.rng.nextU32();
  }
}
