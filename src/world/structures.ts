import * as THREE from 'three';
import { MeshBasicNodeMaterial, LineBasicNodeMaterial } from 'three/webgpu';
import { glowBasic, standard, glowLine, glow, worldTime, type N } from '../engine/materials';
import { Fn, uniform, uv, float, vec2, vec3, abs, max, dot, sin, exp, clamp, mix, smoothstep } from 'three/tsl';
import type { Palette } from '../story/strata';
import type { Terrain } from './terrain';
import { damp } from '../util/math';
import { ContactPad } from './contact';
import { barkMaterial, stoneMaterial } from '../engine/surfaces';

const hdr = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

/** The fractal Threshold: nested rings that echo themselves at 0.62× scale, around a kaleidoscopic fold. */
export class FractalGate {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  private rings: THREE.Mesh[] = [];
  private discMat: MeshBasicNodeMaterial;
  private discOpen: N = uniform(0);
  private beam: THREE.Mesh;
  private beamMat: MeshBasicNodeMaterial;
  private ringMats: MeshBasicNodeMaterial[] = [];
  open = 0;
  wantOpen = false;
  radius = 3.4;

  constructor(palette: Palette, terrain: Terrain, x: number, z: number, faceTo: THREE.Vector3) {
    const y = terrain.heightAt(x, z);
    this.pos.set(x, y, z);
    this.group.position.set(x, y + this.radius + 0.4, z);
    const a = new THREE.Color(palette.accent);
    const b = new THREE.Color(palette.accent2);
    for (let i = 0; i < 7; i++) {
      const s = Math.pow(0.66, i);
      const geo = new THREE.TorusGeometry(this.radius * s, 0.13 * Math.pow(0.8, i), 8, 64);
      const mat = glowBasic({ color: a.clone().lerp(b, i / 6).multiplyScalar(1.4 + (i % 2) * 0.8) });
      this.ringMats.push(mat);
      const m = new THREE.Mesh(geo, mat);
      m.userData.spin = (i % 2 ? 1 : -1) * (0.3 + i * 0.22);
      m.rotation.x = i * 0.35;
      this.rings.push(m);
      this.group.add(m);
    }
    // kaleidoscopic fold (6 iterations of the Kali set), bright when open, bruised red when sealed
    const dA: N = uniform(a.clone().multiplyScalar(2));
    const dB: N = uniform(b.clone().multiplyScalar(2));
    const p: N = uv().sub(0.5).mul(2);
    const r = p.length();
    const kali = Fn(() => {
      const q = p.mul(1.4).toVar();
      const v = float(0).toVar();
      for (let i = 0; i < 6; i++) {
        q.assign(abs(q).div(max(dot(q, q), 0.12)).sub(vec2(sin(worldTime.mul(0.3)).mul(0.05).add(0.85), 0.7)));
        v.addAssign(exp(q.length().mul(-1.6)));
      }
      return v;
    });
    const v: N = kali();
    const vv = clamp(v.mul(0.55), 0, 1.6);
    const openC = mix(dA, dB, vv).mul(vv.add(0.5));
    const shut = vec3(0.5, 0.05, 0.12).mul(vv.mul(0.3).add(0.25));
    const discMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    discMat.colorNode = mix(shut, openC, this.discOpen);
    discMat.opacityNode = smoothstep(1, 0.8, r).mul(mix(float(0.28), float(0.85), this.discOpen));
    discMat.maskNode = r.lessThanEqual(1);
    this.discMat = glow(discMat);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(this.radius * 0.96, 48), this.discMat);
    this.group.add(disc);
    this.beamMat = glowBasic({ color: hdr(palette.accent, 1.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 1.2, 70, 12, 1, true), this.beamMat);
    // Group origin sits radius+0.4 above ground; the beam rises from the ground.
    this.beam.position.set(0, 35 - this.radius - 0.4, 0);
    this.group.add(this.beam);
    this.group.lookAt(faceTo.x, this.group.position.y, faceTo.z);
  }

  setOpen(v: boolean) {
    this.wantOpen = v;
  }

