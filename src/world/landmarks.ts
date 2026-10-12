import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Terrain } from './terrain';
import type { Physics } from '../physics/physics';
import type { Palette } from '../story/strata';
import { FORMATIONS } from './gen/meshgen/fractals';
import { formKey } from './gen/meshgen/index';
import { protoArrays, protoGeometry, whenProtos } from './protos';
import { formationMaterial } from '../engine/surfaces';
import { occlusionFade } from './occlusion';
import type { GroundSample } from './gen/shape';
import { Biome } from './gen/field';

/** Landmark lattice cell (m) and how many cells out from the hero's are kept (5×5 ≈ 1.9 km across). */
const CELL = 380;
const RING = 2;
const PER = (2 * RING + 1) ** 2;
/** Formations nearer than this use the fine mesh and get a collider. */
const NEAR = 320;

interface Site {
  key: string;
  form: number;
  x: number;
  z: number;
  m: THREE.Matrix4;
  col: RAPIER.Collider | null;
}

const _gs: GroundSample = { h: 0, river: 0, blight: 0, biome: Biome.Meadow, core: 0, wild: 0, isleSd: 1e4, rock: 0, strata: 0, sand: 0, ero: 0 };
const _v = new THREE.Vector3();

/**
 * Fractal landmarks of the Wilds: about half the cells of a 380 m lattice raise a formation meshed from a true 3D
 * fractal (gen/meshgen/fractals): Mandelbulbs over basins and dune seas, Menger-sponge ruins in the canyonlands,
 * Julia-bulb towers on the ranges. 22–50 m tall, sunk into the ground, solid (trimesh colliders) when the hero is near,
 * and seen from far off over the horizon haze. Deterministic per world seed.
 */
export class Landmarks {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[][] = [];
  private sites = new Map<string, Site>();
  private lastX = 1e9;
  private lastZ = 1e9;

  constructor(
    private terrain: Terrain,
    private physics: Physics,
    pal: Palette,
    private seed: number,
  ) {
    const mat = occlusionFade(formationMaterial(pal.accent, pal.accent2, pal.groundHigh));
    for (let f = 0; f < FORMATIONS.length; f++) {
      const row: THREE.InstancedMesh[] = [];
      for (let l = 0; l < 2; l++) {
        const m = new THREE.InstancedMesh(new THREE.BufferGeometry(), mat, PER);
        m.count = 0;
        m.visible = false;
        m.frustumCulled = false;
        m.castShadow = l === 0;
        m.receiveShadow = true;
        this.group.add(m);
        row.push(m);
      }
      this.meshes.push(row);
    }
    whenProtos(() => {
      if (this.disposed) return;
      this.meshes.forEach((row, f) => row.forEach((m, l) => (m.geometry = protoGeometry(formKey(f, l)) ?? m.geometry)));
      this.lastX = 1e9; // rebuild instances and colliders now the meshes exist
    }, 1);
  }

  private hash(i: number, j: number, k: number) {
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1) ^ this.seed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  }

  /** The formation a lattice cell raises, or null. */
  private site(i: number, j: number): Site | null {
    if (this.hash(i, j, 1) > 0.5) return null;
    const x = (i + 0.2 + 0.6 * this.hash(i, j, 2)) * CELL;
    const z = (j + 0.2 + 0.6 * this.hash(i, j, 3)) * CELL;
    const t = this.terrain;
    if (Math.hypot(x, z) < t.radius * 2.6 || t.wildness(x, z) < 0.5 || t.riverAt(x, z) > 0.05) return null;
    t.shape.sample(x, z, _gs);
    const pick = this.hash(i, j, 4) < 0.5 ? 0 : 1;
    // the land chooses the fractal: canyonlands raise Menger ruins, ranges Julia towers, open ground Mandelbulbs
    const kind = _gs.strata > 0.35 ? 2 : _gs.rock > 0.35 ? 4 : _gs.sand > 0.35 ? 0 : [0, 2, 4][Math.floor(this.hash(i, j, 5) * 3)];
    const form = kind + pick;
    const H = 22 + 28 * this.hash(i, j, 6);
    const proto = FORMATIONS[form];
    // sink it to the lowest ground under its footprint so it never floats on a slope
    const r = H * (proto.kind === 'menger' ? 0.6 : 0.45);
    let y = t.heightAt(x, z);
    for (let k = 0; k < 6; k++) y = Math.min(y, t.heightAt(x + Math.cos(k) * r, z + Math.sin(k) * r));
    y -= H * (proto.kind === 'menger' ? 0.12 : 0.08);
    const m = new THREE.Matrix4().compose(
      _v.set(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.hash(i, j, 7) * Math.PI * 2),
      new THREE.Vector3(H, H, H),
    );
    return { key: `${i},${j}`, form, x, z, m, col: null };
  }

  update(x: number, z: number) {
    if (Math.hypot(x - this.lastX, z - this.lastZ) < 40) return;
    this.lastX = x;
    this.lastZ = z;
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    const keep = new Set<string>();
    for (let j = cj - RING; j <= cj + RING; j++) {
      for (let i = ci - RING; i <= ci + RING; i++) {
        const k = `${i},${j}`;
        keep.add(k);
        if (!this.sites.has(k)) {
          const s = this.site(i, j);
          if (s) this.sites.set(k, s);
        }
      }
    }
    for (const [k, s] of this.sites) {
      if (!keep.has(k)) {
        if (s.col) this.physics.removeCollider(s.col);
        this.sites.delete(k);
      }
    }
    for (const row of this.meshes) for (const m of row) m.count = 0;
    for (const s of this.sites.values()) {
      const near = Math.hypot(s.x - x, s.z - z) < NEAR;
      const m = this.meshes[s.form][near ? 0 : 1];
      m.setMatrixAt(m.count++, s.m);
      if (near && !s.col) s.col = this.collider(s);
      else if (!near && s.col) {
        this.physics.removeCollider(s.col);
        s.col = null;
      }
    }
    for (const row of this.meshes) {
      for (const m of row) {
        m.visible = m.count > 0 && !!m.geometry.attributes.position;
        m.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** A trimesh collider from the coarse mesh, in world space. */
  private collider(s: Site) {
    const a = protoArrays(formKey(s.form, 1));
    if (!a) return null;
    const v = new Float32Array(a.pos.length);
    for (let k = 0; k < v.length; k += 3) {
      _v.set(a.pos[k], a.pos[k + 1], a.pos[k + 2]).applyMatrix4(s.m);
      v[k] = _v.x;
      v[k + 1] = _v.y;
      v[k + 2] = _v.z;
    }
    return this.physics.addFixed(RAPIER.ColliderDesc.trimesh(v, new Uint32Array(a.idx)));
  }

  /** Formations in view (debug / shots). */
  get placed() {
    return [...this.sites.values()].map((s) => ({ x: s.x, z: s.z, form: s.form }));
  }

  private disposed = false;
  dispose() {
    this.disposed = true;
    for (const s of this.sites.values()) if (s.col) this.physics.removeCollider(s.col);
    for (const row of this.meshes) for (const m of row) m.dispose();
    (this.meshes[0][0].material as THREE.Material).dispose();
  }
}
