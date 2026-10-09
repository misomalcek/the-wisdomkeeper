import * as THREE from 'three';
import { standard, selfLit, fresnel } from '../engine/materials';
import { diffuseColor } from 'three/tsl';
import type { Rng } from '../util/rng';
import type { Palette } from '../story/strata';
import type { Terrain } from './terrain';
import { TAU } from '../util/math';
import { occlusionFade } from './occlusion';
import { LAYER, RAPIER, groups, type Physics, type Stepper } from '../physics/physics';
import { Debris } from '../physics/debris';

interface Crystal {
  x: number;
  y: number;
  z: number;
  r: number;
  hp: number;
  alive: boolean;
  collider: RAPIER.Collider;
  first: number;
  count: number;
}

interface Pod {
  body: RAPIER.RigidBody;
  alive: boolean;
  r: number;
  hp: number;
}

export interface PropHit {
  crystals: { x: number; y: number; z: number }[];
  pods: { x: number; y: number; z: number }[];
}

const _o = new THREE.Object3D();
const _c = new THREE.Color();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * Physical props: breakable Void-crystal clusters (fixed bodies that shatter into dynamic shards) and
 * glowing spore pods (dynamic spheres the hero can shove, kick and burst for Mycelial Fiber).
 */
export class Props implements Stepper {
  readonly group = new THREE.Group();
  readonly debris: Debris;
  private crystals: Crystal[] = [];
  private pods: Pod[] = [];
  private crystalMesh: THREE.InstancedMesh;
  private podMesh: THREE.InstancedMesh;
  private disposables: { dispose(): void }[] = [];
  private crystalCol: THREE.Color;
  private podCol: THREE.Color;
  private podPulse = 0;

