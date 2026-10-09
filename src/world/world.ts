import * as THREE from 'three';
import type { RunState } from '../types';
import { STRATA, type Palette, type StratumDef } from '../story/strata';
import { Rng, hashString } from '../util/rng';
import { TAU } from '../util/math';
import { latentToParams } from '../systems/mind';
import { Terrain } from './terrain';
import { buildFlora, type Flora } from './flora';
import { Mycelium } from './mycelium';
import { FractalGate, MemoryNode, Pylon, SporeCache } from './structures';
import { Motes, Sky, Spires } from './atmosphere';
import { EchoGrove } from '../entities/echoes';
import { Colliders } from './colliders';

function shiftPalette(p: Palette, hue: number): Palette {
  if (Math.abs(hue) < 0.001) return p;
  const out = { ...p };
  const tmp = { h: 0, s: 0, l: 0 };
  for (const k of ['skyHorizon', 'fog', 'groundBase', 'groundHigh', 'accent', 'accent2', 'river'] as const) {
    const c = new THREE.Color(p[k]);
    c.getHSL(tmp);
    c.setHSL((tmp.h + hue + 1) % 1, tmp.s, tmp.l);
    out[k] = c.getHex();
  }
  return out;
}

export interface CampSpec {
  id: number;
  x: number;
  z: number;
  r: number;
  kind: 'node' | 'roam';
  nodeIndex: number | null;
  name: string;
}

export class World {
  readonly group = new THREE.Group();
  readonly def: StratumDef;
  readonly radius: number;
  readonly palette: Palette;
  readonly terrain: Terrain;
  readonly flora: Flora;
  readonly mycelium: Mycelium;
  readonly grove: EchoGrove;
  readonly sky: Sky;
  readonly spires: Spires;
  readonly motes: Motes;
  readonly colliders = new Colliders();
  readonly nodes: MemoryNode[] = [];
  readonly pylons: Pylon[] = [];
  readonly caches: SporeCache[] = [];
  readonly camps: CampSpec[] = [];
  readonly gate?: FractalGate;
  readonly startPos = new THREE.Vector3();
  readonly checkpoint = new THREE.Vector3();
  readonly rng: Rng;
  readonly gateXZ = new THREE.Vector2();
  private mapCv?: HTMLCanvasElement;

