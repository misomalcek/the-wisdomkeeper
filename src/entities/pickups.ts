import * as THREE from 'three';
import type { Game } from '../game';
import type { Item } from '../types';
import { RARITY } from '../systems/progress';

export type PickupKind = 'heal' | 'res' | 'gear';
interface Pickup {
  kind: PickupKind;
  x: number; z: number; y: number;
  vx: number; vz: number;
  life: number;
  phase: number;
  item?: Item;
  color?: THREE.Color;
}

const MAX = 90;
const _o = new THREE.Object3D();
const COL = {
  heal: new THREE.Color(0x7cff6b).multiplyScalar(2.6),
  res: new THREE.Color(0x4fb4ff).multiplyScalar(2.8),
};

export class Pickups {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  private items: Pickup[] = [];

  constructor() {
    this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.34, 0), new THREE.MeshBasicMaterial(), MAX);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.beams = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.12, 0.5, 14, 8, 1, true).translate(0, 7, 0),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      MAX,
    );
    this.beams.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.group.add(this.mesh, this.beams);
  }

  drop(x: number, z: number, kind: 'heal' | 'res') {
    this.push({ kind, x, z, y: 0, vx: (Math.random() - 0.5) * 8, vz: (Math.random() - 0.5) * 8, life: 24, phase: Math.random() * 6 });
  }

  dropGear(x: number, z: number, item: Item) {
    const col = new THREE.Color(RARITY[item.rarity].color).multiplyScalar(item.rarity === 'common' ? 1.5 : 2.6);
    this.push({ kind: 'gear', x, z, y: 0, vx: (Math.random() - 0.5) * 4, vz: (Math.random() - 0.5) * 4, life: 90, phase: Math.random() * 6, item, color: col });
  }

  private push(p: Pickup) {
    if (this.items.length >= MAX) this.items.shift();
    this.items.push(p);
  }

  clear() {
    this.items.length = 0;
  }

  update(game: Game, dt: number) {
    const p = game.player;
    const terrain = game.world.terrain;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      it.vx *= Math.max(0, 1 - 3 * dt);
      it.vz *= Math.max(0, 1 - 3 * dt);
      const dx = p.x - it.x;
      const dz = p.z - it.z;
      const dy = p.cy - it.y;
      const d = Math.hypot(dx, dz, dy);
      const magnet = it.kind === 'gear' ? 4 : 7;
      if (d < magnet && !p.dead) {
        const pull = (1 - d / magnet) * 40 + 6;
        it.vx += (dx / d) * pull * dt;
        it.vz += (dz / d) * pull * dt;
      }
      it.x += it.vx * dt;
      it.z += it.vz * dt;
      it.y = terrain.heightAt(it.x, it.z) + 0.9 + Math.sin(game.time * 3 + it.phase) * 0.15;
      if (d < 1.5 && !p.dead) {
        game.collect(it.kind, it.item);
        this.items.splice(i, 1);
        continue;
      }
      if (it.life <= 0) this.items.splice(i, 1);
    }
    let n = 0;
    let b = 0;
    for (const it of this.items) {
      _o.position.set(it.x, it.y, it.z);
      _o.rotation.set(game.time * 2 + it.phase, game.time * 3, 0);
      const fade = it.life < 3 ? (Math.sin(game.time * 20) > 0 ? 1 : 0.3) : 1;
      _o.scale.setScalar(fade * (it.kind === 'gear' ? 1.5 : 1));
      _o.updateMatrix();
      this.mesh.setMatrixAt(n, _o.matrix);
      this.mesh.setColorAt(n, it.color ?? COL[it.kind as 'heal' | 'res']);
      n++;
      if (it.kind === 'gear' && it.item && it.item.rarity !== 'common') {
        _o.position.set(it.x, it.y - 0.8, it.z);
        _o.rotation.set(0, 0, 0);
        _o.scale.set(1, 1, 1);
        _o.updateMatrix();
        this.beams.setMatrixAt(b, _o.matrix);
        this.beams.setColorAt(b, it.color!);
        b++;
      }
    }
    this.mesh.count = n;
    this.beams.count = b;
    this.mesh.instanceMatrix.needsUpdate = this.beams.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.beams.instanceColor) this.beams.instanceColor.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.mesh, this.beams]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}
