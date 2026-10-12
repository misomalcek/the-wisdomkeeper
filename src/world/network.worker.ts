/// <reference lib="webworker" />
// The Physarum network's own thread: grows the slime mould around the hero and posts the vein map a few times a
// second (gen/physarum). It rebuilds the region's ground shape from plain options, as the chunk workers do.
import { GroundShape, type ShapeOpts } from './gen/shape';
import { Physarum, type NetOpts } from './gen/physarum';
import { SITE_CELL, latticeSite } from './gen/sites';

interface Init {
  type: 'init';
  shape: ShapeOpts;
  net: NetOpts;
  siteSeed: number;
  stations: boolean;
  /** Steps per second while live. */
  rate: number;
  pois: { x: number; z: number; w: number }[];
  x: number;
  z: number;
}

let sim: Physarum | null = null;
let shape: GroundShape | null = null;
let init: Init | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let burn = 0;
let sincePost = 0;
let carry = 0;
const siteFoods = new Map<string, { x: number; z: number; w: number; ttl: number }>();

/** Feed the network from every site of the lattice inside the window (and drop those that left it). */
function syncSites() {
  if (!sim || !shape || !init) return;
  const half = (sim.S * sim.cell) / 2;
  const cx = sim.cx * sim.cell;
  const cz = sim.cz * sim.cell;
  const i0 = Math.floor((cx - half) / SITE_CELL);
  const i1 = Math.floor((cx + half) / SITE_CELL);
  const j0 = Math.floor((cz - half) / SITE_CELL);
  const j1 = Math.floor((cz + half) / SITE_CELL);
  const keep = new Set<string>();
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = `${i},${j}`;
      keep.add(k);
      if (siteFoods.has(k)) continue;
      const s = latticeSite(shape, init.siteSeed, i, j, init.stations);
      const f = s ? { x: s.x, z: s.z, w: s.kind === 'station' ? 1.3 : 1, ttl: Infinity } : { x: 0, z: 0, w: 0, ttl: 0 };
      siteFoods.set(k, f);
      if (s) sim.foods.push(f);
    }
  }
  for (const [k, f] of siteFoods) {
    if (keep.has(k)) continue;
    siteFoods.delete(k);
    const n = sim.foods.indexOf(f);
    if (n >= 0) sim.foods.splice(n, 1);
  }
}

function post() {
  if (!sim) return;
  const rg = new Uint8Array(sim.S * sim.S * 2);
  sim.write(rg);
  (self as unknown as Worker).postMessage({ type: 'frame', rg, cx: sim.cx * sim.cell, cz: sim.cz * sim.cell }, [rg.buffer]);
}

function tick() {
  if (!sim || !init) return;
  // a burn-in grows the first network quickly (in slices, so messages still get through), then it lives slowly
  if (burn > 0) {
    const n = Math.min(burn, 20);
    sim.step(n, 0.1);
    burn -= n;
    if (burn <= 0) post();
    return;
  }
  // `rate` steps a second, on a 10 Hz tick (fractions carried over)
  carry += init.rate / 10;
  const n = Math.floor(carry);
  carry -= n;
  if (n > 0) sim.step(n, 0.1);
  sincePost += n;
  if (sincePost >= init.rate * 1.2) {
    sincePost = 0;
    post();
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    init = m as Init;
    shape = new GroundShape(init.shape);
    sim = new Physarum(init.net, shape);
    for (const p of init.pois) sim.foods.push({ x: p.x, z: p.z, w: p.w, ttl: Infinity });
    sim.follow(init.x, init.z);
    syncSites();
    burn = 260;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 100);
  } else if (m.type === 'follow') {
    if (sim?.follow(m.x, m.z)) {
      syncSites();
      burn = Math.max(burn, 60);
    }
  } else if (m.type === 'feed') {
    sim?.feed(m.x, m.z, m.w, m.ttl);
  } else if (m.type === 'stop') {
    if (timer) clearInterval(timer);
    timer = null;
    sim = null;
  }
};