  constructor(def: StratumDef, run: RunState) {
    this.def = def;
    const params = def.id === 'return' ? latentToParams([0, 0, 0, 0]) : latentToParams(run.latent);
    this.radius = def.radius * params.arenaScale;
    this.palette = shiftPalette(def.palette, def.id === 'return' ? 0 : params.hueShift);
    const baseSeed = hashString(`${run.seed}:${def.id === 'return' ? 'seedbed' : def.id}`);
    this.rng = new Rng(baseSeed ^ 0x51ed);
    const rng = this.rng;

    this.terrain = new Terrain({
      radius: this.radius,
      amp: def.terrain.amp * params.ruggedness,
      freq: def.terrain.freq,
      river: def.terrain.river,
      seed: baseSeed,
      palette: this.palette,
      grid: def.id === 'mirror' ? 0.9 : def.id === 'return' ? 0.35 : 0.6,
    });
    this.group.add(this.terrain.mesh);

    // ---- layout -----------------------------------------------------------------------
    const R = this.radius;
    const axis = def.id === 'river' ? 0 : rng.range(0, TAU);
    const ax = new THREE.Vector2(Math.cos(axis), Math.sin(axis));
    const perp = new THREE.Vector2(-ax.y, ax.x);
    const at = (t: number, lateral = 0) => new THREE.Vector2().addScaledVector(ax, t * R).addScaledVector(perp, lateral * R);
    const startXZ = def.boss ? at(-0.78) : at(-0.8);
    const gateXZ = def.boss ? new THREE.Vector2(0, 0) : at(0.82);
    this.gateXZ.copy(gateXZ);
    this.startPos.set(startXZ.x, this.terrain.heightAt(startXZ.x, startXZ.y), startXZ.y);
    this.checkpoint.copy(this.startPos);

    const pois: THREE.Vector2[] = [startXZ.clone(), gateXZ.clone()];
    const dry = (p: THREE.Vector2) => this.terrain.riverAt(p.x, p.y) < 0.05 && this.terrain.slopeAt(p.x, p.y) < 0.55;
    const clearOf = (p: THREE.Vector2, d: number) => pois.every((q) => q.distanceTo(p) >= d);
    const scatter = (minD: number, maxR = 0.82, tries = 90): THREE.Vector2 | null => {
      for (let i = 0; i < tries; i++) {
        const a = rng.range(0, TAU);
        const r = Math.sqrt(rng.range(0.02, 1)) * R * maxR;
        const p = new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
        if (dry(p) && clearOf(p, minD)) return p;
      }
      return null;
    };

    // Memory Nodes
    const nodeXZ: THREE.Vector2[] = [];
    if (def.nodes === 1) nodeXZ.push(new THREE.Vector2(0, 0));
    else if (def.nodes > 1) {
      for (let i = 0; i < def.nodes; i++) {
        let placed: THREE.Vector2 | null = null;
        for (let tries = 0; tries < 80 && !placed; tries++) {
          const t = -0.3 + (0.85 / (def.nodes - 1)) * i + rng.range(-0.1, 0.1);
          const lat = (i % 2 === 0 ? 1 : -1) * rng.range(0.18, 0.42);
          const p = at(t, lat);
          if (p.length() > R * 0.8 || !dry(p)) continue;
          if (!clearOf(p, R * 0.28)) continue;
          placed = p;
        }
        const p = placed ?? at(-0.25 + 0.3 * i, 0.3 * (i % 2 ? -1 : 1));
        nodeXZ.push(p);
        pois.push(p);
      }
    }
    if (def.nodes === 1) pois.push(nodeXZ[0]);

    // Pylons: the first is a safe hub near the start, the rest are spread out
    const pylonXZ: THREE.Vector2[] = [];
    for (let i = 0; i < def.pylons; i++) {
      let p: THREE.Vector2 | null = null;
      if (i === 0) {
        for (let tries = 0; tries < 30 && !p; tries++) {
          const c = at(-0.62 + rng.range(-0.05, 0.05), rng.range(-0.15, 0.15));
          if (dry(c) && clearOf(c, R * 0.12)) p = c;
        }
      }
      p = p ?? scatter(R * 0.25);
      if (p) {
        pylonXZ.push(p);
        pois.push(p);
      }
    }
    // Enemy camps: one guards each node; extra roaming camps fill the wilds
    const campXZ: CampSpec[] = [];
    nodeXZ.forEach((p, i) => {
      if (def.id !== 'return') campXZ.push({ id: campXZ.length, x: p.x, z: p.y, r: 15, kind: 'node', nodeIndex: i, name: def.groveName });
    });
    for (let i = 0; i < def.roamCamps; i++) {
      const p = scatter(R * 0.2);
      if (p) {
        campXZ.push({ id: campXZ.length, x: p.x, z: p.y, r: 13, kind: 'roam', nodeIndex: null, name: 'Null Nest' });
        pois.push(p);
      }
    }
    const cachesXZ: THREE.Vector2[] = [];
    for (let i = 0; i < def.caches; i++) {
      const p = scatter(14);
      if (p) {
        cachesXZ.push(p);
        pois.push(p);
      }
    }
    this.camps.push(...campXZ);

    const avoid = [
      { x: startXZ.x, z: startXZ.y, r: 8 },
      { x: gateXZ.x, z: gateXZ.y, r: 10 },
      ...nodeXZ.map((p) => ({ x: p.x, z: p.y, r: 8 })),
      ...pylonXZ.map((p) => ({ x: p.x, z: p.y, r: 9 })),
      ...cachesXZ.map((p) => ({ x: p.x, z: p.y, r: 3 })),
    ];
    this.flora = buildFlora(def, this.terrain, rng.fork('flora'), params.floraDensity, avoid, this.colliders, campXZ.map((c) => ({ x: c.x, z: c.z, r: c.r })));
    this.group.add(this.flora.group);

    this.mycelium = new Mycelium(this.terrain, rng.fork('myc'), this.palette);
    this.group.add(this.mycelium.lines);
    this.grove = new EchoGrove(this.terrain);
    this.group.add(this.grove.group);

    nodeXZ.forEach((p, i) => {
      const n = new MemoryNode(this.palette, this.terrain, p.x, p.y, i, def.id === 'return');
      this.nodes.push(n);
      this.group.add(n.group);
      this.mycelium.addTarget(p.x, p.y);
      this.colliders.add(p.x, p.y, 2.4);
    });
    pylonXZ.forEach((p, i) => {
      const py = new Pylon(this.palette, this.terrain, p.x, p.y, i);
      this.pylons.push(py);
      this.group.add(py.group);
      this.mycelium.addTarget(p.x, p.y);
      this.colliders.add(p.x, p.y, 3.8);
    });
    cachesXZ.forEach((p) => {
      const c = new SporeCache(this.palette, this.terrain, p.x, p.y);
      this.caches.push(c);
      this.group.add(c.group);
      this.colliders.add(p.x, p.y, 1.0);
    });

    if (def.id !== 'return') {
      const center = new THREE.Vector3(0, 0, 0);
      this.gate = new FractalGate(this.palette, this.terrain, gateXZ.x, gateXZ.y, def.boss ? new THREE.Vector3(startXZ.x, 0, startXZ.y) : center);
      this.gate.group.visible = !def.boss;
      this.group.add(this.gate.group);
      this.mycelium.addTarget(gateXZ.x, gateXZ.y);
    }
    this.mycelium.addAnchor(startXZ.x, startXZ.y);
    this.mycelium.seed(startXZ.x, startXZ.y, 5, 0, 90);
    if (def.id === 'return') this.growReturnGrove(run);
    this.mycelium.prewarm(def.id === 'return' ? 260 : 60);

    this.sky = new Sky(this.palette);
    this.group.add(this.sky.mesh);
    this.spires = new Spires(R, this.palette, def.id === 'mirror' ? 36 : 54);
    this.group.add(this.spires.mesh);
    this.motes = new Motes(R, def.id === 'mirror' ? 260 : 460, this.palette, def.id !== 'mirror');
    this.group.add(this.motes.points);
  }