  update(dt: number, t: number) {
    this.open = damp(this.open, this.wantOpen ? 1 : 0, 2.2, dt);
    this.discOpen.value = this.open;
    const speed = 0.4 + this.open * 1.4;
    for (const r of this.rings) r.rotation.z += r.userData.spin * dt * speed;
    this.rings.forEach((r, i) => (r.rotation.y = Math.sin(t * 0.4 + i) * 0.25));
    this.beamMat.opacity = this.open * (0.18 + 0.06 * Math.sin(t * 3));
    // dim rings when locked
    const k = 0.35 + this.open * 0.65;
    this.ringMats.forEach((m, i) => m.color.setScalar(k * (1.2 + (i % 2) * 0.5)));
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
    this.discMat.dispose();
    this.beamMat.dispose();
    this.ringMats.forEach((m) => m.dispose());
  }
}

export type NodeState = 'dormant' | 'active' | 'done';

/** A Memory Node: a crystal that sings when woken, summons the Static, then blooms. */
export class MemoryNode {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly zoneRadius = 14;
  state: NodeState = 'dormant';
  index: number;
  private crystal: THREE.Mesh;
  private crystalMat: MeshBasicNodeMaterial;
  private shards: THREE.Mesh[] = [];
  private shardMat: MeshBasicNodeMaterial;
  private zone: THREE.Line;
  private zoneMat: LineBasicNodeMaterial;
  private baseRing: THREE.Mesh;
  private ringMat: MeshBasicNodeMaterial;
  private cDormant: THREE.Color;
  private cActive: THREE.Color;
  private cDone: THREE.Color;
  private cur = new THREE.Color();
  /** Act IV: the node is a Resonance Contact pad instead of a crystal. */
  readonly pad: ContactPad | null = null;

