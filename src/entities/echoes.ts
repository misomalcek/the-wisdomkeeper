import * as THREE from 'three';
import type { Affinity } from '../types';
import type { Terrain } from '../world/terrain';
import { clamp, easeOutBack } from '../util/math';
import { occlusionFade } from '../world/occlusion';

export const AFFINITY_COLOR: Record<Affinity, number> = { root: 0x7cff6b, echo: 0xb084ff, flow: 0x4fd8ff };

export interface Echo {
  x: number;
  y: number;
  z: number;
  affinity: Affinity;
  born: number;
  scale: number;
  /** Sentinel Blooms are temporary and shoot regardless of tier. */
  ttl?: number;
  sentinel: boolean;
  shootCD: number;
  grown: boolean;
}

const MAX = 300;
const GROW = 2.4;
const _o = new THREE.Object3D();
const _c = new THREE.Color();

/** Echo-trees: where the player acted, the world answers with a tree. */
export class EchoGrove {
  readonly group = new THREE.Group();
  readonly echoes: Echo[] = [];
  private trunk: THREE.InstancedMesh;
  private crown: THREE.InstancedMesh;
  private time = 0;

  constructor(private terrain: Terrain) {
    this.trunk = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.3, 1, 7).translate(0, 0.5, 0),
      occlusionFade(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 })),
      MAX,
    );
    this.crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), occlusionFade(new THREE.MeshBasicMaterial()), MAX);
    for (const m of [this.trunk, this.crown]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
      this.group.add(m);
    }
  }

  get permanentCount() {
    return this.echoes.filter((e) => !e.sentinel).length;
  }

  plant(x: number, z: number, affinity: Affinity, opts: { sentinel?: boolean; ttl?: number; grown?: boolean; scale?: number } = {}): Echo | null {
    if (this.echoes.length >= MAX) {
      // recycle the oldest non-sentinel
      const idx = this.echoes.findIndex((e) => !e.sentinel);
      if (idx < 0) return null;
      this.echoes.splice(idx, 1);
    }
    const e: Echo = {
      x, z,
      y: this.terrain.heightAt(x, z),
      affinity,
      born: this.time - (opts.grown ? GROW : 0),
      scale: opts.scale ?? 0.9 + Math.random() * 0.5,
      ttl: opts.ttl,
      sentinel: !!opts.sentinel,
      shootCD: 0.5,
      grown: !!opts.grown,
    };
    this.echoes.push(e);
    return e;
  }

  update(dt: number) {
    this.time += dt;
    for (let i = this.echoes.length - 1; i >= 0; i--) {
      const e = this.echoes[i];
      if (e.ttl !== undefined) {
        e.ttl -= dt;
        if (e.ttl <= -0.6) this.echoes.splice(i, 1);
      }
    }
    const n = this.echoes.length;
    this.trunk.count = this.crown.count = n;
    for (let i = 0; i < n; i++) {
      const e = this.echoes[i];
      const age = this.time - e.born;
      let g = easeOutBack(clamp(age / GROW, 0, 1));
      if (e.ttl !== undefined && e.ttl < 0) g *= clamp(1 + e.ttl / 0.6, 0, 1);
      g = Math.max(g, 0.001);
      const h = e.sentinel ? 2.4 : 4.2;
      _o.rotation.set(0, i * 1.7, 0);
      _o.position.set(e.x, e.y, e.z);
      _o.scale.set(g * e.scale, g * e.scale * h, g * e.scale);
      _o.updateMatrix();
      this.trunk.setMatrixAt(i, _o.matrix);
      _c.set(0x5a4380);
      this.trunk.setColorAt(i, _c);

      const sway = Math.sin(this.time * 1.2 + i) * 0.06;
      _o.position.y = e.y + g * e.scale * h * 0.95;
      const k = g * e.scale;
      if (e.affinity === 'root') _o.scale.set(k * 0.95, k * 0.55, k * 0.95);
      else if (e.affinity === 'echo') _o.scale.set(k * 0.5, k * 1.05, k * 0.5);
      else _o.scale.set(k * 0.72, k * 0.72, k * 0.72);
      _o.rotation.set(sway, this.time * 0.4 + i, sway);
      _o.updateMatrix();
      this.crown.setMatrixAt(i, _o.matrix);
      _c.set(AFFINITY_COLOR[e.affinity]).multiplyScalar(e.sentinel ? 1.8 : 1.0 + 0.2 * Math.sin(this.time * 2 + i));
      this.crown.setColorAt(i, _c);
    }
    this.trunk.instanceMatrix.needsUpdate = this.crown.instanceMatrix.needsUpdate = true;
    if (this.trunk.instanceColor) this.trunk.instanceColor.needsUpdate = true;
    if (this.crown.instanceColor) this.crown.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.trunk.geometry.dispose();
    (this.trunk.material as THREE.Material).dispose();
    this.crown.geometry.dispose();
    (this.crown.material as THREE.Material).dispose();
    this.trunk.dispose();
    this.crown.dispose();
  }
}
