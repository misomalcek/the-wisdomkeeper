import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { glowBasic, standard, floraGlow } from '../engine/materials';
import type { NodeMaterial } from 'three/webgpu';
import type { Rng } from '../util/rng';
import type { StratumDef } from '../story/strata';
import type { Terrain } from './terrain';
import { TAU } from '../util/math';
import { occlusionFade } from './occlusion';
import type { Colliders } from './colliders';
import { capMaterial, stemMaterial, stoneMaterial, treeMaterial, tuftMaterial } from '../engine/surfaces';
import { loadProtos, protoGeometry, whenProtos } from './protos';
import { HOODOO_VARIANTS, TREE_VARIANTS, hoodooKey, treeKey, tuftKey } from './gen/meshgen/index';

export interface Avoid {
  x: number;
  z: number;
  r: number;
}

export interface Flora {
  group: THREE.Group;
  update(t: number): void;
  dispose(): void;
}

const _o = new THREE.Object3D();

class Batch {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, max: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  }
  add(pos: THREE.Vector3, rotY: number, scale: THREE.Vector3 | number, color: THREE.Color, quat?: THREE.Quaternion) {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    _o.position.copy(pos);
    if (quat) _o.quaternion.copy(quat);
    else _o.rotation.set(0, rotY, 0);
    if (typeof scale === 'number') _o.scale.setScalar(scale);
    else _o.scale.copy(scale);
    _o.updateMatrix();
    this.mesh.setMatrixAt(this.n, _o.matrix);
    this.mesh.setColorAt(this.n, color);
    this.n++;
  }
  done() {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0 && !!this.mesh.geometry.attributes.position;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export function buildFlora(def: StratumDef, terrain: Terrain, rng: Rng, density: number, avoid: Avoid[], colliders: Colliders, groves: Avoid[] = []): Flora {
  const group = new THREE.Group();
  const R = terrain.radius;
  const pal = def.palette;
  const batches: Batch[] = [];
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);
  const mk = (geo: THREE.BufferGeometry, mat: NodeMaterial, max: number) => {
    track(geo);
    track(occlusionFade(mat));
    const b = new Batch(geo, mat, max);
    batches.push(b);
    group.add(b.mesh);
    return b;
  };

  // generated prototypes (gen/meshgen): the batch draws nothing until the shared mesh lands from the worker
  loadProtos();
  const mkProto = (key: string, mat: NodeMaterial, max: number) => {
    track(occlusionFade(mat));
    const b = new Batch(new THREE.BufferGeometry(), mat, max);
    b.mesh.visible = false;
    batches.push(b);
    group.add(b.mesh);
    whenProtos(() => {
      const g = protoGeometry(key);
      if (!g) return;
      b.mesh.geometry = g;
      b.done();
    });
    return b;
  };

  const spot = (minR: number, maxR: number, riverMax = 0.15, tries = 12): THREE.Vector3 | null => {
    for (let i = 0; i < tries; i++) {
      const a = rng.range(0, TAU);
      const r = Math.sqrt(rng.range(minR * minR, maxR * maxR));
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (terrain.riverAt(x, z) > riverMax) continue;
      if (avoid.some((v) => (v.x - x) ** 2 + (v.z - z) ** 2 < v.r * v.r)) continue;
      return new THREE.Vector3(x, terrain.heightAt(x, z), z);
    }
    return null;
  };

  const n = (base: number) => Math.round(base * density * (R / 50) * (R / 50) * 0.6);
  const accentA = pal.accent;
  const accentB = pal.accent2;
  const tmp = new THREE.Color();

  // ---- mushrooms (all but the mirror) --------------------------------------
  const mushroomCount = def.flora === 'mirror' ? 0 : n(def.flora === 'return' ? 150 : 100);
  if (mushroomCount) {
    const stem = mk(
      new THREE.CylinderGeometry(0.12, 0.2, 1, 6).translate(0, 0.5, 0),
      stemMaterial(),
      mushroomCount,
    );
    const capGeo = new THREE.SphereGeometry(1, 12, 7, 0, TAU, 0, Math.PI / 2);
    const capMat = capMaterial(0.5);
    const cap = mk(capGeo, capMat, mushroomCount);
    for (let i = 0; i < mushroomCount; i++) {
      const p = spot(4, R * 1.02);
      if (!p) continue;
      const h = rng.range(0.6, 2.6) * (def.flora === 'canopy' ? 1.6 : 1);
      const w = rng.range(0.45, 1.3) * (h > 1.8 ? 1.2 : 1);
      stem.add(p, rng.range(0, TAU), new THREE.Vector3(1, h, 1), tmp.setHex(0xb4c8d0));
      const cp = p.clone();
      cp.y += h * 0.97;
      tmp.copy(new THREE.Color(accentA)).lerp(new THREE.Color(accentB), rng.next()).multiplyScalar(rng.range(0.8, 1.3));
      cap.add(cp, rng.range(0, TAU), new THREE.Vector3(w, w * 0.62, w), tmp);
    }
  }

  // ---- coral shrubs: low branching stems with luminous buds (generated, gen/meshgen/trees SHRUB) --------
  const sproutCount = def.flora === 'mirror' ? 0 : n(def.flora === 'seedbed' ? 110 : def.flora === 'canopy' ? 50 : 65);
  if (sproutCount) {
    const shrubMat = treeMaterial(0x2a6b62, accentA, accentB, 1.3);
    const shrubs = Array.from({ length: TREE_VARIANTS }, (_, v) => mkProto(treeKey('shrub', v, 0), shrubMat, sproutCount));
    for (let i = 0; i < sproutCount; i++) {
      const p = spot(2, R * 1.02, 0.3);
      if (!p) continue;
      p.y -= 0.1;
      rng.pick(shrubs).add(p, rng.range(0, TAU), rng.range(0.6, 1.5), tmp.setScalar(rng.range(0.8, 1.2)));
    }
  }

  // ---- monoliths (cyber-stone with a lit seam) ---------------------------------
  const monoCount = def.flora === 'canopy' || def.flora === 'mirror' ? 0 : n(def.flora === 'seedbed' ? 14 : 9);
  if (monoCount) {
    // eroded standing stones (generated hoodoos), their faces inlaid with lit fractal glyphs
    const stoneMat = stoneMaterial(accentA, { metalness: 0.15, roughness: 0.6 });
    const bodies = Array.from({ length: HOODOO_VARIANTS }, (_, v) => mkProto(hoodooKey(v, 0), stoneMat, monoCount));
    for (let i = 0; i < monoCount; i++) {
      const p = spot(6, R * 0.98, 0.1);
      if (!p) continue;
      const h = rng.range(0.7, 1.7);
      p.y -= 0.3;
      rng.pick(bodies).add(p, rng.range(0, TAU), new THREE.Vector3(h * rng.range(0.9, 1.3), h, h * rng.range(0.9, 1.3)), tmp.setHex(0x5b7f8c));
      colliders.add(p.x, p.z, 0.95);
    }
  }

  // ---- reeds (river, return) ----------------------------------------------------
  const reedCount = def.flora === 'river' ? n(260) : def.flora === 'return' ? n(240) : 0;
  if (reedCount) {
    const reed = mkProto(tuftKey(2), tuftMaterial(0.12, THREE.DoubleSide), reedCount);
    for (let i = 0; i < reedCount; i++) {
      // river reeds hug the banks
      let p: THREE.Vector3 | null = null;
      for (let k = 0; k < 14 && !p; k++) {
        const c = spot(2, R * 1.02, 0.95, 1);
        if (!c) continue;
        const rv = terrain.riverAt(c.x, c.z);
        if (def.flora !== 'river' || (rv > 0.02 && rv < 0.4)) p = c;
      }
      if (!p) continue;
      const h = rng.range(1.4, 3.6);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize(), rng.range(0, 0.25));
      reed.add(p, 0, new THREE.Vector3(rng.range(0.8, 1.4), h * 0.6, rng.range(0.8, 1.4)), tmp.set(def.flora === 'return' ? 0x9fd05a : 0x2f8f9a).multiplyScalar(rng.range(0.7, 1.3)), q);
    }
  }

  // ---- lily discs on the river --------------------------------------------------------
  if (def.flora === 'river') {
    const lilyN = n(80);
    const lily = mk(
      new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2),
      glowBasic({ side: THREE.DoubleSide }, floraGlow),
      lilyN,
    );
    for (let i = 0; i < lilyN; i++) {
      const x = rng.range(-R, R);
      const z = rng.range(-R, R);
      if (terrain.riverAt(x, z) < 0.35 || Math.hypot(x, z) > R) continue;
      const y = terrain.heightAt(x, z) + 0.2;
      tmp.copy(new THREE.Color(accentB)).multiplyScalar(rng.range(0.7, 1.2));
      lily.add(new THREE.Vector3(x, y, z), rng.range(0, TAU), rng.range(0.5, 1.2), tmp);
    }
  }

  // ---- ground tufts: eye-level detail everywhere --------------------------------------------
  const tuftCount = def.flora === 'mirror' ? 0 : n(def.flora === 'return' ? 900 : 650);
  if (tuftCount) {
    const tuft = mkProto(tuftKey(1), tuftMaterial(0.45, THREE.DoubleSide), tuftCount);
    for (let i = 0; i < tuftCount; i++) {
      const p = spot(2, R * 1.02, 0.2, 4);
      if (!p) continue;
      const base = new THREE.Color(rng.chance(0.65) ? accentA : accentB).multiplyScalar(rng.range(0.25, 0.55));
      tuft.add(p, rng.range(0, TAU), new THREE.Vector3(rng.range(0.7, 1.5), rng.range(0.6, 1.8), rng.range(0.7, 1.5)), base);
    }
  }

  // ---- generated trees (canopy) + blackened Null-grove trees around enemy camps ----------------------
  const treeCount = def.flora === 'canopy' ? Math.round(16 * density * (R / 62) * (R / 62) * 0.7) : 0;
  if (treeCount) {
    const canopyMat = treeMaterial(0x4a2f7a, accentA, accentB, 1.1);
    const spireMat = treeMaterial(0x2e2448, accentB, accentA, 0.9);
    const canopy = Array.from({ length: TREE_VARIANTS }, (_, v) => mkProto(treeKey('canopy', v, 0), canopyMat, treeCount));
    const spire = Array.from({ length: TREE_VARIANTS }, (_, v) => mkProto(treeKey('spire', v, 0), spireMat, treeCount));
    for (let t = 0; t < treeCount; t++) {
      const p = spot(9, R * 0.96, 0.1);
      if (!p) continue;
      const s = rng.range(0.9, 1.4);
      p.y -= 0.1;
      rng.pick(rng.chance(0.75) ? canopy : spire).add(p, rng.range(0, TAU), s, tmp.setScalar(rng.range(0.85, 1.15)));
      colliders.add(p.x, p.z, 0.45 * s + 0.25);
    }
  }
  if (groves.length) {
    const deadMat = treeMaterial(0x1c1018, 0xff3b7a, 0xff7a3b, 0.9, 0.9);
    const dead = Array.from({ length: TREE_VARIANTS }, (_, v) => mkProto(treeKey('blight', v, 0), deadMat, groves.length * 8));
    for (const gv of groves) {
      for (let t = 0; t < 8; t++) {
        const a = rng.range(0, TAU);
        const r = gv.r * rng.range(0.35, 0.95);
        const x = gv.x + Math.cos(a) * r;
        const z = gv.z + Math.sin(a) * r;
        if (terrain.riverAt(x, z) > 0.2 || Math.hypot(x, z) > R * 0.97) continue;
        if (avoid.some((v) => v.r >= 12 && (v.x - x) ** 2 + (v.z - z) ** 2 < v.r * v.r)) continue; // set-piece clearings
        rng.pick(dead).add(new THREE.Vector3(x, terrain.heightAt(x, z) - 0.1, z), rng.range(0, TAU), rng.range(0.9, 1.4), tmp.setScalar(rng.range(0.8, 1.1)));
        colliders.add(x, z, 0.65);
      }
    }
  }

  let shardMesh: THREE.InstancedMesh | undefined;
  const shardData: { base: THREE.Vector3; spin: number; phase: number; scale: number }[] = [];

  // ---- mirror shards (boss arena) ---------------------------------------------------------------
  if (def.flora === 'mirror') {
    const ringN = 46;
    const floatN = 70;
    const geo = track(new THREE.OctahedronGeometry(1, 0));
    const mat = track(
      standard({ color: 0xbfd6ff, metalness: 1, roughness: 0.12, flatShading: true, emissive: 0x223355, emissiveIntensity: 0.9 }),
    );
    shardMesh = new THREE.InstancedMesh(geo, mat, ringN + floatN);
    shardMesh.frustumCulled = false;
    shardMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((ringN + floatN) * 3), 3);
    for (let i = 0; i < ringN; i++) {
      const a = (i / ringN) * TAU + rng.range(-0.04, 0.04);
      const r = R * rng.range(1.0, 1.14);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const s = rng.range(2, 5.5);
      shardData.push({ base: new THREE.Vector3(x, terrain.heightAt(x, z) + s * 1.2, z), spin: 0, phase: rng.range(0, TAU), scale: s });
    }
    for (let i = 0; i < floatN; i++) {
      const a = rng.range(0, TAU);
      const r = R * Math.sqrt(rng.range(0.02, 1.05));
      const s = rng.range(0.4, 1.3);
      shardData.push({ base: new THREE.Vector3(Math.cos(a) * r, rng.range(4, 16), Math.sin(a) * r), spin: rng.range(0.2, 0.8) * rng.sign(), phase: rng.range(0, TAU), scale: s });
    }
    shardData.forEach((_s, i) => {
      tmp.copy(new THREE.Color(rng.chance(0.18) ? accentB : 0xdde8ff)).multiplyScalar(rng.range(0.6, 1.2));
      shardMesh!.setColorAt(i, tmp);
    });
    group.add(shardMesh);
  }

  batches.forEach((b) => b.done());
  const matUpdate = batches.map((b) => b.mesh.material).filter((m): m is MeshBasicNodeMaterial => m instanceof MeshBasicNodeMaterial);

  return {
    group,
    update(t: number) {
      const pulse = 1 + 0.15 * Math.sin(t * 1.6);
      for (const m of matUpdate) m.color.setScalar(pulse);
      if (shardMesh) {
        for (let i = 0; i < shardData.length; i++) {
          const s = shardData[i];
          _o.position.copy(s.base);
          if (s.spin === 0) {
            _o.rotation.set(0.1 * Math.sin(t * 0.3 + s.phase), s.phase, 0.12);
            _o.scale.set(s.scale * 0.55, s.scale * 1.6, s.scale * 0.55);
          } else {
            _o.position.y += Math.sin(t * 0.6 + s.phase) * 0.7;
            _o.rotation.set(t * s.spin, t * s.spin * 0.7 + s.phase, 0);
            _o.scale.setScalar(s.scale);
          }
          _o.updateMatrix();
          shardMesh.setMatrixAt(i, _o.matrix);
        }
        shardMesh.instanceMatrix.needsUpdate = true;
        if (shardMesh.instanceColor) shardMesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      batches.forEach((b) => b.mesh.dispose());
      shardMesh?.dispose();
    },
  };
}