  constructor(palette: Palette, terrain: Terrain, x: number, z: number, index: number, golden = false, contact = false) {
    this.index = index;
    const y = terrain.heightAt(x, z);
    this.pos.set(x, y, z);
    this.group.position.set(x, y, z);
    this.cDormant = new THREE.Color(palette.accent).multiplyScalar(golden ? 1.4 : 0.4);
    this.cActive = new THREE.Color(palette.accent2).multiplyScalar(2.4);
    this.cDone = new THREE.Color(palette.accent).multiplyScalar(2.2);
    this.crystalMat = glowBasic({ color: this.cDormant.clone() });
    this.crystal = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), this.crystalMat);
    this.crystal.scale.set(1.35, 3.4, 1.35);
    this.crystal.position.y = 5.0;
    this.group.add(this.crystal);
    this.shardMat = glowBasic({ color: this.cDormant.clone() });
    const sg = new THREE.OctahedronGeometry(0.42, 0);
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(sg, this.shardMat);
      this.shards.push(s);
      this.group.add(s);
    }
    this.ringMat = glowBasic({ color: this.cDormant.clone(), transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    this.baseRing = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.0, 40).rotateX(-Math.PI / 2), this.ringMat);
    this.baseRing.position.y = 0.3;
    this.group.add(this.baseRing);
    // stem
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.65, 3.4, 7).translate(0, 1.7, 0),
      Object.assign(stoneMaterial(palette.accent, { metalness: 0.7, roughness: 0.4, scale: 0.8, inlay: 0.7 }), { color: new THREE.Color(0x24343c) }),
    );
    this.group.add(stem);
    if (contact) {
      // the vision's Contacts burn cyan: dim while dormant, bright while linking, steady once linked
      this.cDormant.set(palette.accent).multiplyScalar(0.5);
      this.cActive.set(palette.accent).multiplyScalar(2.2);
      this.cDone.set(palette.accent).lerp(new THREE.Color(palette.accent2), 0.3).multiplyScalar(1.6);
      this.crystalMat.color.copy(this.cDormant);
      this.pad = new ContactPad(index + 1);
      this.group.add(this.pad.group);
      this.crystal.visible = stem.visible = this.baseRing.visible = false;
      this.shards.forEach((s) => (s.visible = false));
    }

    // Zone outline hugging the terrain
    const pts: number[] = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const px = Math.cos(a) * this.zoneRadius;
      const pz = Math.sin(a) * this.zoneRadius;
      pts.push(px, terrain.heightAt(x + px, z + pz) - y + 0.3, pz);
    }
    const zg = new THREE.BufferGeometry();
    pts.push(pts[0], pts[1], pts[2]); // close the loop (WebGPU has no LINE_LOOP)
    zg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.zoneMat = glowLine({ color: this.cActive.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.zone = new THREE.Line(zg, this.zoneMat);
    this.group.add(this.zone);
  }

  setState(s: NodeState) {
    this.state = s;
  }

  update(dt: number, t: number, camPos?: THREE.Vector3) {
    const target = this.state === 'dormant' ? this.cDormant : this.state === 'active' ? this.cActive : this.cDone;
    this.cur.copy(this.crystalMat.color).lerp(target, 1 - Math.exp(-4 * dt));
    this.crystalMat.color.copy(this.cur);
    if (this.pad) {
      this.pad.update(dt, t, this.cur, this.state === 'dormant' ? 0 : this.state === 'active' ? 1 : 0.8, camPos);
      this.zoneMat.opacity = damp(this.zoneMat.opacity, this.state === 'active' ? 0.75 : 0, 5, dt);
      return;
    }
    this.shardMat.color.copy(this.cur);
    this.ringMat.color.copy(this.cur);
    const spin = this.state === 'active' ? 3 : this.state === 'done' ? 1.2 : 0.5;
    this.crystal.rotation.y += dt * spin;
    this.crystal.position.y = 5.0 + Math.sin(t * 1.4 + this.index) * 0.35;
    this.shards.forEach((s, i) => {
      const a = t * (0.6 + spin * 0.3) + (i / this.shards.length) * Math.PI * 2;
      const r = 2.9 + (this.state === 'active' ? 0.9 * Math.sin(t * 5 + i) : 0);
      s.position.set(Math.cos(a) * r, 5.0 + Math.sin(a * 2 + i) * 1.3, Math.sin(a) * r);
      s.rotation.y = a;
    });
    this.zoneMat.opacity = damp(this.zoneMat.opacity, this.state === 'active' ? 0.75 : 0, 5, dt);
    const gs = this.state === 'active' ? 1.1 : this.state === 'done' ? 1 : 0.8;
    this.baseRing.scale.setScalar(gs + 0.08 * Math.sin(t * 3 + this.index));
  }

  dispose() {
    this.pad?.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (this.pad && o.parent && isUnder(o, this.pad.group)) return;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
  }
}

const isUnder = (o: THREE.Object3D, root: THREE.Object3D) => {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
  return false;
};

const ROOT_MAT_COLOR = 0x1a1a14;

/** Resonance Pylon: a lattice tower around a visible energy core. Purge it to unlock fast travel. */
export class Pylon {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly zoneRadius = 16;
  state: NodeState = 'dormant';
  index: number;
  private core: THREE.Mesh;
  private coreMat: MeshBasicNodeMaterial;
  private rings: THREE.Mesh[] = [];
  private ringMat: MeshBasicNodeMaterial;
  private zone: THREE.Line;
  private zoneMat: LineBasicNodeMaterial;
  private beam: THREE.Mesh;
  private beamMat: MeshBasicNodeMaterial;
  private cLock = new THREE.Color(0xff7a3b).multiplyScalar(1.1);
  private cActive = new THREE.Color();
  private cDone = new THREE.Color();
  private cur = new THREE.Color();
  private disposables: { dispose(): void }[] = [];