  /** The Return: every echo the player ever left, grown and wired together. */
  private growReturnGrove(run: RunState) {
    const R = this.radius;
    const rng = this.rng.fork('grove');
    const placed: { x: number; z: number }[] = [];
    const list = run.echoes.slice(-240);
    for (const e of list) {
      const k = (R * 0.92) / Math.max(e.radius, 1);
      const x = e.x * k * 0.9;
      const z = e.z * k * 0.9;
      if (Math.hypot(x, z) < 6 || Math.hypot(x, z) > R * 0.95) continue;
      this.grove.plant(x, z, e.affinity, { grown: true, scale: rng.range(1.2, 1.9) });
      placed.push({ x, z });
    }
    const total = Math.max(1, run.tiers.root + run.tiers.echo + run.tiers.flow);
    const want = Math.max(0, 40 - placed.length);
    for (let i = 0; i < want; i++) {
      const roll = rng.next() * total;
      const aff = roll < run.tiers.root ? 'root' : roll < run.tiers.root + run.tiers.echo ? 'echo' : 'flow';
      const a = rng.range(0, TAU);
      const r = rng.range(10, R * 0.85);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      this.grove.plant(x, z, aff, { grown: true, scale: rng.range(1.0, 1.7) });
      placed.push({ x, z });
    }
    this.mycelium.addAnchor(0, 0);
    for (const p of placed.slice(0, 48)) {
      const near = this.mycelium.nearestAnchor(p.x, p.z, 30) ?? { x: 0, z: 0 };
      this.mycelium.connect(near, p);
    }
    this.mycelium.seed(0, 0, 14, 0, 120);
  }

