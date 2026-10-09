import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYER, RAPIER, groups, type Physics, type Stepper } from './physics';

type Kind = 'shard' | 'rubble';

interface Piece {
  kind: Kind;
  body: RAPIER.RigidBody;
  life: number;
  max: number;
  scale: number;
  color: THREE.Color;
  slot: number;
}

const MAX_SHARDS = 72;
const MAX_RUBBLE = 48;
const _o = new THREE.Object3D();
const _c = new THREE.Color();

function shardGeometry() {
  // a slim hexagonal crystal with a pointed tip, flat-shaded
  const tip = new THREE.ConeGeometry(0.11, 0.16, 6, 1).translate(0, 0.33, 0);
  const body = new THREE.CylinderGeometry(0.11, 0.09, 0.5, 6, 1);
  const out = mergeGeometries([body.toNonIndexed(), tip.toNonIndexed()])!;
  out.computeVertexNormals();
  body.dispose();
  tip.dispose();
  return out;
}

/**
 * Dynamic rigid-body debris (crystal shards, rubble). Pooled instanced meshes; bodies are created on demand,
 * live a few seconds, then shrink away. Rendering follows physics (one-way sync, per the engine deck).
 */
export class Debris implements Stepper {
  readonly group = new THREE.Group();
  private pieces: Piece[] = [];
  private shards: THREE.InstancedMesh;
  private rubble: THREE.InstancedMesh;
  private freeShard: number[] = [];
  private freeRubble: number[] = [];
  private disposables: { dispose(): void }[] = [];

  constructor(private physics: Physics) {
    const shardGeo = shardGeometry();
    const rubbleGeo = new THREE.DodecahedronGeometry(0.22, 0);
    const shardMat = new THREE.MeshStandardMaterial({ roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.92 });
    shardMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n totalEmissiveRadiance = diffuseColor.rgb * 1.4;`,
      );
    };
    const rubbleMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    this.disposables.push(shardGeo, rubbleGeo, shardMat, rubbleMat);
    this.shards = new THREE.InstancedMesh(shardGeo, shardMat, MAX_SHARDS);
    this.rubble = new THREE.InstancedMesh(rubbleGeo, rubbleMat, MAX_RUBBLE);
    for (const m of [this.shards, this.rubble]) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.count * 3), 3);
      m.frustumCulled = false;
      _o.scale.setScalar(0);
      _o.updateMatrix();
      for (let i = 0; i < m.count; i++) m.setMatrixAt(i, _o.matrix);
      this.group.add(m);
    }
    for (let i = MAX_SHARDS - 1; i >= 0; i--) this.freeShard.push(i);
    for (let i = MAX_RUBBLE - 1; i >= 0; i--) this.freeRubble.push(i);
    physics.addStepper(this);
  }

  get live() {
    return this.pieces.length;
  }

  /** Throw `n` pieces out of (x, y, z) with radial speed `force` (m/s) and an upward kick. */
  burst(kind: Kind, x: number, y: number, z: number, n: number, force: number, color: THREE.Color, scale = 1, dirX = 0, dirZ = 0) {
    for (let i = 0; i < n; i++) {
      const free = kind === 'shard' ? this.freeShard : this.freeRubble;
      if (!free.length) this.recycleOldest(kind);
      const slot = free.pop();
      if (slot === undefined) return;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.5;
      const s = scale * (0.7 + Math.random() * 0.7);
      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x + Math.cos(a) * r, y + Math.random() * 0.6, z + Math.sin(a) * r)
          .setRotation(randomQuat())
          .setLinvel(Math.cos(a) * force * (0.4 + Math.random() * 0.6) + dirX * force, force * (0.5 + Math.random() * 0.7), Math.sin(a) * force * (0.4 + Math.random() * 0.6) + dirZ * force)
          .setAngvel({ x: (Math.random() - 0.5) * 14, y: (Math.random() - 0.5) * 14, z: (Math.random() - 0.5) * 14 })
          .setLinearDamping(0.15)
          .setAngularDamping(0.4)
          .setCanSleep(true),
      );
      const desc = kind === 'shard' ? RAPIER.ColliderDesc.cuboid(0.09 * s, 0.3 * s, 0.09 * s) : RAPIER.ColliderDesc.ball(0.2 * s);
      // debris collides with the world and itself, not with the hero's capsule (keeps traversal clean)
      this.physics.world.createCollider(desc.setDensity(kind === 'shard' ? 1.2 : 2.2).setRestitution(0.25).setFriction(0.8).setCollisionGroups(groups(LAYER.debris, LAYER.terrain | LAYER.static | LAYER.platform | LAYER.debris | LAYER.pod)), body);
      const max = 5 + Math.random() * 3;
      this.pieces.push({ kind, body, life: max, max, scale: s, color: color.clone().multiplyScalar(0.8 + Math.random() * 0.4), slot });
    }
  }

  private recycleOldest(kind: Kind) {
    const i = this.pieces.findIndex((p) => p.kind === kind);
    if (i >= 0) this.remove(i);
  }

  private remove(i: number) {
    const p = this.pieces[i];
    this.physics.world.removeRigidBody(p.body);
    const mesh = p.kind === 'shard' ? this.shards : this.rubble;
    _o.scale.setScalar(0);
    _o.updateMatrix();
    mesh.setMatrixAt(p.slot, _o.matrix);
    (p.kind === 'shard' ? this.freeShard : this.freeRubble).push(p.slot);
    this.pieces.splice(i, 1);
  }

  pre(dt: number) {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.life -= dt;
      if (p.life <= 0 || p.body.translation().y < -60) this.remove(i);
    }
  }

  sync() {
    for (const p of this.pieces) {
      const t = p.body.translation();
      const q = p.body.rotation();
      _o.position.set(t.x, t.y, t.z);
      _o.quaternion.set(q.x, q.y, q.z, q.w);
      _o.scale.setScalar(p.scale * Math.min(1, p.life / 0.8));
      _o.updateMatrix();
      const mesh = p.kind === 'shard' ? this.shards : this.rubble;
      mesh.setMatrixAt(p.slot, _o.matrix);
      mesh.setColorAt(p.slot, _c.copy(p.color));
    }
    for (const m of [this.shards, this.rubble]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  /** Radial shove applied to loose debris near an impact. */
  impulse(x: number, y: number, z: number, radius: number, strength: number) {
    for (const p of this.pieces) {
      const t = p.body.translation();
      const dx = t.x - x;
      const dy = t.y - y;
      const dz = t.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius || d < 1e-3) continue;
      const k = (strength * (1 - d / radius) * p.body.mass()) / d;
      p.body.applyImpulse({ x: dx * k, y: Math.abs(dy) * k + strength * 0.3 * p.body.mass(), z: dz * k }, true);
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.shards.dispose();
    this.rubble.dispose();
    this.pieces = [];
  }
}

function randomQuat() {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}
