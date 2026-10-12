import * as THREE from 'three';
import { LineBasicNodeMaterial } from 'three/webgpu';
import { attribute, sin, mix, positionWorld, color } from 'three/tsl';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Terrain } from './terrain';
import type { Palette } from '../story/strata';
import type { Physics } from '../physics/physics';
import type { TetherAnchor } from './traversal';
import { Rng } from '../util/rng';
import { TAU } from '../util/math';
import { Biome } from './gen/field';
import { CANOPY, DRAGON, SPIRE, SHRUB, BLIGHT, TREE_SPECIES, TREE_LODS, type TreeSpecies } from './gen/meshgen/trees';
import { TREE_VARIANTS, BOULDER_VARIANTS, HOODOO_VARIANTS, CRYSTAL_VARIANTS, treeKey, boulderKey, hoodooKey, crystalKey, tuftKey } from './gen/meshgen/index';
import { loadProtos, protoGeometry, whenProtos } from './protos';
import { flagTier } from '../engine/flags';
import type { GroundSample } from './gen/shape';
import { vogel } from './gen/phyllotaxis';
import { growHyphae } from './gen/hyphae';
import { CHUNK } from './chunks';
import { glow, worldTime, floraGlow, type N } from '../engine/materials';
import { occlusionFade } from './occlusion';
import { capMaterial, crystalMaterial, rockMaterial, stemMaterial, treeMaterial, tuftMaterial } from '../engine/surfaces';

/** Chebyshev radius (in chunks) of the living Wilds around the hero. */
const FLORA_RINGS = 2;
const SLOTS = (2 * FLORA_RINGS + 1) ** 2 + 4;
const FIBONACCI = [8, 13, 21];

const _o = new THREE.Object3D();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _gs: GroundSample = { h: 0, river: 0, blight: 0, biome: Biome.Meadow, core: 0, wild: 0, isleSd: 1e4, rock: 0, strata: 0, sand: 0, ero: 0 };