  constructor(private physics: Physics, terrain: Terrain, rng: Rng, pal: Palette, crystalSites: { x: number; z: number }[], podSites: { x: number; z: number }[]) {
    this.debris = new Debris(physics);
    this.group.add(this.debris.group);
    this.crystalCol = new THREE.Color(pal.accent2).lerp(new THREE.Color(0x6fd8ff), 0.45);
    this.podCol = new THREE.Color(pal.accent).lerp(new THREE.Color(0xc2ff7a), 0.3);

    // ---- crystal clusters: 5-9 hexagonal prisms fanning out of one root
    const prism = new THREE.CylinderGeometry(0.16, 0.22, 1, 6, 1).translate(0, 0.5, 0);
    const tip = new THREE.ConeGeometry(0.16, 0.36, 6, 1).translate(0, 1.18, 0);
    const pos = [prism, tip].map((g) => g.toNonIndexed());
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(pos[0].attributes.position.count * 3 + pos[1].attributes.position.count * 3);
    arr.set(pos[0].attributes.position.array as Float32Array, 0);
    arr.set(pos[1].attributes.position.array as Float32Array, pos[0].attributes.position.count * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    [prism, tip, ...pos].forEach((g) => g.dispose());
    const cmat = selfLit(0.9, { roughness: 0.12, metalness: 0.15 });
    occlusionFade(cmat);
    this.disposables.push(geo, cmat);
    const prisms: { x: number; y: number; z: number; s: number; q: THREE.Quaternion }[] = [];
    for (const s of crystalSites) {
      const y = terrain.heightAt(s.x, s.z) - 0.15;
      const n = 5 + Math.floor(rng.range(0, 5));
      const first = prisms.length;
      const big = rng.range(0.9, 1.5);
      for (let i = 0; i < n; i++) {
        const a = rng.range(0, TAU);
        const tilt = i === 0 ? 0 : rng.range(0.25, 0.8);
        _e.set(Math.cos(a) * tilt, rng.range(0, TAU), Math.sin(a) * tilt);
        const q = new THREE.Quaternion().setFromEuler(_e);
        prisms.push({ x: s.x + Math.cos(a) * rng.range(0, 0.4), y, z: s.z + Math.sin(a) * rng.range(0, 0.4), s: big * (i === 0 ? 1.9 : rng.range(0.8, 1.5)), q });
      }
      const r = 0.9 * big;
      const collider = physics.addFixed(RAPIER.ColliderDesc.cylinder(1.1 * big, r).setTranslation(s.x, y + 1.1 * big, s.z), LAYER.static);
      this.crystals.push({ x: s.x, y, z: s.z, r, hp: 60 * big, alive: true, collider, first, count: n });
    }
    this.crystalMesh = new THREE.InstancedMesh(geo, cmat, Math.max(1, prisms.length));
    this.crystalMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, prisms.length) * 3), 3);
    prisms.forEach((p, i) => {
      _o.position.set(p.x, p.y, p.z);
      _o.quaternion.copy(p.q);
      _o.scale.set(p.s, p.s * 1.6, p.s);
      _o.updateMatrix();
      this.crystalMesh.setMatrixAt(i, _o.matrix);
      this.crystalMesh.setColorAt(i, _c.copy(this.crystalCol).multiplyScalar(0.6 + (i % 4) * 0.12));
    });
    this.crystalMesh.count = prisms.length;

    // ---- spore pods
    const podGeo = new THREE.IcosahedronGeometry(1, 2);
    const pp = podGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pp.count; i++) {
      // lobed, slightly pear-shaped
      const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
      const lobe = 1 + 0.08 * Math.sin(Math.atan2(z, x) * 6) * (1 - Math.abs(y));
      pp.setXYZ(i, x * lobe, y * (y > 0 ? 1.1 : 0.9), z * lobe);
    }
    podGeo.computeVertexNormals();
    const pmat = standard({ roughness: 0.35, metalness: 0, transparent: true, opacity: 0.94 });
    pmat.emissiveNode = diffuseColor.rgb.mul(fresnel(2).mul(1.6).add(0.55));
    this.disposables.push(podGeo, pmat);
    this.podMesh = new THREE.InstancedMesh(podGeo, pmat, Math.max(1, podSites.length));
    this.podMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, podSites.length) * 3), 3);
    for (const s of podSites) {
      const r = rng.range(0.38, 0.6);
      const y = terrain.heightAt(s.x, s.z) + r + 0.05;
      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(s.x, y, s.z).setLinearDamping(0.6).setAngularDamping(1.2).setCanSleep(true),
      );
      physics.world.createCollider(
        RAPIER.ColliderDesc.ball(r).setDensity(0.35).setRestitution(0.55).setFriction(0.7).setCollisionGroups(groups(LAYER.pod)),
        body,
      );
      body.sleep();
      this.pods.push({ body, alive: true, r, hp: 1 });
    }
    this.podMesh.count = this.pods.length;
    for (const m of [this.crystalMesh, this.podMesh]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.sync();
    physics.addStepper(this);
  }

  get podCount() {
    return this.pods.filter((p) => p.alive).length;
  }
  get crystalCount() {
    return this.crystals.filter((c) => c.alive).length;
  }

  /** Positions of live pods (for AI, tests and the minimap). */
  podPositions() {
    return this.pods.filter((p) => p.alive).map((p) => p.body.translation());
  }

  /**
   * Area impact from an attack: shoves pods and debris, cracks crystals. Returns what broke so the game can
   * drop loot and play effects.
   */
  strike(x: number, y: number, z: number, radius: number, damage: number, push: number, dirX = 0, dirZ = 0): PropHit {
    const out: PropHit = { crystals: [], pods: [] };
    for (const c of this.crystals) {
      if (!c.alive) continue;
      const d = Math.hypot(c.x - x, c.z - z) - c.r;
      if (d > radius || y < c.y - 2 || y > c.y + 4) continue;
      c.hp -= damage;
      if (c.hp <= 0) {
        this.shatter(c, dirX, dirZ);
        out.crystals.push({ x: c.x, y: c.y + 1, z: c.z });
      } else {
        this.debris.burst('shard', c.x + (x - c.x) * 0.4, c.y + 1.0, c.z + (z - c.z) * 0.4, 2, 4, this.crystalCol, 0.5);
      }
    }
    for (const p of this.pods) {
      if (!p.alive) continue;
      const t = p.body.translation();
      const dx = t.x - x;
      const dz = t.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius + p.r || Math.abs(t.y - y) > radius + 1.5) continue;
      if (damage >= 30 && d < radius * 0.6 + p.r) {
        this.burstPod(p);
        out.pods.push({ x: t.x, y: t.y, z: t.z });
        continue;
      }
      const k = push * p.body.mass();
      const nx = d > 1e-3 ? dx / d : dirX;
      const nz = d > 1e-3 ? dz / d : dirZ;
      p.body.applyImpulse({ x: (nx * 0.7 + dirX * 0.5) * k, y: k * 0.45, z: (nz * 0.7 + dirZ * 0.5) * k }, true);
    }
    this.debris.impulse(x, y, z, radius + 1, push * 0.6);
    return out;
  }

  private shatter(c: Crystal, dirX: number, dirZ: number) {
    c.alive = false;
    this.physics.world.removeCollider(c.collider, true);
    _o.scale.setScalar(0);
    _o.updateMatrix();
    for (let i = 0; i < c.count; i++) this.crystalMesh.setMatrixAt(c.first + i, _o.matrix);
    this.crystalMesh.instanceMatrix.needsUpdate = true;
    this.debris.burst('shard', c.x, c.y + 0.8, c.z, 14 + c.count * 2, 7, this.crystalCol, 1.4, dirX * 0.3, dirZ * 0.3);
    this.debris.burst('rubble', c.x, c.y + 0.3, c.z, 5, 4, _c.set(0x2a2f3a), 1);
  }

  private burstPod(p: Pod) {
    p.alive = false;
    const t = p.body.translation();
    this.physics.world.removeRigidBody(p.body);
    this.debris.burst('rubble', t.x, t.y, t.z, 4, 3, this.podCol, 0.8);
  }

  pre() {
    // pods that roll into the void are recycled
    for (const p of this.pods) if (p.alive && p.body.translation().y < -50) this.burstPod(p);
  }

  update(t: number) {
    this.podPulse = t;
  }

  sync() {
    this.pods.forEach((p, i) => {
      if (!p.alive) {
        _o.scale.setScalar(0);
      } else {
        const t = p.body.translation();
        const q = p.body.rotation();
        _o.position.set(t.x, t.y, t.z);
        _o.quaternion.copy(_q.set(q.x, q.y, q.z, q.w));
        _o.scale.setScalar(p.r * (1 + Math.sin(this.podPulse * 3 + i) * 0.03));
      }
      _o.updateMatrix();
      this.podMesh.setMatrixAt(i, _o.matrix);
      this.podMesh.setColorAt(i, _c.copy(this.podCol).multiplyScalar(0.7 + 0.25 * Math.sin(this.podPulse * 2 + i * 1.3)));
    });
    this.podMesh.instanceMatrix.needsUpdate = true;
    if (this.podMesh.instanceColor) this.podMesh.instanceColor.needsUpdate = true;
    if (this.crystalMesh.instanceColor) this.crystalMesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.debris.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.crystalMesh.dispose();
    this.podMesh.dispose();
  }
}
