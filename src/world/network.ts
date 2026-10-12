import type { Terrain } from './terrain';
import { budget } from '../engine/flags';

/**
 * The Physarum network of a region (gen/physarum, grown in network.worker): veins of living light that link the
 * landmarks, stations and pylons by paths nobody drew. The main thread only uploads the vein map the worker
 * posts and answers "how strong is the vein here, and which way does it run" for the hero's conducted flow.
 */
export class Network {
  private worker: Worker | null = null;
  private data: Uint8Array | null = null;
  private cx = 1e9;
  private cz = 1e9;
  private lastX = 1e9;
  private lastZ = 1e9;
  private readonly S: number;
  private readonly cell: number;

  constructor(
    private terrain: Terrain,
    o: { siteSeed: number; stations: boolean; pois: { x: number; z: number; w: number }[]; x: number; z: number },
  ) {
    const net = terrain.network!;
    this.S = net.size;
    this.cell = net.cell;
    if (typeof Worker === 'undefined') return;
    this.worker = new Worker(new URL('./network.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<{ type: string; rg: Uint8Array; cx: number; cz: number }>) => {
      const m = e.data;
      if (m.type !== 'frame' || !this.terrain.network) return;
      this.terrain.network.data.set(m.rg);
      this.data = m.rg;
      this.cx = m.cx;
      this.cz = m.cz;
      this.terrain.setNetwork(m.cx, m.cz);
    };
    this.worker.postMessage({
      type: 'init',
      shape: terrain.shapeOpts,
      net: { size: net.size, cell: net.cell, agents: budget().netAgents, seed: o.siteSeed },
      siteSeed: o.siteSeed,
      stations: o.stations,
      rate: 10,
      pois: o.pois,
      x: o.x,
      z: o.z,
    });
    this.lastX = o.x;
    this.lastZ = o.z;
  }

  update(x: number, z: number) {
    if (!this.worker || Math.hypot(x - this.lastX, z - this.lastZ) < this.S * this.cell * 0.06) return;
    this.lastX = x;
    this.lastZ = z;
    this.worker.postMessage({ type: 'follow', x, z });
  }

  /** Feed the network at a point for `ttl` seconds: it grows a vein toward it (a purification). */
  feed(x: number, z: number, w = 0.8, ttl = 45) {
    this.worker?.postMessage({ type: 'feed', x, z, w, ttl });
  }

  private texel(ix: number, iz: number, ch = 0) {
    const S = this.S;
    return this.data![((((iz % S) + S) % S) * S + (((ix % S) + S) % S)) * 2 + ch];
  }

  /** Vein strength 0..1 under (x, z); `out` receives the direction the vein runs (unit, sign arbitrary) × strength. */
  at(x: number, z: number, out: { x: number; y: number }) {
    out.x = out.y = 0;
    const half = (this.S * this.cell) / 2;
    if (!this.data || Math.abs(x - this.cx) > half * 0.9 || Math.abs(z - this.cz) > half * 0.9) return 0;
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    const v = this.texel(ix, iz) / 255;
    if (v <= 0) return 0;
    // the vein runs across its own gradient, outward from the food it carries (where the distance channel grows)
    const gx = this.texel(ix + 1, iz) - this.texel(ix - 1, iz);
    const gz = this.texel(ix, iz + 1) - this.texel(ix, iz - 1);
    const l = Math.hypot(gx, gz);
    if (l > 1e-4) {
      let tx = -gz / l;
      let tz = gx / l;
      const ahead = this.texel(Math.round(ix + tx * 2), Math.round(iz + tz * 2), 1);
      const behind = this.texel(Math.round(ix - tx * 2), Math.round(iz - tz * 2), 1);
      if (((ahead - behind + 384) % 256) - 128 < 0) {
        tx = -tx;
        tz = -tz;
      }
      out.x = tx * v;
      out.y = tz * v;
    }
    return v;
  }

  dispose() {
    this.worker?.postMessage({ type: 'stop' });
    this.worker?.terminate();
    this.worker = null;
  }
}