/**
 * One InstancedMesh shared by every Wilds chunk. Each chunk keeps its own packed instance list; the pool
 * re-packs the live lists densely on commit, so the GPU never draws empty instances.
 */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  private lists = new Map<number, { m: Float32Array; c: Float32Array; n: number }>();
  private cur: { m: Float32Array; c: Float32Array; n: number } | null = null;
  private dirty = false;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly per: number, shadow = true, private shared = false) {
    this.mesh = new THREE.InstancedMesh(geo, mat, per * SLOTS);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(per * SLOTS * 3), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
  }
  begin(slot: number) {
    let l = this.lists.get(slot);
    if (!l) {
      l = { m: new Float32Array(this.per * 16), c: new Float32Array(this.per * 3), n: 0 };
      this.lists.set(slot, l);
    }
    l.n = 0;
    this.cur = l;
  }
  /** Returns false once the chunk's budget is used up. */
  add(_slot: number, m: THREE.Matrix4, color: THREE.Color) {
    const l = this.cur!;
    if (l.n >= this.per) return false;
    m.toArray(l.m, l.n * 16);
    color.toArray(l.c, l.n * 3);
    l.n++;
    return true;
  }
  end(_slot: number) {
    this.cur = null;
    this.dirty = true;
  }
  clear(slot: number) {
    const l = this.lists.get(slot);
    if (l) l.n = 0;
    this.dirty = true;
  }
  commit() {
    if (!this.dirty) return;
    this.dirty = false;
    const M = this.mesh.instanceMatrix.array as Float32Array;
    const C = this.mesh.instanceColor!.array as Float32Array;
    let n = 0;
    for (const l of this.lists.values()) {
      if (!l.n) continue;
      M.set(l.m.subarray(0, l.n * 16), n * 16);
      C.set(l.c.subarray(0, l.n * 3), n * 3);
      n += l.n;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0 && !!this.mesh.geometry.attributes.position;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceColor!.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
    this.mesh.instanceColor!.addUpdateRange(0, n * 3);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
  /** Swap in the real (shared prototype) geometry once it exists. */
  setGeometry(g: THREE.BufferGeometry) {
    this.mesh.geometry = g;
    this.dirty = true;
  }
  dispose() {
    if (!this.shared) this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/** A generated prototype placed in a chunk: its key without the LOD suffix, transform and colour. */
interface Placed {
  base: string;
  m: Float32Array;
  r: number;
  g: number;
  b: number;
}

interface WildChunk {
  cx: number;
  cz: number;
  slot: number;
  colliders: RAPIER.Collider[];
  anchors: TetherAnchor[];
  placed: Placed[];
  /** Level of detail the generated trees and stones are drawn at. */
  lod: number;
}

/** Nominal heights (m at scale 1) of the generated species, for colliders and tether anchors. */
const TREE_H: Record<string, number> = { canopy: 11, dragon: 10, spire: 14, shrub: 2.5, blight: 6.5 };

export interface WildPickup {
  x: number;
  y: number;
  z: number;
  kind: 'fiber' | 'res';
}

/**
 * The living Wilds: flora, crystal and mycelium grown procedurally per terrain chunk as the hero explores.
 * - Trees are L-systems interpreted by a 3D turtle (canopy whorls, fern fronds, drooping blight trees).
 * - Mushrooms grow in fairy rings laid out by Vogel's phyllotaxis, in Fibonacci counts.
 * - Crystal outcrops fan out on the golden angle.
 * - A mycelial cord network threads every chunk and joins its neighbours at shared edge hubs.
 * Everything renders through a handful of slot-pooled instanced meshes (one draw call per kind).
 */
export class Wilds {
  readonly group = new THREE.Group();
  /** Generated trees and stones: one pool per prototype × LOD (all share the prototype meshes). */
  private lodPools = new Map<string, Pool>();
  /** Generated quartz clusters (also the Blight's red shards). */
  private crystalPools: Pool[] = [];
  private stems: Pool;
  private caps: Pool;
  private tufts: Pool;
  private veins: THREE.LineSegments;
  private veinPos: Float32Array;
  private veinKind: Float32Array;
  private readonly veinPer = 520;
  private chunks = new Map<string, WildChunk>();
  private freeSlots: number[] = [];
  private queue: { cx: number; cz: number; d: number }[] = [];
  private lastCx = 1e9;
  private lastCz = 1e9;
  private harvested = new Set<string>();
  /** Clearings the Wilds leave open around set pieces (Contacts, Pylons, the Elder Tree). */
  readonly keepOut: { x: number; z: number; r: number }[] = [];
  /** Pickups waiting for the game to place them (drained every frame). */
  readonly pickups: WildPickup[] = [];
  built = 0;
  /**
   * Height of the drawn ground for decoration (cords, tufts): the streamer's cached grids when available, so a flora
   * chunk does not re-evaluate the field ~1000 times. Solid things (trees, pickups) keep the exact field.
   */
  surface: (x: number, z: number) => number;

  constructor(
    private terrain: Terrain,
    private physics: Physics,
    private pal: Palette,
    private seed: number,
    private anchors: TetherAnchor[],
  ) {
    this.surface = (x, z) => terrain.heightAt(x, z);
    for (let i = SLOTS - 1; i >= 0; i--) this.freeSlots.push(i);
    const accA = new THREE.Color(pal.accent);
    const accB = new THREE.Color(pal.accent2);
    const mats: Record<string, () => THREE.Material> = {
      canopy: () => treeMaterial(0x4a2f7a, accA, accB, 1.1),
      spire: () => treeMaterial(0x2e2448, accB, accA, 0.9),
      dragon: () => treeMaterial(0x6a5a52, accA, new THREE.Color(accA).lerp(accB, 0.5), 0.8),
      shrub: () => treeMaterial(0x1f6b55, accA, accB, 1.3),
      blight: () => treeMaterial(0x150c18, 0x7a0024, 0x9a1240, 1, 0.9),
    };
    loadProtos();
    for (const sp of TREE_SPECIES) {
      const mat = occlusionFade(mats[sp.name]() as never) as THREE.Material;
      for (let v = 0; v < TREE_VARIANTS; v++) {
        for (let l = 0; l < TREE_LODS.length; l++) {
          const per = sp === SHRUB ? 24 : 16;
          const p = new Pool(new THREE.BufferGeometry(), mat, per, sp !== SHRUB, true);
          this.lodPools.set(treeKey(sp.name, v, l), p);
        }
      }
    }
    const rockMat = occlusionFade(rockMaterial());
    const hoodooMat = occlusionFade(rockMaterial(true));
    for (let l = 0; l < 2; l++) {
      for (let v = 0; v < BOULDER_VARIANTS; v++) this.lodPools.set(boulderKey(v, l), new Pool(new THREE.BufferGeometry(), rockMat, 12, true, true));
      for (let v = 0; v < HOODOO_VARIANTS; v++) this.lodPools.set(hoodooKey(v, l), new Pool(new THREE.BufferGeometry(), hoodooMat, 6, true, true));
    }
    const crystalMat = occlusionFade(crystalMaterial(0.85));
    for (let v = 0; v < CRYSTAL_VARIANTS; v++) this.crystalPools.push(new Pool(new THREE.BufferGeometry(), crystalMat, 24, true, true));
    const capGeo = new THREE.SphereGeometry(1, 10, 5, 0, TAU, 0, Math.PI / 2);
    this.stems = new Pool(new THREE.CylinderGeometry(0.11, 0.2, 1, 6, 1, true).translate(0, 0.5, 0), occlusionFade(stemMaterial()), 90);
    this.caps = new Pool(capGeo, occlusionFade(capMaterial(0.55)), 90, false);
    this.tufts = new Pool(new THREE.BufferGeometry(), tuftMaterial(0.45, THREE.DoubleSide), 300, false, true);
    for (const p of this.pools) this.group.add(p.mesh);

    // mycelial cords: one LineSegments buffer, slot ranges per chunk
    const nv = this.veinPer * SLOTS * 2;
    this.veinPos = new Float32Array(nv * 3);
    this.veinKind = new Float32Array(nv);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.veinPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aKind', new THREE.BufferAttribute(this.veinKind, 1).setUsage(THREE.DynamicDrawUsage));
    const kind: N = attribute('aKind', 'float');
    const ca: N = color(pal.accent);
    const cb: N = color(pal.accent2);
    const blightC: N = color(0xff0d4d);
    const pulse = sin(worldTime.mul(2.1).sub(positionWorld.x.add(positionWorld.z).mul(0.3))).mul(0.5).add(0.5);
    const base: N = mix(mix(ca, cb, kind.min(1)), blightC, kind.sub(1).max(0));
    const vm = new LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    vm.colorNode = base.mul(pulse.mul(pulse).mul(0.7).add(0.25));
    glow(vm, floraGlow.mul(0.9));
    this.veins = new THREE.LineSegments(g, vm);
    this.veins.frustumCulled = false;
    this.group.add(this.veins);
    // last: the callback runs at once when the prototypes already exist (every region after the first)
    whenProtos(() => {
      if (this.disposed) return;
      for (const [k, p] of this.lodPools) {
        const g = protoGeometry(k);
        if (g) p.setGeometry(g);
      }
      const tg = protoGeometry(tuftKey(0));
      if (tg) this.tufts.setGeometry(tg);
      this.crystalPools.forEach((p, v) => {
        const g = protoGeometry(crystalKey(v));
        if (g) p.setGeometry(g);
      });
      for (const p of this.pools) p.commit();
    });
  }
  private disposed = false;

  get count() {
    return this.chunks.size;
  }

  prime(x: number, z: number) {
    this.lastCx = 1e9;
    this.update(x, z, 1e6);
  }

  update(x: number, z: number, budget = 1) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;
      for (const [k, c] of this.chunks) {
        if (Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) > FLORA_RINGS) {
          this.release(c);
          this.chunks.delete(k);
        }
      }
      for (const c of this.chunks.values()) {
        const lod = this.lodFor(Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)));
        if (lod !== c.lod) {
          c.lod = lod;
          this.emitPlaced(c);
        }
      }
      this.queue.length = 0;
      for (let j = -FLORA_RINGS; j <= FLORA_RINGS; j++) {
        for (let i = -FLORA_RINGS; i <= FLORA_RINGS; i++) {
          if (!this.chunks.has(`${cx + i},${cz + j}`)) this.queue.push({ cx: cx + i, cz: cz + j, d: i * i + j * j });
        }
      }
      this.queue.sort((p, q) => q.d - p.d);
    }
    let n = 0;
    while (this.queue.length && n < budget) {
      const q = this.queue.pop()!;
      if (!this.chunks.has(`${q.cx},${q.cz}`)) this.grow(q.cx, q.cz);
      n++;
    }
    for (const p of this.pools) p.commit();
  }

  private get pools() {
    return [...this.lodPools.values(), ...this.crystalPools, this.stems, this.caps, this.tufts];
  }

  /** LOD for a chunk at Chebyshev distance d from the hero's chunk (the low tier always draws the light trees). */
  private lodFor(d: number) {
    return this.lowTier || d > 1 ? 1 : 0;
  }
  private readonly lowTier = flagTier() === 'low';

  /** (Re)write a chunk's generated trees and stones into the pools of its current LOD. */
  private emitPlaced(c: WildChunk) {
    for (const p of this.lodPools.values()) p.begin(c.slot), p.end(c.slot);
    const byPool = new Map<Pool, Placed[]>();
    for (const t of c.placed) {
      const p = this.lodPools.get(`${t.base}:${c.lod}`)!;
      let l = byPool.get(p);
      if (!l) byPool.set(p, (l = []));
      l.push(t);
    }
    for (const [p, l] of byPool) {
      p.begin(c.slot);
      for (const t of l) p.add(c.slot, _m.fromArray(t.m), _c.setRGB(t.r, t.g, t.b));
      p.end(c.slot);
    }
  }

  private release(c: WildChunk) {
    for (const col of c.colliders) this.physics.removeCollider(col);
    for (const a of c.anchors) {
      const i = this.anchors.indexOf(a);
      if (i >= 0) this.anchors.splice(i, 1);
    }
    for (const p of this.pools) p.clear(c.slot);
    this.writeVeins(c.slot, []);
    this.freeSlots.push(c.slot);
  }

  /** Is this point outside the authored core (where the region's own flora lives)? */
  private wildAt(x: number, z: number) {
    return this.terrain.wildness(x, z) > 0.05 && Math.hypot(x, z) > this.terrain.radius * 1.02;
  }

  private grow(cx: number, cz: number) {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return;
    const c: WildChunk = { cx, cz, slot, colliders: [], anchors: [], placed: [], lod: this.lodFor(Math.max(Math.abs(cx - this.lastCx), Math.abs(cz - this.lastCz))) };
    this.chunks.set(`${cx},${cz}`, c);
    const pools = [this.stems, this.caps, this.tufts, ...this.crystalPools];
    for (const p of pools) p.begin(slot);
    const t = this.terrain;
    const field = t.wild!;
    const rng = new Rng((Math.imul(cx, 0x2c1b3c6d) ^ Math.imul(cz, 0x297a2d39) ^ this.seed) >>> 0);
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const first = !this.harvested.has(`${cx},${cz}`);
    this.harvested.add(`${cx},${cz}`);
    const accA = new THREE.Color(this.pal.accent);
    const accB = new THREE.Color(this.pal.accent2);

    // jittered 6×6 site lattice; each site's biome decides what grows there
    const G = 6;
    const cell = CHUNK / G;
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const x = x0 + (i + rng.range(0.15, 0.85)) * cell;
        const z = z0 + (j + rng.range(0.15, 0.85)) * cell;
        if (!this.wildAt(x, z) || t.riverAt(x, z) > 0.05) continue;
        if (this.keepOut.some((k) => (x - k.x) ** 2 + (z - k.z) ** 2 < k.r * k.r)) continue;
        const b = field.biomeAt(x, z);
        const y = t.heightAt(x, z);
        const slope = t.slopeAt(x, z);
        const roll = rng.next();
        // the landform under the site: dune seas stay nearly bare, bare rock thins the woods, canyonlands grow dragon trees
        t.shape.sample(x, z, _gs);
        const sand = _gs.sand;
        const rock = Math.max(_gs.rock, slope > 0.9 ? 1 : 0);
        const strata = _gs.strata;
        if (sand > 0.5) {
          if (roll < 0.015) this.stone(c, 'boulder', x, y, z, rng.range(0.8, 2.2), rng);
          else if (roll < 0.04 && b.biome !== Biome.Blight) this.plant(c, DRAGON, x, y, z, rng, rng.range(0.8, 1.2));
          else if (roll < 0.06) this.tuftPatch(slot, x, z, rng, 2, accA, accB);
          continue;
        }
        const thin = 1 - 0.65 * rock;
        // stone: boulders on bare rock (and a few anywhere), hoodoos in the canyonlands
        const roll2 = rng.next();
        if (strata > 0.4 && roll2 < 0.1 * strata) {
          this.stone(c, 'hoodoo', x, y, z, rng.range(1.4, 3.6), rng);
          continue;
        }
        if (roll2 < 0.03 + 0.3 * rock) this.stone(c, 'boulder', x + rng.range(-2, 2), y, z + rng.range(-2, 2), rng.range(0.5, 1.4) * (1 + 1.6 * rock * rng.next()), rng);
        if (b.biome === Biome.Forest) {
          if (strata > 0.5 && roll < 0.12) this.plant(c, DRAGON, x, y, z, rng, rng.range(0.85, 1.3));
          else if (roll < (0.22 * b.core + 0.04) * thin && slope < 0.7) this.plant(c, rng.chance(0.3 + 0.5 * rock) ? SPIRE : CANOPY, x, y, z, rng, rng.range(0.85, 1.35));
          else if (roll < 0.34 * thin) this.plant(c, SHRUB, x, y, z, rng, rng.range(0.8, 1.5), false);
          this.tuftPatch(slot, x, z, rng, 5, accA, accB);
        } else if (b.biome === Biome.Meadow) {
          if (roll < 0.06 && slope < 0.45) this.fairyRing(c, x, z, rng, accA, accB, first);
          else if (roll < 0.09 + 0.06 * strata) this.plant(c, DRAGON, x, y, z, rng, rng.range(0.8, 1.25));
          else if (roll < 0.22) this.mushroom(slot, x, y, z, rng.range(0.6, 2.2), rng, accA, accB);
          else if (roll < 0.28) this.plant(c, SHRUB, x, y, z, rng, rng.range(0.7, 1.2), false);
          this.tuftPatch(slot, x, z, rng, 8, accA, accB);
        } else if (b.biome === Biome.Crystal) {
          if (roll < 0.22) this.outcrop(c, x, y, z, rng, accB, first && roll < 0.05);
          else if (roll < 0.3) this.tuftPatch(slot, x, z, rng, 3, accA, accB);
        } else {
          // Null blight: withered thorn trees and red shards
          if (roll < (0.1 * b.core + 0.02) * thin) this.plant(c, BLIGHT, x, y, z, rng, rng.range(0.9, 1.3));
          else if (roll < 0.35) this.thorns(slot, x, y, z, rng);
        }
      }
    }
    for (const p of pools) p.end(slot);
    this.emitPlaced(c);

    // mycelial cords
    const segs = growHyphae(cx, cz, CHUNK, this.seed, this.veinPer);
    this.writeVeins(slot, segs.filter((s) => this.wildAt(s.x0, s.z0) && this.wildAt(s.x1, s.z1)).map((s) => {
      const bl = t.blightAt(s.x0, s.z0);
      return { ...s, kind: bl > 0.3 ? 2 : s.kind };
    }));
    this.built++;
  }

  private writeVeins(slot: number, segs: { x0: number; z0: number; x1: number; z1: number; kind: number }[]) {
    const base = slot * this.veinPer * 2;
    for (let k = 0; k < this.veinPer; k++) {
      const v = (base + k * 2) * 3;
      const s = segs[k];
      if (!s) {
        this.veinPos.fill(0, v, v + 6);
        continue;
      }
      this.veinPos[v] = s.x0;
      this.veinPos[v + 1] = this.surface(s.x0, s.z0) + 0.1;
      this.veinPos[v + 2] = s.z0;
      this.veinPos[v + 3] = s.x1;
      this.veinPos[v + 4] = this.surface(s.x1, s.z1) + 0.1;
      this.veinPos[v + 5] = s.z1;
      this.veinKind[base + k * 2] = this.veinKind[base + k * 2 + 1] = s.kind;
    }
    const pos = this.veins.geometry.attributes.position as THREE.BufferAttribute;
    const kind = this.veins.geometry.attributes.aKind as THREE.BufferAttribute;
    pos.addUpdateRange(base * 3, this.veinPer * 6);
    kind.addUpdateRange(base, this.veinPer * 2);
    pos.needsUpdate = kind.needsUpdate = true;
  }

  /** Plant one generated tree: a seeded variant of the species, turned and scaled, with a trunk collider. */
  private plant(c: WildChunk, sp: TreeSpecies, x: number, y: number, z: number, rng: Rng, scale: number, solid = true) {
    const v = rng.int(0, TREE_VARIANTS - 1);
    _o.position.set(x, y - 0.1, z);
    _o.rotation.set(rng.range(-0.05, 0.05), rng.range(0, TAU), rng.range(-0.05, 0.05));
    _o.scale.setScalar(scale);
    _o.updateMatrix();
    const k = rng.range(0.8, 1.15);
    c.placed.push({ base: treeKey(sp.name, v, 0).slice(0, -2), m: Float32Array.from(_o.matrix.elements), r: k, g: k, b: k });
    if (!solid) return;
    const h = TREE_H[sp.name] * scale;
    c.colliders.push(this.physics.addPillar(x, z, sp.trunkR * scale + 0.15, Math.min(h, 6)));
    if (sp === CANOPY && h > 9) {
      const a: TetherAnchor = { pos: new THREE.Vector3(x, y + h - 2.5, z), label: 'Canopy crown' };
      c.anchors.push(a);
      this.anchors.push(a);
    }
  }

  private mushroom(slot: number, x: number, y: number, z: number, h: number, rng: Rng, a: THREE.Color, b: THREE.Color) {
    const w = rng.range(0.45, 1.2) * (h > 1.8 ? 1.25 : 1);
    _o.position.set(x, y - 0.05, z);
    _o.rotation.set(rng.range(-0.08, 0.08), rng.range(0, TAU), rng.range(-0.08, 0.08));
    _o.scale.set(1 + h * 0.15, h, 1 + h * 0.15);
    _o.updateMatrix();
    this.stems.add(slot, _o.matrix, _c.setHex(0xb4c8d0));
    _o.position.y += h * 0.97;
    _o.scale.set(w, w * 0.6, w);
    _o.updateMatrix();
    this.caps.add(slot, _o.matrix, _c.copy(a).lerp(b, rng.next()).multiplyScalar(rng.range(0.8, 1.3)));
  }

  /** A fairy ring: mushrooms on Vogel's spiral, a Fibonacci number of them, with a fiber cache at the heart. */
  private fairyRing(c: WildChunk, cx: number, cz: number, rng: Rng, a: THREE.Color, b: THREE.Color, first: boolean) {
    const n = rng.pick(FIBONACCI);
    const spacing = rng.range(0.85, 1.25);
    const t = this.terrain;
    for (let k = 3; k < n + 3; k++) {
      const p = vogel(k, spacing);
      const x = cx + p.x;
      const z = cz + p.z;
      const h = 0.5 + (p.r / (spacing * Math.sqrt(n + 3))) * 2.2; // taller toward the rim
      this.mushroom(c.slot, x, t.heightAt(x, z), z, h, rng, a, b);
    }
    if (first) this.pickups.push({ x: cx, y: t.heightAt(cx, cz) + 0.9, z: cz, kind: rng.chance(0.65) ? 'fiber' : 'res' });
  }

  /** Quartz outcrop: a generated cluster (hexagonal prisms with pyramidal points), with a few small ones around it. */
  private outcrop(c: WildChunk, x: number, y: number, z: number, rng: Rng, col: THREE.Color, cache: boolean) {
    const big = rng.range(1, 2.6);
    this.cluster(c.slot, x, y - 0.1, z, big * 1.6, rng, _c.copy(col).multiplyScalar(rng.range(0.7, 1.1)));
    for (let k = 1; k < rng.int(2, 5); k++) {
      const p = vogel(k + 2, 0.9 * big);
      this.cluster(c.slot, x + p.x, this.surface(x + p.x, z + p.z) - 0.05, z + p.z, big * rng.range(0.35, 0.7), rng, _c.copy(col).multiplyScalar(rng.range(0.6, 1)));
    }
    c.colliders.push(this.physics.addPillar(x, z, 0.5 * big + 0.3, big * 4));
    if (cache) this.pickups.push({ x: x + 1.6, y: y + 0.9, z: z + 1.6, kind: 'res' });
  }

  private cluster(slot: number, x: number, y: number, z: number, s: number, rng: Rng, col: THREE.Color) {
    _o.position.set(x, y, z);
    _o.rotation.set(rng.range(-0.12, 0.12), rng.range(0, TAU), rng.range(-0.12, 0.12));
    _o.scale.setScalar(s);
    _o.updateMatrix();
    this.crystalPools[rng.int(0, CRYSTAL_VARIANTS - 1)].add(slot, _o.matrix, col);
  }

  /** The Blight's shards: small clusters of red crystal, half sunk in the ground. */
  private thorns(slot: number, x: number, y: number, z: number, rng: Rng) {
    for (let k = 0; k < rng.int(1, 3); k++) {
      const p = vogel(k, 0.7);
      this.cluster(slot, x + p.x, y - 0.25, z + p.z, rng.range(0.45, 0.95), rng, _c.setRGB(0.55, 0.02, 0.12));
    }
  }

  /** A generated stone (boulder or hoodoo), half buried, with a collider when it is big enough to block the way. */
  private stone(c: WildChunk, kind: 'boulder' | 'hoodoo', x: number, y: number, z: number, s: number, rng: Rng) {
    const v = rng.int(0, (kind === 'boulder' ? BOULDER_VARIANTS : HOODOO_VARIANTS) - 1);
    _o.position.set(x, y - (kind === 'boulder' ? 0.35 * s : 0.15 * s), z);
    _o.rotation.set(rng.range(-0.15, 0.15), rng.range(0, TAU), rng.range(-0.15, 0.15));
    _o.scale.set(s * rng.range(0.85, 1.15), s * rng.range(0.85, 1.15), s * rng.range(0.85, 1.15));
    _o.updateMatrix();
    const tone = new THREE.Color(this.pal.groundHigh).lerp(new THREE.Color(0x8a8590), 0.35).multiplyScalar(rng.range(0.7, 1.15) * (kind === 'hoodoo' ? 1.2 : 1));
    c.placed.push({ base: (kind === 'boulder' ? boulderKey(v, 0) : hoodooKey(v, 0)).slice(0, -2), m: Float32Array.from(_o.matrix.elements), r: tone.r, g: tone.g, b: tone.b });
    if (s > 1.1) c.colliders.push(this.physics.addPillar(x, z, (kind === 'boulder' ? 0.85 : 0.5) * s, (kind === 'boulder' ? 1.1 : 3.8) * s));
  }

  private tuftPatch(slot: number, x: number, z: number, rng: Rng, n: number, a: THREE.Color, b: THREE.Color) {
    for (let k = 0; k < n; k++) {
      const px = x + rng.range(-3, 3);
      const pz = z + rng.range(-3, 3);
      if (!this.wildAt(px, pz)) continue;
      _o.position.set(px, this.surface(px, pz) - 0.05, pz);
      _o.rotation.set(rng.range(-0.2, 0.2), rng.range(0, TAU), rng.range(-0.2, 0.2));
      _o.scale.set(rng.range(0.6, 1.2), rng.range(0.35, 1.1), rng.range(0.6, 1.2));
      _o.updateMatrix();
      this.tufts.add(slot, _o.matrix, _c.copy(rng.chance(0.65) ? a : b).multiplyScalar(rng.range(0.25, 0.55)));
    }
  }

  dispose() {
    this.disposed = true;
    for (const c of this.chunks.values()) for (const col of c.colliders) this.physics.removeCollider(col);
    for (const p of this.pools) p.dispose();
    this.veins.geometry.dispose();
    (this.veins.material as THREE.Material).dispose();
  }
}
