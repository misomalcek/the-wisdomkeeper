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
import { interpret, CANOPY_TREE, FERN_BUSH, BLIGHT_TREE, type Species } from './gen/lsystem';
import { vogel } from './gen/phyllotaxis';
import { growHyphae } from './gen/hyphae';
import { CHUNK } from './chunks';
import { selfLit, standard, glow, worldTime, type N } from '../engine/materials';
import { occlusionFade } from './occlusion';

/** Chebyshev radius (in chunks) of the living Wilds around the hero. */
const FLORA_RINGS = 2;
const SLOTS = (2 * FLORA_RINGS + 1) ** 2 + 4;
const FIBONACCI = [8, 13, 21];

const _o = new THREE.Object3D();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * One InstancedMesh shared by every Wilds chunk. Each chunk keeps its own packed instance list; the pool
 * re-packs the live lists densely on commit, so the GPU never draws empty instances.
 */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  private lists = new Map<number, { m: Float32Array; c: Float32Array; n: number }>();
  private cur: { m: Float32Array; c: Float32Array; n: number } | null = null;
  private dirty = false;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly per: number, shadow = true) {
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
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceColor!.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
    this.mesh.instanceColor!.addUpdateRange(0, n * 3);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

interface WildChunk {
  cx: number;
  cz: number;
  slot: number;
  colliders: RAPIER.Collider[];
  anchors: TetherAnchor[];
}

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
  private bark: Pool;
  private tips: Pool;
  private stems: Pool;
  private caps: Pool;
  private crystals: Pool;
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
  /** Pickups waiting for the game to place them (drained every frame). */
  readonly pickups: WildPickup[] = [];
  built = 0;

  constructor(
    private terrain: Terrain,
    private physics: Physics,
    private pal: Palette,
    private seed: number,
    private anchors: TetherAnchor[],
  ) {
    for (let i = SLOTS - 1; i >= 0; i--) this.freeSlots.push(i);
    this.bark = new Pool(new THREE.CylinderGeometry(0.62, 1, 1, 5, 1, true).translate(0, 0.5, 0), occlusionFade(standard({ roughness: 0.78, metalness: 0.04, side: THREE.DoubleSide })), 1600);
    this.tips = new Pool(new THREE.OctahedronGeometry(0.3, 0), occlusionFade(selfLit(1.25, { roughness: 0.4 })), 640, false);
    const capGeo = new THREE.SphereGeometry(1, 10, 5, 0, TAU, 0, Math.PI / 2);
    this.stems = new Pool(new THREE.CylinderGeometry(0.11, 0.2, 1, 6, 1, true).translate(0, 0.5, 0), occlusionFade(standard({ roughness: 0.8 })), 90);
    this.caps = new Pool(capGeo, occlusionFade(selfLit(0.55, { side: THREE.DoubleSide, roughness: 0.5 })), 90, false);
    this.crystals = new Pool(new THREE.CylinderGeometry(0.0, 0.32, 1, 6, 1).translate(0, 0.5, 0), occlusionFade(selfLit(0.85, { roughness: 0.1, metalness: 0.2 })), 90);
    this.tufts = new Pool(new THREE.ConeGeometry(0.1, 0.8, 4).translate(0, 0.4, 0), selfLit(0.45), 300, false);
    for (const p of [this.bark, this.tips, this.stems, this.caps, this.crystals, this.tufts]) this.group.add(p.mesh);

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
    glow(vm, 0.9);
    this.veins = new THREE.LineSegments(g, vm);
    this.veins.frustumCulled = false;
    this.group.add(this.veins);
  }

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
    return [this.bark, this.tips, this.stems, this.caps, this.crystals, this.tufts];
  }

  private release(c: WildChunk) {
    for (const col of c.colliders) this.physics.removeCollider(col);
    for (const a of c.anchors) {
      const i = this.anchors.indexOf(a);
      if (i >= 0) this.anchors.splice(i, 1);
    }
    for (const p of [this.bark, this.tips, this.stems, this.caps, this.crystals, this.tufts]) p.clear(c.slot);
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
    const c: WildChunk = { cx, cz, slot, colliders: [], anchors: [] };
    this.chunks.set(`${cx},${cz}`, c);
    const pools = [this.bark, this.tips, this.stems, this.caps, this.crystals, this.tufts];
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
        const b = field.biomeAt(x, z);
        const y = t.heightAt(x, z);
        const slope = t.slopeAt(x, z);
        const roll = rng.next();
        if (b.biome === Biome.Forest) {
          if (roll < 0.26 * b.core + 0.04 && slope < 0.7) this.tree(c, CANOPY_TREE, x, y, z, rng, rng.range(0.85, 1.35), new THREE.Color(0x4a2f7a), accA, accB);
          else if (roll < 0.24) this.tree(c, FERN_BUSH, x, y, z, rng, rng.range(0.8, 1.4), new THREE.Color(0x1f6b55), accA, accB, false);
          this.tuftPatch(slot, x, z, rng, 5, accA, accB);
        } else if (b.biome === Biome.Meadow) {
          if (roll < 0.06 && slope < 0.45) this.fairyRing(c, x, z, rng, accA, accB, first);
          else if (roll < 0.22) this.mushroom(slot, x, y, z, rng.range(0.6, 2.2), rng, accA, accB);
          this.tuftPatch(slot, x, z, rng, 8, accA, accB);
        } else if (b.biome === Biome.Crystal) {
          if (roll < 0.22) this.outcrop(c, x, y, z, rng, accB, first && roll < 0.05);
          else if (roll < 0.3) this.tuftPatch(slot, x, z, rng, 3, accA, accB);
        } else {
          // Null blight: withered thorn trees and red shards
          if (roll < 0.1 * b.core + 0.02) this.tree(c, BLIGHT_TREE, x, y, z, rng, rng.range(0.9, 1.3), new THREE.Color(0x150c18), new THREE.Color(0x7a0024), new THREE.Color(0x9a1240));
          else if (roll < 0.35) this.thorns(slot, x, y, z, rng);
        }
      }
    }
    for (const p of pools) p.end(slot);

    // mycelial cords
    const segs = growHyphae(cx, cz, CHUNK, this.seed, this.veinPer);
    this.writeVeins(slot, segs.filter((s) => this.wildAt(s.x0, s.z0) && this.wildAt(s.x1, s.z1)).map((s) => {
      const bl = t.blightAt(s.x0, s.z0);
      return { ...s, kind: bl > 0.3 ? 2 : s.kind };
    }));
    this.built++;
  }

  private writeVeins(slot: number, segs: { x0: number; z0: number; x1: number; z1: number; kind: number }[]) {
    const t = this.terrain;
    const base = slot * this.veinPer * 2;
    for (let k = 0; k < this.veinPer; k++) {
      const v = (base + k * 2) * 3;
      const s = segs[k];
      if (!s) {
        this.veinPos.fill(0, v, v + 6);
        continue;
      }
      this.veinPos[v] = s.x0;
      this.veinPos[v + 1] = t.heightAt(s.x0, s.z0) + 0.1;
      this.veinPos[v + 2] = s.z0;
      this.veinPos[v + 3] = s.x1;
      this.veinPos[v + 4] = t.heightAt(s.x1, s.z1) + 0.1;
      this.veinPos[v + 5] = s.z1;
      this.veinKind[base + k * 2] = this.veinKind[base + k * 2 + 1] = s.kind;
    }
    const pos = this.veins.geometry.attributes.position as THREE.BufferAttribute;
    const kind = this.veins.geometry.attributes.aKind as THREE.BufferAttribute;
    pos.addUpdateRange(base * 3, this.veinPer * 6);
    kind.addUpdateRange(base, this.veinPer * 2);
    pos.needsUpdate = kind.needsUpdate = true;
  }

  private tree(c: WildChunk, sp: Species, x: number, y: number, z: number, rng: Rng, scale: number, trunk: THREE.Color, budA: THREE.Color, budB: THREE.Color, solid = true) {
    const slot = c.slot;
    let top = y;
    interpret(sp, new THREE.Vector3(x, y - 0.3, z), rng, scale, (s) => {
      _q.setFromUnitVectors(UP, s.dir);
      _o.position.copy(s.a);
      _o.quaternion.copy(_q);
      _o.scale.set(s.radius, s.len, s.radius);
      _o.updateMatrix();
      _c.copy(trunk).lerp(budA, Math.min(1, s.depth / 7) * 0.45);
      this.bark.add(slot, _o.matrix, _c);
      top = Math.max(top, s.a.y + s.dir.y * s.len);
    }, (l) => {
      if (l.depth < (sp === BLIGHT_TREE ? 3 : 2) || (sp === BLIGHT_TREE && rng.chance(0.5))) return;
      _m.compose(l.p, _q.identity(), _o.scale.setScalar(rng.range(0.6, 1.2) * Math.min(scale, 1.2)));
      _c.copy(rng.chance(0.7) ? budA : budB).multiplyScalar(rng.range(1.0, 1.7));
      this.tips.add(slot, _m, _c);
    });
    if (solid) {
      c.colliders.push(this.physics.addPillar(x, z, sp.radius * scale * 0.9 + 0.2, top - y + 1));
      if (sp === CANOPY_TREE && top - y > 9) {
        const a: TetherAnchor = { pos: new THREE.Vector3(x, top - 2.5, z), label: 'Canopy crown' };
        c.anchors.push(a);
        this.anchors.push(a);
      }
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

  /** Quartz outcrop: prisms fanned on the golden angle, tilting outward. */
  private outcrop(c: WildChunk, x: number, y: number, z: number, rng: Rng, col: THREE.Color, cache: boolean) {
    const n = rng.int(5, 13);
    const big = rng.range(1, 2.6);
    for (let k = 0; k < n; k++) {
      const p = vogel(k, 0.35 * big);
      const tilt = k === 0 ? 0 : 0.25 + 0.5 * (p.r / (0.35 * big * Math.sqrt(n)));
      _o.position.set(x + p.x, y - 0.2, z + p.z);
      _o.rotation.set(Math.sin(p.a) * tilt, rng.range(0, TAU), -Math.cos(p.a) * tilt);
      const s = big * (k === 0 ? 1.7 : rng.range(0.6, 1.2));
      _o.scale.set(s, s * rng.range(2.2, 3.6), s);
      _o.updateMatrix();
      this.crystals.add(c.slot, _o.matrix, _c.copy(col).multiplyScalar(rng.range(0.6, 1.1)));
    }
    c.colliders.push(this.physics.addPillar(x, z, 0.5 * big + 0.3, big * 4));
    if (cache) this.pickups.push({ x: x + 1.6, y: y + 0.9, z: z + 1.6, kind: 'res' });
  }

  private thorns(slot: number, x: number, y: number, z: number, rng: Rng) {
    const n = rng.int(3, 7);
    for (let k = 0; k < n; k++) {
      const p = vogel(k, 0.5);
      _o.position.set(x + p.x, y - 0.1, z + p.z);
      _o.rotation.set(rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5));
      const s = rng.range(0.5, 1.1);
      _o.scale.set(s * 0.5, s * rng.range(1.5, 3), s * 0.5);
      _o.updateMatrix();
      this.crystals.add(slot, _o.matrix, _c.setRGB(0.55, 0.02, 0.12));
    }
  }

  private tuftPatch(slot: number, x: number, z: number, rng: Rng, n: number, a: THREE.Color, b: THREE.Color) {
    const t = this.terrain;
    for (let k = 0; k < n; k++) {
      const px = x + rng.range(-3, 3);
      const pz = z + rng.range(-3, 3);
      if (!this.wildAt(px, pz)) continue;
      _o.position.set(px, t.heightAt(px, pz) - 0.05, pz);
      _o.rotation.set(rng.range(-0.2, 0.2), rng.range(0, TAU), rng.range(-0.2, 0.2));
      _o.scale.set(rng.range(0.6, 1.2), rng.range(0.35, 1.1), rng.range(0.6, 1.2));
      _o.updateMatrix();
      this.tufts.add(slot, _o.matrix, _c.copy(rng.chance(0.65) ? a : b).multiplyScalar(rng.range(0.25, 0.55)));
    }
  }

  dispose() {
    for (const c of this.chunks.values()) for (const col of c.colliders) this.physics.removeCollider(col);
    for (const p of [this.bark, this.tips, this.stems, this.caps, this.crystals, this.tufts]) p.dispose();
    this.veins.geometry.dispose();
    (this.veins.material as THREE.Material).dispose();
  }
}
