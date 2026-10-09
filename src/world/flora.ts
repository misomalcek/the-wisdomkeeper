import * as THREE from 'three';
import type { Rng } from '../util/rng';
import type { StratumDef } from '../story/strata';
import type { Terrain } from './terrain';
import { TAU } from '../util/math';
import { occlusionFade } from './occlusion';
import type { Colliders } from './colliders';

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
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** Lit PBR surface that also glows in its own instance colour (emissive = albedo * k). */
function selfLit(k: number, extra: THREE.MeshStandardMaterialParameters = {}) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, ...extra });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\n totalEmissiveRadiance = diffuseColor.rgb * ${k.toFixed(2)};`,
    );
  };
  return m;
}

class Batch {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, max: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
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
  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, max: number) => {
    track(geo);
    track(occlusionFade(mat));
    const b = new Batch(geo, mat, max);
    batches.push(b);
    group.add(b.mesh);
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
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 }),
      mushroomCount,
    );
    const capGeo = new THREE.SphereGeometry(1, 12, 7, 0, TAU, 0, Math.PI / 2);
    const capMat = selfLit(0.5, { side: THREE.DoubleSide });
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

  // ---- silicon sprouts: thin wires with lit tips --------------------------------
  const sproutCount = def.flora === 'mirror' ? 0 : n(def.flora === 'seedbed' ? 160 : def.flora === 'canopy' ? 70 : 90);
  if (sproutCount) {
    const wire = mk(
      new THREE.CylinderGeometry(0.025, 0.05, 1, 4).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.1, roughness: 0.6 }),
      sproutCount,
    );
    const tip = mk(new THREE.OctahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial(), sproutCount);
    for (let i = 0; i < sproutCount; i++) {
      const p = spot(2, R * 1.02, 0.3);
      if (!p) continue;
      const h = rng.range(1.2, 4.2);
      wire.add(p, 0, new THREE.Vector3(1, h, 1), tmp.setHex(0x6aa5a0));
      const tp = p.clone();
      tp.y += h;
      tmp.copy(new THREE.Color(rng.chance(0.7) ? accentA : accentB)).multiplyScalar(rng.range(1.0, 1.7));
      tip.add(tp, 0, rng.range(0.7, 1.4), tmp);
    }
  }

  // ---- monoliths (cyber-stone with a lit seam) ---------------------------------
  const monoCount = def.flora === 'canopy' || def.flora === 'mirror' ? 0 : n(def.flora === 'seedbed' ? 14 : 9);
  if (monoCount) {
    const body = mk(
      new THREE.BoxGeometry(1.1, 1, 0.45).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.55, flatShading: true }),
      monoCount,
    );
    const seam = mk(new THREE.BoxGeometry(0.1, 1, 0.5).translate(0, 0.5, 0), new THREE.MeshBasicMaterial(), monoCount);
    for (let i = 0; i < monoCount; i++) {
      const p = spot(6, R * 0.98, 0.1);
      if (!p) continue;
      const h = rng.range(2.2, 6);
      const ry = rng.range(0, TAU);
      const s = new THREE.Vector3(rng.range(0.8, 1.4), h, 1);
      body.add(p, ry, s, tmp.setHex(0x5b7f8c));
      colliders.add(p.x, p.z, 0.95);
      const sp = p.clone();
      sp.y += 0.1;
      tmp.copy(new THREE.Color(accentA)).multiplyScalar(1.5);
      seam.add(sp, ry, new THREE.Vector3(1, h * 0.92, 1), tmp);
    }
  }

  // ---- reeds (river, return) ----------------------------------------------------
  const reedCount = def.flora === 'river' ? n(260) : def.flora === 'return' ? n(240) : 0;
  if (reedCount) {
    const reed = mk(
      new THREE.ConeGeometry(0.07, 1, 4).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.6 }),
      reedCount,
    );
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
      reed.add(p, 0, new THREE.Vector3(rng.range(0.8, 1.4), h, rng.range(0.8, 1.4)), tmp.set(def.flora === 'return' ? 0x9fd05a : 0x2f8f9a).multiplyScalar(rng.range(0.7, 1.3)), q);
    }
  }

  // ---- lily discs on the river --------------------------------------------------------
  if (def.flora === 'river') {
    const lilyN = n(80);
    const lily = mk(
      new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
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
    const tuft = mk(new THREE.ConeGeometry(0.1, 0.75, 4).translate(0, 0.37, 0), selfLit(0.45), tuftCount);
    for (let i = 0; i < tuftCount; i++) {
      const p = spot(2, R * 1.02, 0.2, 4);
      if (!p) continue;
      const base = new THREE.Color(rng.chance(0.65) ? accentA : accentB).multiplyScalar(rng.range(0.25, 0.55));
      tuft.add(p, rng.range(0, TAU), new THREE.Vector3(rng.range(0.7, 1.5), rng.range(0.6, 1.8), rng.range(0.7, 1.5)), base);
    }
  }

  // ---- fractal trees (canopy) + blackened Null-grove trees around enemy camps --------------------
  const UPv = UP;
  const branchesLive = def.flora === 'canopy' ? mk(new THREE.CylinderGeometry(0.62, 1, 1, 5).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 }), Math.round(16 * density * (R / 62) * (R / 62) * 0.7) * 170 + 400) : null;
  const tipsLive = def.flora === 'canopy' ? mk(new THREE.IcosahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial(), Math.round(16 * density * (R / 62) * (R / 62) * 0.7) * 90 + 200) : null;
  const deadN = groves.length * 8;
  const branchesDead = deadN ? mk(new THREE.CylinderGeometry(0.55, 1, 1, 5).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 }), deadN * 90) : null;
  const tipsDead = deadN ? mk(new THREE.OctahedronGeometry(0.22, 0), new THREE.MeshBasicMaterial(), deadN * 50) : null;

  const growTree = (
    base: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number, maxDepth: number,
    br: Batch, tp: Batch, trunk: THREE.Color, bud: THREE.Color, tipCols: number[], tipK: [number, number], spread: number,
  ) => {
    const end = base.clone().addScaledVector(dir, len);
    _q.setFromUnitVectors(UPv, dir);
    const k = 1 - depth / maxDepth;
    tmp.copy(trunk).lerp(bud, k * k * 0.55);
    br.add(base, 0, new THREE.Vector3(rad, len, rad), tmp, _q.clone());
    if (depth === 0) {
      const c = new THREE.Color(rng.pick(tipCols)).multiplyScalar(rng.range(tipK[0], tipK[1]));
      tp.add(end, 0, rng.range(0.7, 1.25), c);
      return;
    }
    const kids = depth >= maxDepth - 1 ? 3 : 2;
    for (let i = 0; i < kids; i++) {
      const axis = new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).cross(dir).normalize();
      const nd = dir.clone().applyAxisAngle(axis, rng.range(0.45, 0.85) * spread);
      nd.y += 0.18;
      nd.normalize();
      growTree(end, nd, len * rng.range(0.66, 0.8), rad * 0.62, depth - 1, maxDepth, br, tp, trunk, bud, tipCols, tipK, spread);
    }
  };

  if (branchesLive && tipsLive) {
    const treeCount = Math.round(16 * density * (R / 62) * (R / 62) * 0.7);
    const trunkCol = new THREE.Color(0x4a2f7a);
    const budCol = new THREE.Color(accentA);
    for (let t = 0; t < treeCount; t++) {
      const p = spot(9, R * 0.96, 0.1);
      if (!p) continue;
      const trunkLen = rng.range(5, 8.5);
      const lean = new THREE.Vector3(rng.range(-0.12, 0.12), 1, rng.range(-0.12, 0.12)).normalize();
      const rad = 0.55 + trunkLen * 0.05;
      growTree(p, lean, trunkLen, rad, 5, 5, branchesLive, tipsLive, trunkCol, budCol, [accentA, accentA, accentB], [1.1, 1.8], 1);
      colliders.add(p.x, p.z, rad * 0.95 + 0.25);
    }
  }
  if (branchesDead && tipsDead) {
    const trunkCol = new THREE.Color(0x1c1018);
    const budCol = new THREE.Color(0x4a1a2c);
    for (const gv of groves) {
      for (let t = 0; t < 8; t++) {
        const a = rng.range(0, TAU);
        const r = gv.r * rng.range(0.35, 0.95);
        const x = gv.x + Math.cos(a) * r;
        const z = gv.z + Math.sin(a) * r;
        if (terrain.riverAt(x, z) > 0.2 || Math.hypot(x, z) > R * 0.97) continue;
        const p = new THREE.Vector3(x, terrain.heightAt(x, z), z);
        const len = rng.range(3.5, 6.5);
        const lean = new THREE.Vector3(rng.range(-0.25, 0.25), 1, rng.range(-0.25, 0.25)).normalize();
        growTree(p, lean, len, 0.4 + len * 0.04, 4, 4, branchesDead, tipsDead, trunkCol, budCol, [0xff3b7a, 0xff7a3b], [1.1, 1.8], 1.25);
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
      new THREE.MeshStandardMaterial({ color: 0xbfd6ff, metalness: 1, roughness: 0.12, flatShading: true, emissive: 0x223355, emissiveIntensity: 0.9 }),
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
  const matUpdate = batches.map((b) => b.mesh.material).filter((m): m is THREE.MeshBasicMaterial => m instanceof THREE.MeshBasicMaterial);

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
