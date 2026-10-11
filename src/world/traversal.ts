import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { fbm2, floraGlow, glowBasic, proceduralBump, standard, type N } from '../engine/materials';
import { diffuseColor, normalWorld, clamp, positionLocal, atan, pow, abs, sin, float, smoothstep, vec3 } from 'three/tsl';
import type { Rng } from '../util/rng';
import type { Palette } from '../story/strata';
import type { Terrain } from './terrain';
import { GOLDEN_ANGLE, TAU } from '../util/math';
import { occlusionFade } from './occlusion';
import { LAYER, RAPIER, type Physics, type Stepper } from '../physics/physics';
import { stemMaterial, stoneMaterial } from '../engine/surfaces';

/** A point the Mycelial Tether can latch onto. `pos` is live (moving platforms update it). */
export interface TetherAnchor {
  pos: THREE.Vector3;
  label: string;
}

/** Tags carried by colliders the hero can stand on. */
export interface SurfaceTag {
  bounce?: number;
  platform?: DriftPlatform;
}

export interface Cap {
  x: number;
  y: number;
  z: number;
  r: number;
  bounce: boolean;
  crown: boolean;
  /** Explicit caps (tree shelves, bridges): false = no stalk, it grows out of something else. */
  stalk?: boolean;
}

const _o = new THREE.Object3D();
const _c = new THREE.Color();

/** Shelf-mushroom cap: domed top, gilled underside, all in one lathe (unit radius, top at y = 0). */
function capGeometry() {
  const pts: THREE.Vector2[] = [];
  const N = 14;
  // underside: from stalk out to the rim, slightly concave
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    pts.push(new THREE.Vector2(0.08 + t * 0.92, -0.32 + t * 0.2 - Math.sin(t * Math.PI) * 0.06));
  }
  // rim roll and dome
  for (let i = 1; i <= N; i++) {
    const a = (i / N) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.cos(a) * 1.0 + 0.0, -0.12 + Math.sin(a) * 0.12 - (1 - Math.cos(a)) * 0.0));
  }
  // flattened top toward the centre (walkable)
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector2(Math.max(0.001, 1 - t) * 0.92, 0.0 + Math.sin(t * Math.PI * 0.5) * 0.04));
  }
  const g = new THREE.LatheGeometry(pts, 40);
  // gills: radial ridges on the underside only
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    if (y < -0.13) {
      const a = Math.atan2(z, x);
      const r = Math.hypot(x, z);
      p.setY(i, y + Math.pow(Math.abs(Math.sin(a * 24)), 6) * 0.05 * r);
    }
  }
  g.computeVertexNormals();
  return g;
}

function stalkGeometry() {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    // flared root, slender neck, slight swell under the cap
    const r = 0.55 + Math.pow(1 - t, 4) * 0.7 + Math.sin(t * Math.PI) * 0.08 - t * 0.12;
    pts.push(new THREE.Vector2(r, t));
  }
  return new THREE.LatheGeometry(pts, 12);
}

/**
 * Giant shelf-mushroom stairs: each cluster spirals upward on the golden angle (phyllotaxis), so every cap is
 * a short jump from the previous one and the crown always sits above the stalk. Violet bounce caps launch the hero.
 */
export class MushroomGroves {
  readonly group = new THREE.Group();
  readonly caps: Cap[] = [];
  readonly anchors: TetherAnchor[] = [];
  /** Crown positions (fiber caches are placed here). */
  readonly crowns: THREE.Vector3[] = [];
  private capMesh: THREE.InstancedMesh;
  private stalkMesh: THREE.InstancedMesh;
  private rimMesh: THREE.InstancedMesh;
  private disposables: { dispose(): void }[] = [];
  private rimMat: MeshBasicNodeMaterial;