  update(dt: number, t: number, camPos: THREE.Vector3, pointScale: number, player: THREE.Vector3) {
    this.terrain.update(t);
    this.flora.update(t);
    this.mycelium.update(dt, t);
    this.grove.update(dt);
    this.sky.update(t, camPos);
    this.motes.update(t, pointScale);
    this.gate?.update(dt, t);
    for (const n of this.nodes) n.update(dt, t);
    for (const p of this.pylons) p.update(dt, t);
    for (const c of this.caches) c.update(dt, t);

    let s = 0;
    this.terrain.setGlow(s++, player.x, player.z, 0.9);
    for (const n of this.nodes) this.terrain.setGlow(s++, n.pos.x, n.pos.z, n.state === 'active' ? 1.5 : n.state === 'done' ? 0.9 : 0.35);
    for (const p of this.pylons) this.terrain.setGlow(s++, p.pos.x, p.pos.z, p.state === 'active' ? 1.4 : p.state === 'done' ? 0.9 : 0.3);
    if (this.gate && this.gate.group.visible) this.terrain.setGlow(s++, this.gate.pos.x, this.gate.pos.z, 0.35 + this.gate.open * 0.9);
    const es = this.grove.echoes;
    for (let i = es.length - 1; i >= 0 && s < 10; i--) this.terrain.setGlow(s++, es[i].x, es[i].z, 0.6);
    this.terrain.clearGlowFrom(s);
  }

  /** Hill-shaded top-down raster of the region (256²) for the map and minimap. */
  get mapCanvas(): HTMLCanvasElement {
    if (this.mapCv) return this.mapCv;
    const N = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(N, N);
    const R = this.radius * 1.12;
    const lo = new THREE.Color(this.palette.groundBase).multiplyScalar(5);
    const hi = new THREE.Color(this.palette.groundHigh).multiplyScalar(3.2);
    const water = new THREE.Color(this.palette.river);
    const c = new THREE.Color();
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N - 0.5) * 2 * R;
        const z = ((j + 0.5) / N - 0.5) * 2 * R;
        const r = Math.hypot(x, z);
        const h = this.terrain.heightAt(x, z);
        const hx = this.terrain.heightAt(x + 1.6, z) - this.terrain.heightAt(x - 1.6, z);
        const shade = THREE.MathUtils.clamp(0.7 + hx * 0.12, 0.3, 1.3);
        c.copy(lo).lerp(hi, THREE.MathUtils.clamp((h + 2) / 12, 0, 1)).multiplyScalar(shade);
        const rv = this.terrain.riverAt(x, z);
        if (rv > 0.05) c.lerp(water, Math.min(1, rv * 1.3));
        if (r > this.radius) c.multiplyScalar(0.35);
        const k = (j * N + i) * 4;
        img.data[k] = Math.min(255, c.r * 255 * 1.1);
        img.data[k + 1] = Math.min(255, c.g * 255 * 1.1);
        img.data[k + 2] = Math.min(255, c.b * 255 * 1.1);
        img.data[k + 3] = 255;
      }
    }
    // auto-exposure so dark worlds still read clearly on the map
    let lum = 0;
    for (let i = 0; i < img.data.length; i += 4) lum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 765;
    lum /= N * N;
    const gain = THREE.MathUtils.clamp(0.3 / Math.max(lum, 0.02), 0.8, 2.6);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = Math.min(255, img.data[i] * gain);
      img.data[i + 1] = Math.min(255, img.data[i + 1] * gain);
      img.data[i + 2] = Math.min(255, img.data[i + 2] * gain);
    }
    ctx.putImageData(img, 0, 0);
    this.mapCv = cv;
    return cv;
  }
  get mapExtent() {
    return this.radius * 1.12;
  }

  dispose() {
    this.terrain.dispose();
    this.flora.dispose();
    this.mycelium.dispose();
    this.grove.dispose();
    this.sky.dispose();
    this.spires.dispose();
    this.motes.dispose();
    this.gate?.dispose();
    this.nodes.forEach((n) => n.dispose());
    this.pylons.forEach((n) => n.dispose());
    this.caches.forEach((n) => n.dispose());
  }
}

export const stratumByIndex = (i: number) => STRATA[Math.min(i, STRATA.length - 1)];