  constructor(palette: Palette, terrain: Terrain, x: number, z: number, index: number) {
    this.index = index;
    const y = terrain.heightAt(x, z);
    this.pos.set(x, y, z);
    this.group.position.set(x, y, z);
    this.cActive.set(palette.accent2).multiplyScalar(2.2);
    this.cDone.set(palette.accent).multiplyScalar(2.0);
    const track = <T extends { dispose(): void }>(d: T) => (this.disposables.push(d), d);

    const armor = track(stoneMaterial(palette.accent, { metalness: 0.5, roughness: 0.45, scale: 0.6 }));
    armor.color.set(0x24343e);
    const rootMat = track(barkMaterial({ roughness: 0.8 }));
    rootMat.color.set(ROOT_MAT_COLOR);
    this.coreMat = track(glowBasic({ color: this.cLock.clone() }));
    this.ringMat = track(glowBasic({ color: this.cLock.clone(), transparent: true, opacity: 0.9 }));

    // base plinth
    const plinth = new THREE.Mesh(track(new THREE.CylinderGeometry(3.2, 3.8, 0.9, 10)), armor);
    plinth.position.y = 0.3;
    this.group.add(plinth);
    // lattice of pillars around the core
    const pillarGeo = track(new THREE.BoxGeometry(0.42, 11, 0.42));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pil = new THREE.Mesh(pillarGeo, armor);
      pil.position.set(Math.cos(a) * 1.5, 5.8, Math.sin(a) * 1.5);
      pil.rotation.set(Math.sin(a) * 0.07, 0, -Math.cos(a) * 0.07);
      this.group.add(pil);
    }
    // data-stream conduits (thin emissive strips on the pillars)
    const stripGeo = track(new THREE.BoxGeometry(0.07, 10, 0.07));
    for (let i = 0; i < 6; i++) {
      const a = ((i + 0.5) / 6) * Math.PI * 2;
      const strip = new THREE.Mesh(stripGeo, this.ringMat);
      strip.position.set(Math.cos(a) * 1.72, 5.8, Math.sin(a) * 1.72);
      this.group.add(strip);
    }
    // the energy core
    this.core = new THREE.Mesh(track(new THREE.CylinderGeometry(0.55, 0.55, 8.5, 12)), this.coreMat);
    this.core.position.y = 5.8;
    this.group.add(this.core);
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(track(new THREE.TorusGeometry(2.3 - i * 0.2, 0.07, 6, 40)), this.ringMat);
      r.rotation.x = Math.PI / 2;
      r.position.y = 3.2 + i * 2.8;
      this.rings.push(r);
      this.group.add(r);
    }
    // crown
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const sp = new THREE.Mesh(track(new THREE.ConeGeometry(0.22, 2.2, 5)), armor);
      sp.position.set(Math.cos(a) * 1.6, 11.8, Math.sin(a) * 1.6);
      sp.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      this.group.add(sp);
    }
    const cap = new THREE.Mesh(track(new THREE.OctahedronGeometry(0.7, 0)), this.coreMat);
    cap.position.y = 12.6;
    this.group.add(cap);
    // roots wrapping the base
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      const pts = [
        new THREE.Vector3(Math.cos(a) * 1.7, 5 + (i % 3), Math.sin(a) * 1.7),
        new THREE.Vector3(Math.cos(a + 0.5) * 2.5, 2.4, Math.sin(a + 0.5) * 2.5),
        new THREE.Vector3(Math.cos(a + 0.9) * 4.2, 0.5, Math.sin(a + 0.9) * 4.2),
        new THREE.Vector3(Math.cos(a + 1.1) * 6.5, 0.05, Math.sin(a + 1.1) * 6.5),
      ];
      const root = new THREE.Mesh(track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 0.22 - (i % 3) * 0.04, 5, false)), rootMat);
      this.group.add(root);
    }
    // terrain-hugging zone outline
    const zp: number[] = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const px = Math.cos(a) * this.zoneRadius;
      const pz = Math.sin(a) * this.zoneRadius;
      zp.push(px, terrain.heightAt(x + px, z + pz) - y + 0.3, pz);
    }
    const zg = track(new THREE.BufferGeometry());
    zp.push(zp[0], zp[1], zp[2]); // close the loop (WebGPU has no LINE_LOOP)
    zg.setAttribute('position', new THREE.Float32BufferAttribute(zp, 3));
    this.zoneMat = track(glowLine({ color: this.cActive.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.zone = new THREE.Line(zg, this.zoneMat);
    this.group.add(this.zone);
    // light beam once purged
    this.beamMat = track(glowBasic({ color: this.cDone.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.beam = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3, 1.4, 90, 12, 1, true)), this.beamMat);
    this.beam.position.y = 45;
    this.group.add(this.beam);
  }

  setState(s: NodeState) {
    this.state = s;
  }

  update(dt: number, t: number) {
    const target = this.state === 'dormant' ? this.cLock : this.state === 'active' ? this.cActive : this.cDone;
    this.cur.copy(this.coreMat.color).lerp(target, 1 - Math.exp(-4 * dt));
    const pulse = this.state === 'active' ? 0.75 + 0.25 * Math.sin(t * 8) : 1;
    this.coreMat.color.copy(this.cur);
    this.ringMat.color.copy(this.cur).multiplyScalar(pulse);
    const spin = this.state === 'active' ? 3 : this.state === 'done' ? 1.1 : 0.3;
    this.rings.forEach((r, i) => {
      r.rotation.z += dt * spin * (i % 2 ? -1 : 1);
      r.rotation.x = Math.PI / 2 + Math.sin(t * 0.8 + i) * 0.12;
    });
    this.core.scale.set(1 + Math.sin(t * 3) * 0.05, 1, 1 + Math.sin(t * 3) * 0.05);
    this.zoneMat.opacity = damp(this.zoneMat.opacity, this.state === 'active' ? 0.75 : 0, 5, dt);
    this.beamMat.opacity = damp(this.beamMat.opacity, this.state === 'done' ? 0.16 + 0.05 * Math.sin(t * 2) : 0, 3, dt);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** A sealed spore pod that bursts into gear when opened. */
export class SporeCache {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  opened = false;
  private petals: THREE.Mesh[] = [];
  private glow: THREE.Mesh;
  private glowMat: MeshBasicNodeMaterial;
  private openT = 0;
  private disposables: { dispose(): void }[] = [];
  private seed = Math.random() * 6;

  constructor(palette: Palette, terrain: Terrain, x: number, z: number) {
    const y = terrain.heightAt(x, z);
    this.pos.set(x, y, z);
    this.group.position.set(x, y, z);
    const track = <T extends { dispose(): void }>(d: T) => (this.disposables.push(d), d);
    const shell = track(standard({ color: 0x1d3a2a, roughness: 0.5, metalness: 0.2, emissive: new THREE.Color(palette.accent), emissiveIntensity: 0.18 }));
    this.glowMat = track(glowBasic({ color: new THREE.Color(palette.accent2).multiplyScalar(2.2) }));
    const base = new THREE.Mesh(track(new THREE.SphereGeometry(0.9, 12, 8, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.65)), shell);
    base.position.y = 0.9;
    this.group.add(base);
    this.glow = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.5, 1)), this.glowMat);
    this.glow.position.y = 1.15;
    this.group.add(this.glow);
    const petalGeo = track(new THREE.ConeGeometry(0.4, 1.5, 5));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pet = new THREE.Mesh(petalGeo, shell);
      pet.userData.a = a;
      this.petals.push(pet);
      this.group.add(pet);
    }
    this.layout(0);
  }

  private layout(open: number) {
    this.petals.forEach((pet) => {
      const a = pet.userData.a as number;
      const lean = 0.25 + open * 1.1; // closed: leaning inward; open: splayed out
      pet.position.set(Math.cos(a) * (0.55 + open * 0.5), 1.55 - open * 0.55, Math.sin(a) * (0.55 + open * 0.5));
      pet.rotation.set(Math.sin(a) * lean, 0, -Math.cos(a) * lean);
    });
  }

  open() {
    this.opened = true;
  }

  update(dt: number, t: number) {
    if (this.opened && this.openT < 1) {
      this.openT = Math.min(1, this.openT + dt * 2.5);
      this.layout(this.openT);
    }
    this.glow.position.y = 1.15 + Math.sin(t * 2 + this.seed) * 0.08;
    this.glow.rotation.y += dt;
    const s = this.opened ? Math.max(0.2, 1 - this.openT * 0.8) : 1 + Math.sin(t * 3 + this.seed) * 0.12;
    this.glow.scale.setScalar(s);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