  constructor(terrain: Terrain, physics: Physics, rng: Rng, pal: Palette, sites: { x: number; z: number }[], extra: Cap[] = []) {
    const capGeo = capGeometry();
    const stalkGeo = stalkGeometry();
    const rimGeo = new THREE.TorusGeometry(1, 0.035, 6, 48).rotateX(Math.PI / 2);
    const capMat = standard({ roughness: 0.62, metalness: 0.05 });
    // soft bioluminescent underside: brighter where the surface faces down
    // veined, spotted cap skin: radial veins and soft spots, carved by procedural bump and glowing faintly
    const lp: N = positionLocal;
    const ang: N = atan(lp.z, lp.x);
    const rad: N = lp.xz.length();
    const veinsN: N = pow(abs(sin(ang.mul(13).add(fbm2(lp.xz.mul(3)).mul(5)))), float(10)).mul(smoothstep(0.15, 0.9, rad));
    const spots: N = smoothstep(0.62, 0.78, fbm2(lp.xz.mul(5.5)));
    capMat.normalNode = proceduralBump(veinsN.mul(0.5).add(spots.mul(0.7)).add(fbm2(lp.xz.mul(18)).mul(0.15)), 0.15);
    // instance colour multiplies this (NodeMaterial applies instanceColor on top of colorNode)
    capMat.colorNode = vec3(1, 1, 1).mul(float(1).sub(spots.mul(0.35))).mul(float(0.85).add(veinsN.mul(0.3)));
    capMat.emissiveNode = diffuseColor.rgb
      .mul(clamp(normalWorld.y.negate(), 0, 1).mul(0.9).add(0.1))
      .add(diffuseColor.rgb.mul(veinsN.mul(0.55).mul(floraGlow)));
    occlusionFade(capMat);
    const stalkMat = occlusionFade(stemMaterial());
    this.rimMat = glowBasic({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    this.disposables.push(capGeo, stalkGeo, rimGeo, capMat, stalkMat, this.rimMat);

    // ---- lay out the caps
    const stalks: { x: number; y: number; z: number; h: number; r: number; tint: number }[] = [];
    for (const s of sites) {
      const g0 = terrain.heightAt(s.x, s.z);
      const n = 4 + Math.floor(rng.range(0, 4));
      const spin = rng.range(0, TAU);
      for (let i = 0; i < n; i++) {
        const a = spin + i * GOLDEN_ANGLE;
        const d = 3.0 + i * 0.22;
        const x = s.x + Math.cos(a) * d;
        const z = s.z + Math.sin(a) * d;
        const gy = terrain.heightAt(x, z);
        const y = Math.max(g0, gy) + 1.55 + i * 1.6;
        const r = rng.range(1.45, 2.0);
        this.caps.push({ x, y, z, r, bounce: false, crown: false });
        stalks.push({ x, y: gy - 0.4, z, h: y - gy + 0.2, r: 0.14 + r * 0.05, tint: 0 });
      }
      // crown: the big cap over the central stalk
      const top = g0 + 1.55 + n * 1.6 + 0.4;
      const cr = rng.range(3.0, 3.8);
      this.caps.push({ x: s.x, y: top, z: s.z, r: cr, bounce: false, crown: true });
      stalks.push({ x: s.x, y: g0 - 0.6, z: s.z, h: top - g0 + 0.4, r: 0.55, tint: 1 });
      this.crowns.push(new THREE.Vector3(s.x, top + 0.2, s.z));
      this.anchors.push({ pos: new THREE.Vector3(s.x, top + 1.6, s.z), label: 'Crown cap' });
      // a bounce cap at the foot of the spiral
      const ba = spin - GOLDEN_ANGLE;
      const bx = s.x + Math.cos(ba) * 5.2;
      const bz = s.z + Math.sin(ba) * 5.2;
      const by = terrain.heightAt(bx, bz);
      this.caps.push({ x: bx, y: by + 0.75, z: bz, r: 1.25, bounce: true, crown: false });
      stalks.push({ x: bx, y: by - 0.3, z: bz, h: 1.0, r: 0.22, tint: 2 });
    }

    for (const c of extra) {
      this.caps.push(c);
      if (c.stalk) {
        const gy = terrain.heightAt(c.x, c.z);
        stalks.push({ x: c.x, y: gy - 0.4, z: c.z, h: c.y - gy + 0.2, r: 0.14 + c.r * 0.05, tint: 0 });
      }
      if (c.crown) this.crowns.push(new THREE.Vector3(c.x, c.y + 0.2, c.z));
    }

    const capCol = new THREE.Color(pal.accent2).lerp(new THREE.Color(0x9a6bd6), 0.4);
    const capCol2 = new THREE.Color(pal.accent).lerp(new THREE.Color(0x3f8f9a), 0.5);
    const bounceCol = new THREE.Color(0xd16bff);
    const stalkCol = new THREE.Color(pal.groundHigh).lerp(new THREE.Color(0xcfd8e8), 0.35);

    this.capMesh = new THREE.InstancedMesh(capGeo, capMat, this.caps.length);
    this.capMesh.castShadow = this.capMesh.receiveShadow = true;
    this.capMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.caps.length * 3), 3);
    this.rimMesh = new THREE.InstancedMesh(rimGeo, this.rimMat, this.caps.length);
    this.rimMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.caps.length * 3), 3);
    this.caps.forEach((c, i) => {
      const thick = c.crown ? 0.8 : 0.62;
      _o.position.set(c.x, c.y, c.z);
      _o.rotation.set(0, (i * 1.7) % TAU, 0);
      _o.scale.set(c.r, c.r * thick, c.r);
      _o.updateMatrix();
      this.capMesh.setMatrixAt(i, _o.matrix);
      _c.copy(c.bounce ? bounceCol : i % 3 === 0 ? capCol2 : capCol).multiplyScalar(c.bounce ? 0.8 : 0.55 + (i % 5) * 0.04);
      this.capMesh.setColorAt(i, _c);
      _o.position.y = c.y - 0.1 * c.r * thick;
      _o.scale.set(c.r * 0.98, 1, c.r * 0.98);
      _o.updateMatrix();
      this.rimMesh.setMatrixAt(i, _o.matrix);
      _c.copy(c.bounce ? bounceCol : new THREE.Color(pal.accent)).multiplyScalar(c.bounce ? 2.4 : 1.6);
      this.rimMesh.setColorAt(i, _c);

      // physics: a rounded disc the hero can land on
      const hh = 0.12 * c.r * thick + 0.05;
      const col = physics.addFixed(
        RAPIER.ColliderDesc.roundCylinder(hh, c.r * 0.93 - 0.08, 0.08)
          .setTranslation(c.x, c.y - hh + 0.02, c.z)
          .setFriction(1.0),
        LAYER.platform,
      );
      if (c.bounce) physics.tag(col, { bounce: 24 } satisfies SurfaceTag);
    });

    this.stalkMesh = new THREE.InstancedMesh(stalkGeo, stalkMat, stalks.length);
    this.stalkMesh.castShadow = true;
    this.stalkMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(stalks.length * 3), 3);
    stalks.forEach((s, i) => {
      _o.position.set(s.x, s.y, s.z);
      _o.rotation.set(0, i, 0);
      _o.scale.set(s.r, s.h, s.r);
      _o.updateMatrix();
      this.stalkMesh.setMatrixAt(i, _o.matrix);
      this.stalkMesh.setColorAt(i, _c.copy(stalkCol).multiplyScalar(s.tint === 1 ? 0.75 : 0.6));
      physics.addFixed(RAPIER.ColliderDesc.capsule(Math.max(0.05, s.h / 2 - s.r), s.r * 0.9).setTranslation(s.x, s.y + s.h / 2, s.z), LAYER.static);
    });

    for (const m of [this.capMesh, this.stalkMesh, this.rimMesh]) {
      m.frustumCulled = false;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.group.add(m);
    }
  }

  update(t: number) {
    this.rimMat.opacity = 0.7 + Math.sin(t * 1.7) * 0.15;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.capMesh.dispose();
    this.stalkMesh.dispose();
    this.rimMesh.dispose();
  }
}

