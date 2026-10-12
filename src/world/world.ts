import * as THREE from 'three';
import { worldTime, fogFar } from '../engine/materials';
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
import { Physics } from '../physics/physics';
import { DriftField, MushroomGroves, type TetherAnchor } from './traversal';
import { Props } from './props';
import { TerrainStreamer } from './chunks';
import { Wilds } from './wilds';
import { Landmarks } from './landmarks';
import { Network } from './network';
import { Toponymy, title } from './gen/names';
import { FORMATIONS } from './gen/meshgen/fractals';
import { STATIONS } from './gen/meshgen/stations';
import { VeilSetPiece, layoutVeil, type VeilLayout } from './veil';
import { buildSurfaces } from '../engine/proctex';
import { perf } from '../engine/perf';
import { flag } from '../engine/flags';
import { juliaConstant, lineageDrifts, neutralGenome, regionGenome, type Drift, type Genome } from './genome';
import { biomeStyle, nullColour } from './biomeStyle';
import { LivingField } from '../bio/livingField';

/** How much traversal furniture each region gets. */
const TRAVERSAL: Record<string, { mush: number; drift: number; crystals: number; pods: number }> = {
  seedbed: { mush: 2, drift: 1, crystals: 4, pods: 10 },
  river: { mush: 3, drift: 2, crystals: 4, pods: 14 },
  canopy: { mush: 5, drift: 3, crystals: 5, pods: 14 },
  veil: { mush: 3, drift: 4, crystals: 6, pods: 12 },
  mirror: { mush: 1, drift: 3, crystals: 14, pods: 6 },
  return: { mush: 3, drift: 2, crystals: 3, pods: 10 },
};

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
  readonly genome: Genome;
  /** Why this region's genome differs from its birth genome (narrated on entry). */
  readonly drifts: Drift[];
  /** Null corruption fronts and purification waves around the hero (null when the look flag is off). */
  readonly living: LivingField | null = null;
  readonly terrain: Terrain;
  /** Chunk-streamed ground (one batched draw call). */
  readonly ground: TerrainStreamer;
  /** Procedural flora and mycelium of the infinite Wilds (null in bounded boss arenas). */
  readonly wilds: Wilds | null;
  /** Fractal landmark formations of the Wilds (null without landforms or outside the Wilds). */
  readonly landmarks: Landmarks | null;
  /** Physarum veins linking the sites (null without the network look flag or outside the Wilds). */
  readonly network: Network | null = null;
  /** Place names of the Wilds, in the region's own language. */
  readonly names: Toponymy;
  /** Seed of the Wilds' site lattice (formations and stations; shared with the network worker). */
  readonly siteSeed: number;
  readonly flora: Flora;
  readonly mycelium: Mycelium;
  readonly grove: EchoGrove;
  readonly sky: Sky;
  readonly spires: Spires;
  readonly motes: Motes;
  readonly colliders = new Colliders();
  readonly physics: Physics;
  readonly mushrooms: MushroomGroves;
  readonly drift: DriftField;
  readonly props: Props;
  /** Act IV: Elder Tree, mushroom bridges and datastreams. */
  readonly veil: VeilSetPiece | null = null;
  readonly tetherAnchors: TetherAnchor[] = [];
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
    // the World Genome: this seed and region, evolved by every choice already recorded on the run
    this.genome = flag('genome') ? regionGenome(run.seed, def.id, run) : neutralGenome();
    this.drifts = flag('genome') ? lineageDrifts(run) : [];
    // each region grows its own ground, stone and bark textures, and writes its own Julia sigils
    buildSurfaces(baseSeed, flag('glyphs') ? juliaConstant(this.genome) : null);
    const rng = this.rng;
    this.names = new Toponymy(baseSeed ^ 0x7a3e);
    this.siteSeed = baseSeed ^ 0x1a9d;

    this.terrain = new Terrain({
      radius: this.radius,
      amp: def.terrain.amp * params.ruggedness,
      freq: def.terrain.freq,
      river: def.terrain.river,
      seed: baseSeed,
      palette: this.palette,
      grid: def.id === 'mirror' ? 0.9 : def.id === 'return' ? 0.35 : 0.6,
      // boss arenas stay a closed bowl; every other region opens into the infinite Wilds
      wild: !def.boss,
      flavour: def.flora,
      genome: this.genome,
      features: { erosion: flag('erosion'), terrace: flag('terrace'), orbit: flag('orbit'), landforms: flag('landforms') },
    });
    if (flag('genome')) this.terrain.setNullColour(nullColour(this.genome));
    this.ground = new TerrainStreamer(this.terrain, biomeStyle(this.genome, flag('oklab')));
    const lt = this.terrain.living;
    if (lt) {
      this.living = new LivingField({ size: lt.size, cell: lt.cell, excite: this.genome.excite, mercy: this.genome.mercy }, (x, z) => this.terrain.blightAt(x, z));
      this.living.sources = this.terrain.corruptions.map(() => ({ x: 0, z: 0, r: 1, s: 0 }));
    }
    this.group.add(this.ground.mesh);
    if (this.ground.horizon) this.group.add(this.ground.horizon);
    fogFar.value = this.ground.horizon ? 1 : 0;
    this.physics = new Physics((x, z) => this.terrain.heightAt(x, z));
    if (this.ground.threaded) this.physics.heightSource = (i, j, size, res) => this.ground.physicsHeights(i, j, size, res);
    this.wilds = this.terrain.wild ? new Wilds(this.terrain, this.physics, this.palette, baseSeed ^ 0x77, this.tetherAnchors) : null;
    this.landmarks = this.terrain.wild && flag('landforms') ? new Landmarks(this.terrain, this.physics, this.palette, this.siteSeed) : null;
    if (this.landmarks) this.group.add(this.landmarks.group);
    if (this.wilds) {
      this.group.add(this.wilds.group);
      if (this.ground.threaded) this.wilds.surface = (x, z) => this.ground.surfaceAt(x, z);
    }
    this.colliders.onAdd = (x, z, r) => this.physics.addPillar(x, z, r);

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

    // traversal furniture: mushroom stairs, drifting platforms, crystal clusters, spore pods
    const tv = TRAVERSAL[def.id] ?? TRAVERSAL.seedbed;
    const mushXZ: THREE.Vector2[] = [];
    for (let i = 0; i < tv.mush; i++) {
      const p = scatter(R * 0.16, 0.78);
      if (p) {
        mushXZ.push(p);
        pois.push(p);
      }
    }
    const driftXZ: THREE.Vector2[] = [];
    for (let i = 0; i < tv.drift; i++) {
      const p = scatter(R * 0.12, 0.7);
      if (p) driftXZ.push(p);
    }
    const crystalXZ: THREE.Vector2[] = [];
    for (let i = 0; i < tv.crystals; i++) {
      const p = scatter(9, 0.85);
      if (p) {
        crystalXZ.push(p);
        pois.push(p);
      }
    }
    const podXZ: THREE.Vector2[] = [];
    for (let i = 0; i < tv.pods; i++) {
      const p = scatter(5, 0.8);
      if (p) podXZ.push(p);
    }

    // Act IV: the Elder Tree stands between the Contacts, its bridges reaching each one and the Central Pylon
    let veilLayout: VeilLayout | null = null;
    if (def.contacts) {
      let tp: THREE.Vector2 | null = null;
      for (let tries = 0; tries < 60 && !tp; tries++) {
        const c = at(rng.range(0.15, 0.55), rng.range(-0.12, 0.12));
        if (dry(c) && clearOf(c, 24)) tp = c;
      }
      tp = tp ?? at(0.35, 0);
      const targets = [...nodeXZ, gateXZ, ...pylonXZ.slice(0, 1)].map((p) => ({ x: p.x, z: p.y }));
      veilLayout = layoutVeil(this.terrain, rng.fork('veil'), tp.x, tp.y, targets);
      this.colliders.add(tp.x, tp.y, 5.4);
      pois.push(tp);
    }

    const avoid = [
      ...(veilLayout ? [{ x: veilLayout.tree.x, z: veilLayout.tree.z, r: 16 }, ...veilLayout.caps.filter((c) => c.y - this.terrain.heightAt(c.x, c.z) < 6).map((c) => ({ x: c.x, z: c.z, r: c.r + 0.5 }))] : []),
      { x: startXZ.x, z: startXZ.y, r: 8 },
      { x: gateXZ.x, z: gateXZ.y, r: 10 },
      ...nodeXZ.map((p) => ({ x: p.x, z: p.y, r: def.contacts ? 13 : 8 })),
      ...pylonXZ.map((p) => ({ x: p.x, z: p.y, r: 9 })),
      ...cachesXZ.map((p) => ({ x: p.x, z: p.y, r: 3 })),
      ...mushXZ.map((p) => ({ x: p.x, z: p.y, r: 8.5 })),
      ...crystalXZ.map((p) => ({ x: p.x, z: p.y, r: 2.5 })),
    ];
    this.wilds?.keepOut.push(...avoid.filter((a) => a.r >= 8).map((a) => ({ x: a.x, z: a.z, r: a.r + 4 })));
    this.flora = buildFlora(def, this.terrain, rng.fork('flora'), params.floraDensity, avoid, this.colliders, campXZ.map((c) => ({ x: c.x, z: c.z, r: c.r })));
    this.group.add(this.flora.group);

    const vec = (l: THREE.Vector2[]) => l.map((p) => ({ x: p.x, z: p.y }));
    this.mushrooms = new MushroomGroves(this.terrain, this.physics, rng.fork('mush'), this.palette, vec(mushXZ), veilLayout?.caps ?? []);
    this.drift = new DriftField(this.terrain, this.physics, rng.fork('drift'), this.palette, vec(driftXZ));
    this.props = new Props(this.physics, this.terrain, rng.fork('props'), this.palette, vec(crystalXZ), vec(podXZ));
    this.group.add(this.mushrooms.group, this.drift.group, this.props.group);
    this.tetherAnchors.push(...this.mushrooms.anchors, ...this.drift.anchors);

    this.mycelium = new Mycelium(this.terrain, rng.fork('myc'), this.palette);
    this.group.add(this.mycelium.lines);
    this.grove = new EchoGrove(this.terrain);
    this.group.add(this.grove.group);

    nodeXZ.forEach((p, i) => {
      const n = new MemoryNode(this.palette, this.terrain, p.x, p.y, i, def.id === 'return', !!def.contacts);
      if (n.pad && veilLayout) n.pad.setArcTarget(new THREE.Vector3(veilLayout.tree.x, this.terrain.heightAt(veilLayout.tree.x, veilLayout.tree.z) + 14, veilLayout.tree.z), n.pos);
      this.nodes.push(n);
      this.group.add(n.group);
      this.mycelium.addTarget(p.x, p.y);
      this.colliders.add(p.x, p.y, 2.4);
    });
    pylonXZ.forEach((p, i) => {
      const py = new Pylon(this.palette, this.terrain, p.x, p.y, i);
      this.pylons.push(py);
      this.group.add(py.group);
      this.tetherAnchors.push({ pos: py.pos.clone().setY(py.pos.y + 7.5), label: 'Pylon' });
      this.mycelium.addTarget(p.x, p.y);
      this.colliders.add(p.x, p.y, 3.8);
    });
    cachesXZ.forEach((p) => {
      const c = new SporeCache(this.palette, this.terrain, p.x, p.y);
      this.caches.push(c);
      this.group.add(c.group);
      this.colliders.add(p.x, p.y, 1.0);
    });
    if (this.terrain.network) {
      // the slime mould feeds on the region's pylons, nodes and gate as well as on the Wilds' sites
      const pois = [...pylonXZ.map((p) => ({ x: p.x, z: p.y, w: 1 })), ...nodeXZ.map((p) => ({ x: p.x, z: p.y, w: 0.8 })), { x: gateXZ.x, z: gateXZ.y, w: 1 }];
      (this as { network: Network | null }).network = new Network(this.terrain, { siteSeed: this.siteSeed, stations: !!this.landmarks?.stations, pois, x: startXZ.x, z: startXZ.y });
    }

    if (veilLayout) {
      const cols: { x: number; z: number; y: number }[] = [];
      const ring = (x: number, z: number, n: number, r: number) => {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + i * 0.37;
          const px = x + Math.cos(a) * r;
          const pz = z + Math.sin(a) * r;
          cols.push({ x: px, z: pz, y: this.terrain.heightAt(px, pz) });
        }
      };
      ring(gateXZ.x, gateXZ.y, 6, 11);
      for (const p of nodeXZ) ring(p.x, p.y, 2, 12);
      ring(veilLayout.tree.x, veilLayout.tree.z, 4, 15);
      const v = new VeilSetPiece(veilLayout, this.palette, rng.fork('veilfx'), cols);
      (this as { veil: VeilSetPiece | null }).veil = v;
      this.group.add(v.group);
      this.tetherAnchors.push(...veilLayout.anchors);
    }

    if (def.id !== 'return') {
      const center = new THREE.Vector3(0, 0, 0);
      this.gate = new FractalGate(this.palette, this.terrain, gateXZ.x, gateXZ.y, def.boss ? new THREE.Vector3(startXZ.x, 0, startXZ.y) : center);
      this.gate.group.visible = !def.boss && !def.contacts;
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
    // with the far land drawn, real ranges make the skyline; the stand-in spires go
    this.spires.mesh.visible = !this.ground.horizon;
    this.motes = new Motes(R, def.id === 'mirror' ? 260 : 460, this.palette, def.id !== 'mirror');
    this.group.add(this.motes.object);
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

  /** Debug: nearest point (beyond the core) deep inside the given Wilds biome. */
  debugFindBiome(biome: number): { x: number; z: number } | null {
    const w = this.terrain.wild;
    if (!w) return null;
    for (let r = this.radius * 1.8; r < 900; r += 20) {
      for (let a = 0; a < Math.PI * 2; a += 0.2) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const b = w.biomeAt(x, z);
        if (b.biome === biome && b.core > 0.95 && this.terrain.riverAt(x, z) < 0.01) return { x, z };
      }
    }
    return null;
  }

  /** Stream ground, Wilds and physics around the hero. */
  stream(x: number, z: number) {
    perf.start('ground');
    this.ground.update(x, z, 2);
    perf.stop('ground');
    perf.start('wilds');
    this.wilds?.update(x, z, 1);
    this.landmarks?.update(x, z);
    this.network?.update(x, z);
    perf.stop('wilds');
    perf.start('physics');
    this.physics.streamTerrain(x, z);
    perf.stop('physics');
    if (flag('coast')) this.terrain.setCoastIsle(this.terrain.wild?.isles?.nearestBaked(x, z) ?? null);
  }

  /**
   * The named place at (x, z) in the Wilds: a formation within 70 m, else the landform province; null in the
   * authored heart of the region (it has its own name). `key` changes when the place does.
   */
  placeAt(x: number, z: number): { key: string; name: string; sub: string } | null {
    const forms = this.terrain.wild?.forms;
    if (!forms || this.terrain.wildness(x, z) < 0.6) return null;
    const f = this.landmarks?.near(x, z, 70);
    if (f?.kind === 'station') {
      const s = STATIONS[f.form];
      const sub =
        s.kind === 'dome'
          ? `${s.freq}V geodesic dome · ${s.material} members sized by stiffness analysis`
          : `${s.material} gridshell · a hanging net, inverted · ${s.openings} arches`;
      return { key: `s${f.i},${f.j}`, name: title(this.names.station(f.i, f.j)), sub };
    }
    if (f) {
      const s = FORMATIONS[f.form];
      const sub =
        s.kind === 'menger' ? `Menger sponge · kaleidoscopic IFS${s.p ? `, twisted ${s.p} rad` : ''} · ${s.iter} folds` : s.kind === 'bulb' ? `Mandelbulb · z ↦ z^${s.p} + c · orbit-trap veins` : `Julia bulb · z ↦ z^${s.p} + k · a fixed k`;
      return { key: `f${f.i},${f.j}`, name: title(this.names.formation(f.i, f.j, s.kind)), sub };
    }
    const p = forms.province(x, z);
    const n = this.names.province(p.i, p.j, p.form);
    return { key: `p${p.i},${p.j}`, name: title(n.name), sub: n.kind };
  }

  /** A purification event (kill, purge, Surge): a ring of living light runs out from (x, z) over the ground. */
  purify(x: number, z: number, radius: number) {
    this.living?.pulse(x, z, radius);
    // the network grows toward purified ground for a while
    if (radius >= 6) this.network?.feed(x, z, Math.min(1.2, radius / 14), 40);
  }

  /** Corruption and purification glow under a point (both 0 when the living field is off). */
  livingAt(x: number, z: number) {
    return this.living ? this.living.at(x, z, this.lv) : ((this.lv.c = this.lv.u = 0), this.lv);
  }
  private lv = { c: 0, u: 0 };

  private updateLiving(dt: number, player: THREE.Vector3) {
    const L = this.living;
    const lt = this.terrain.living;
    if (!L || !lt) return;
    perf.start('living');
    L.follow(player.x, player.z);
    const cs = this.terrain.corruptions;
    for (let i = 0; i < cs.length; i++) {
      const s = L.sources[i];
      s.x = cs[i].x;
      s.z = cs[i].y;
      s.r = cs[i].z;
      s.s = cs[i].w;
    }
    if (L.update(dt, 1) > 0) {
      L.write(lt.data);
      const [cx, cz] = L.centre;
      this.terrain.setLiving(cx, cz);
    }
    perf.stop('living');
  }

  /** Build everything around (x, z) at once (region entry, respawn, fast travel). */
  prime(x: number, z: number) {
    this.ground.prime(x, z);
    this.living?.follow(x, z);
    this.wilds?.prime(x, z);
    this.landmarks?.update(x, z);
    this.physics.prime(x, z);
  }

  update(dt: number, t: number, camPos: THREE.Vector3, _pointScale: number, player: THREE.Vector3) {
    worldTime.value = t;
    this.terrain.update(t);
    this.updateLiving(dt, player);
    this.flora.update(t);
    this.mycelium.update(dt, t);
    this.grove.update(dt);
    this.sky.update(t, camPos);
    this.spires.mesh.position.set(camPos.x, 0, camPos.z);
    this.motes.update();
    this.gate?.update(dt, t);
    this.mushrooms.update(t);
    this.drift.update(t);
    this.props.update(t);
    for (const n of this.nodes) n.update(dt, t, camPos);
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
    this.wilds?.dispose();
    this.landmarks?.dispose();
    this.network?.dispose();
    this.ground.dispose();
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
    this.mushrooms.dispose();
    this.drift.dispose();
    this.props.dispose();
    this.veil?.dispose();
    this.physics.dispose();
  }
}

export const stratumByIndex = (i: number) => STRATA[Math.min(i, STRATA.length - 1)];