/**
 * Drifting "resonance contact" slabs from the mockups: kinematic bodies on slow Lissajous loops.
 * They carry the hero (the controller adds their per-frame delta) and each holds a tether anchor.
 */
export class DriftPlatform implements Stepper {
  readonly group = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  readonly anchor: TetherAnchor;
  readonly pos = new THREE.Vector3();
  /** Displacement during the last rendered frame (to carry the hero). */
  readonly frameDelta = new THREE.Vector3();
  private prev = new THREE.Vector3();
  private next = new THREE.Vector3();
  private lastFrame = new THREE.Vector3();
  private core: THREE.Mesh;

  constructor(
    physics: Physics,
    private center: THREE.Vector3,
    private ax: number,
    private az: number,
    private ay: number,
    private speed: number,
    private phase: number,
    mats: { slab: THREE.Material; trim: THREE.Material; core: THREE.Material },
    geos: { slab: THREE.BufferGeometry; trim: THREE.BufferGeometry; core: THREE.BufferGeometry },
  ) {
    const slab = new THREE.Mesh(geos.slab, mats.slab);
    const trim = new THREE.Mesh(geos.trim, mats.trim);
    trim.position.y = -0.25;
    this.core = new THREE.Mesh(geos.core, mats.core);
    this.core.position.y = 0.55;
    this.group.add(slab, trim, this.core);
    this.at(0, this.next);
    this.prev.copy(this.next);
    this.pos.copy(this.next);
    this.lastFrame.copy(this.next);
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.next.x, this.next.y, this.next.z));
    const col = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(2.2, 0.28, 1.6).setTranslation(0, -0.05, 0).setCollisionGroups(((LAYER.platform & 0xffff) << 16) | 0xffff),
      this.body,
    );
    physics.tag(col, { platform: this } satisfies SurfaceTag);
    this.anchor = { pos: new THREE.Vector3(), label: 'Resonance contact' };
    physics.addStepper(this);
    this.sync(0);
  }

  private at(t: number, out: THREE.Vector3) {
    const a = t * this.speed + this.phase;
    return out.set(this.center.x + Math.sin(a) * this.ax, this.center.y + Math.sin(a * 2) * this.ay, this.center.z + Math.sin(a * 0.5 + 1.1) * this.az);
  }

  pre(_dt: number, t: number) {
    this.prev.copy(this.next);
    this.at(t, this.next);
    this.body.setNextKinematicTranslation({ x: this.next.x, y: this.next.y, z: this.next.z });
  }

  sync(alpha: number) {
    this.pos.lerpVectors(this.prev, this.next, alpha);
    this.frameDelta.subVectors(this.pos, this.lastFrame);
    this.lastFrame.copy(this.pos);
    this.group.position.copy(this.pos);
    this.anchor.pos.set(this.pos.x, this.pos.y + 1.4, this.pos.z);
    this.core.rotation.y += 0.02;
  }
}

export class DriftField {
  readonly group = new THREE.Group();
  readonly platforms: DriftPlatform[] = [];
  private disposables: { dispose(): void }[] = [];
  private coreMat: MeshBasicNodeMaterial;
  private base: THREE.Color;

  constructor(terrain: Terrain, physics: Physics, rng: Rng, pal: Palette, sites: { x: number; z: number }[]) {
    const slabGeo = new THREE.BoxGeometry(4.4, 0.5, 3.2, 1, 1, 1);
    // bevel-ish look: shrink the bottom face
    const p = slabGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setXYZ(i, p.getX(i) * 0.86, p.getY(i), p.getZ(i) * 0.82);
    slabGeo.computeVertexNormals();
    const trimGeo = new THREE.BoxGeometry(3.6, 0.08, 2.6);
    const coreGeo = new THREE.OctahedronGeometry(0.32, 0);
    const slabMat = stoneMaterial(pal.accent, { roughness: 0.45, metalness: 0.6, scale: 0.6 });
    slabMat.color.set(0x2a3042);
    const trimMat = glowBasic({ color: new THREE.Color(pal.accent).multiplyScalar(2.2) });
    this.base = new THREE.Color(pal.accent);
    this.coreMat = glowBasic({ color: this.base.clone().multiplyScalar(2.6) });
    this.disposables.push(slabGeo, trimGeo, coreGeo, slabMat, trimMat, this.coreMat);
    for (const s of sites) {
      const y = terrain.heightAt(s.x, s.z) + rng.range(6, 11);
      const plat = new DriftPlatform(
        physics,
        new THREE.Vector3(s.x, y, s.z),
        rng.range(5, 10),
        rng.range(4, 9),
        rng.range(0.6, 1.6),
        rng.range(0.18, 0.32),
        rng.range(0, TAU),
        { slab: slabMat, trim: trimMat, core: this.coreMat },
        { slab: slabGeo, trim: trimGeo, core: coreGeo },
      );
      this.platforms.push(plat);
      this.group.add(plat.group);
    }
  }

  get anchors() {
    return this.platforms.map((p) => p.anchor);
  }

  update(t: number) {
    const k = 2.2 + Math.sin(t * 2.4) * 0.5;
    this.coreMat.color.copy(this.base).multiplyScalar(k);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
