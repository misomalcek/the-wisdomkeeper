import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { glowBasic } from '../engine/materials';
import type { Skin } from '../types';
import { clamp } from '../util/math';
import { BONE, CREST_SEGS, CREST_STRANDS, LEG, applyLook, buildRig, heroGeometry, heroMaterial, heroTexturedMaterial, heroUniforms, rootBladeGeometry, type HeroLook } from '../assets/heroModel';
import { loadedModel } from '../assets/pipeline';
import { sculptMaterial } from '../assets/creatureMaterial';
import { uniform } from 'three/tsl';

export type MoveMode = 'ground' | 'air' | 'flight' | 'levitate';

/** Suit palettes: the Tripo reference (resonant) plus the Verdant and Void suits. */
export const SKIN_LOOK: Record<Skin, HeroLook> = {
  resonant: { body: 0x62b4dc, armor: 0x4a3a9e, vein: 0x4ff0ff, accent: 0x9ff3ff, dark: 0x1a2a3a, hue: 0 },
  verdant: { body: 0x7fc89a, armor: 0x2f6a44, vein: 0x8cff6b, accent: 0xd4ff8a, dark: 0x2a2416, hue: -0.75 },
  void: { body: 0x9a7ab8, armor: 0x3c1236, vein: 0xff3b7a, accent: 0xff8ab6, dark: 0x1a0c16, hue: 0.6 },
};

let spearCache: THREE.BufferGeometry | null = null;

/**
 * The sculpted spear from the hero GLB, re-gripped for play: it ships in grip space with the long staff up
 * (+Y) and the leaf blade below the hand, so it is flipped blade-up and scaled to a wieldable ~2 m, with the
 * hand a short way under the blade like the procedural Root-Blade.
 */
function sculptedSpear(src: THREE.BufferGeometry): THREE.BufferGeometry {
  if (spearCache) return spearCache;
  const g = src.clone().rotateZ(Math.PI);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const k = 1.95 / (bb.max.y - bb.min.y);
  g.scale(k, k, k).translate(0, 0.62 - bb.max.y * k, 0);
  g.computeBoundingSphere();
  return (spearCache = g);
}

export interface HeroPose {
  speed: number;
  maxSpeed: number;
  vy: number;
  mode: MoveMode;
  grounded: boolean;
  attack: { active: boolean; idx: number; t: number };
  aiming: boolean;
  dashing: boolean;
  hurt: number;
  dead: boolean;
  /** world-space velocity heading relative to facing, used to bank in flight */
  bank: number;
  /** Optional ground probe (world x, z → surface y) that enables foot planting by leg IK. */
  ground?: ((x: number, z: number) => number) | null;
}

export const idlePose = (): HeroPose => ({
  speed: 0, maxSpeed: 8.5, vy: 0, mode: 'ground', grounded: true, attack: { active: false, idx: 0, t: 0 },
  aiming: false, dashing: false, hurt: 0, dead: false, bank: 0,
});

const ease = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const _a = new THREE.Vector3();
const _t = new THREE.Vector3();

type JointKey =
  | 'bodyX' | 'bodyZ' | 'hipsY' | 'spX' | 'spY' | 'spZ' | 'headX' | 'headY'
  | 'thLx' | 'thRx' | 'thLz' | 'thRz' | 'knL' | 'knR'
  | 'shLx' | 'shLz' | 'shRx' | 'shRz' | 'elL' | 'elR';

const KEYS: JointKey[] = ['bodyX', 'bodyZ', 'hipsY', 'spX', 'spY', 'spZ', 'headX', 'headY', 'thLx', 'thRx', 'thLz', 'thRz', 'knL', 'knR', 'shLx', 'shLz', 'shRx', 'shRz', 'elL', 'elR'];

/**
 * The Wisdomkeeper: one sculpted SkinnedMesh (see assets/heroModel) driven by a procedural pose rig with
 * two-bone leg IK for foot planting, plus the Root-Blade and spore-bolter orb. ~2.05 units tall, forward = +Z.
 */
export class Hero {
  readonly root = new THREE.Group();
  private bones: THREE.Bone[];
  private mesh: THREE.SkinnedMesh;
  private grip = new THREE.Object3D();
  private blade: THREE.Mesh;
  private bolter: THREE.Mesh;
  private cur = {} as Record<JointKey, number>;
  private phase = 0;
  private time = 0;
  private held = false;
  private heldUntil = 0;
  private ikW = 0;
  private ikOff = [0, 0];
  private foot = [0, 0];
  private u = heroUniforms();
  private mat: ReturnType<typeof heroMaterial>;
  private glowMat: MeshBasicNodeMaterial;
  private disposables: { dispose(): void }[] = [];
  /** Bind height of the hips and per-leg bone lengths / rest angles (about X) for the IK solve. */
  private hipsRest = 0.98;
  /** Boot glow gain: lifts while levitating or flying. */
  private bootBoost = uniform(-0.55);
  private boots: THREE.SkinnedMesh | null = null;
  /** The boots wear a darker carapace than the suit, lit by its vein colour. */
  private bootU = { ...heroUniforms(), uT: this.u.uT, uHurt: this.u.uHurt };
  private leg = [{ l1: LEG.thigh, l2: LEG.shin, a0: 0, a1: 0 }, { l1: LEG.thigh, l2: LEG.shin, a0: 0, a1: 0 }];

  constructor(skin: Skin = 'resonant') {
    for (const k of KEYS) this.cur[k] = 0;
    // a GLB from the asset manifest replaces the sculpt when present (same rig names and sockets, its own
    // fitted bind pose, painted PBR maps and spear)
    const model = loadedModel('hero');
    const rig = buildRig(model?.layout);
    this.bones = rig.bones;
    this.mat = model ? heroTexturedMaterial(this.u, model) : heroMaterial(this.u);
    this.glowMat = glowBasic({ color: 0xffffff });
    this.disposables.push(this.mat, this.glowMat);
    const geo = model?.geometry ?? heroGeometry();
    this.hipsRest = this.bones[BONE.hips].position.y;
    for (const [i, th] of [BONE.thL, BONE.thR].entries()) {
      const kn = this.bones[th + 1].position, ft = this.bones[th + 2].position;
      this.leg[i] = { l1: kn.length(), l2: ft.length(), a0: Math.atan2(-kn.z, -kn.y), a1: Math.atan2(-ft.z, -ft.y) };
    }
    this.mesh = new THREE.SkinnedMesh(geo, this.mat);
    this.mesh.add(this.bones[BONE.body]);
    this.mesh.bind(rig.skeleton);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
    this.disposables.push(rig.skeleton);
    // the GLB hero ends below the knees; its mycelial boots complete the legs on the same skeleton
    const boots = model ? loadedModel('heroBoots')?.geometry : null;
    if (boots) {
      const bm = sculptMaterial(this.bootU, { mottle: 7, crackGlow: 0.35, rim: 0.2, boost: this.bootBoost, footfall: true });
      this.boots = new THREE.SkinnedMesh(boots, bm);
      this.boots.bind(rig.skeleton, this.mesh.bindMatrix);
      this.boots.castShadow = true;
      this.boots.frustumCulled = false;
      this.root.add(this.boots);
      this.disposables.push(bm);
    }

    this.grip.position.set(0, -0.06, 0.012);
    this.bones[BONE.hdR].add(this.grip);
    this.bolter = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 1), this.glowMat);
    this.disposables.push(this.bolter.geometry);
    this.bolter.visible = false;
    this.grip.add(this.bolter);
    const spear = model?.extras?.rootBlade;
    this.blade = new THREE.Mesh(spear ? sculptedSpear(spear) : rootBladeGeometry(), this.mat);
    this.blade.castShadow = true;
    this.setBlade(false);
    this.setSkin(skin);
  }

  /** Socket transforms named in the asset manifest (hand_r_root_blade, back_thruster_pack, head_antenna). */
  socket(name: string): THREE.Object3D | null {
    if (name === 'hand_r_root_blade') return this.grip;
    if (name === 'back_thruster_pack') return this.bones[BONE.chest];
    if (name === 'head_antenna') return this.bones[BONE.crest + Math.floor(CREST_STRANDS / 2) * CREST_SEGS + CREST_SEGS - 1];
    return null;
  }

  setSkin(skin: Skin) {
    const l = SKIN_LOOK[skin];
    applyLook(this.u, l);
    const mixD = (c: number, t: number) => new THREE.Color(0x141a24).lerp(new THREE.Color(c), t).getHex();
    applyLook(this.bootU, { body: mixD(l.body, 0.3), armor: mixD(l.armor, 0.15), vein: l.vein, accent: mixD(l.accent, 0.3), dark: 0x0a0e14 });
    this.glowMat.color.set(l.vein).multiplyScalar(2.2);
  }

  /** Put the blade in the right hand (true) or across the back (false). */
  private setBlade(held: boolean) {
    if (held === this.held && this.blade.parent) return;
    this.held = held;
    this.blade.removeFromParent();
    if (held) {
      this.grip.add(this.blade);
      this.blade.position.set(0, 0.2, 0.02);
      this.blade.rotation.set(Math.PI / 2 - 0.25, 0, 0);
    } else {
      this.bones[BONE.chest].add(this.blade);
      this.blade.position.set(0.02, 0.05, -0.22);
      this.blade.rotation.set(0.2, 0, 0.62);
    }
  }

  /** Keep the blade in hand regardless of combat (inventory portrait). */
  forceBlade(held: boolean) {
    this.heldUntil = held ? Infinity : 0;
  }

  handWorld(out: THREE.Vector3) {
    return this.grip.getWorldPosition(out);
  }

  update(dt: number, p: HeroPose) {
    this.time += dt;
    this.u.uT.value = this.time;
    this.u.uHurt.value = Math.max(0, p.hurt) * 0.8;
    const lift = p.mode === 'flight' ? 1.6 : p.mode === 'levitate' ? 0.9 : !p.grounded ? 0 : -0.55;
    this.bootBoost.value += (lift - this.bootBoost.value) * Math.min(1, dt * 6);
    const sp = clamp(p.speed / p.maxSpeed, 0, 1.4);
    const t: Record<JointKey, number> = {} as Record<JointKey, number>;
    for (const k of KEYS) t[k] = 0;

    const attacking = p.attack.active;
    if (attacking) this.heldUntil = this.time + 1.4;
    this.setBlade(attacking || this.time < this.heldUntil);
    this.bolter.visible = p.aiming && !attacking;
    if (this.bolter.visible) this.bolter.scale.setScalar(1 + 0.2 * Math.sin(this.time * 18));

    if (p.dead) {
      t.bodyX = -1.45;
      t.shLz = 0.9;
      t.shRz = -0.9;
    } else if (p.mode === 'flight') {
      t.bodyX = 1.2 - clamp(p.vy * 0.025, -0.35, 0.35);
      t.bodyZ = clamp(p.bank, -1, 1) * 0.5;
      t.headX = -0.95;
      t.spX = -0.15;
      t.thLx = 0.28; t.thRx = 0.18;
      t.knL = 0.35; t.knR = 0.2;
      t.shLx = 0.55; t.shRx = 0.5;
      t.shLz = 0.25; t.shRz = -0.25;
      t.elL = 0.2; t.elR = 0.2;
      if (p.aiming) {
        t.shRx = -1.2; t.shRz = -0.1; t.elR = 0.1;
      }
    } else if (p.mode === 'levitate') {
      t.hipsY = Math.sin(this.time * 2.2) * 0.04;
      t.spX = 0.06;
      t.shLz = 0.6; t.shRz = -0.6;
      t.shLx = 0.15; t.shRx = 0.15;
      t.elL = 0.3; t.elR = 0.3;
      t.thLz = 0.05; t.thRz = -0.05;
      t.thLx = 0.1; t.thRx = -0.05;
      t.knL = 0.1; t.knR = 0.18;
      t.bodyX = 0.1 + sp * 0.2;
      t.bodyZ = clamp(p.bank, -1, 1) * 0.25;
      t.headX = -0.1;
      if (p.aiming) {
        t.shRx = -1.45; t.shRz = -0.1; t.elR = 0.1;
      }
    } else if (!p.grounded) {
      t.thLx = -0.65; t.thRx = -0.1;
      t.knL = 0.95; t.knR = 0.35;
      t.shLz = 0.85; t.shRz = -0.85;
      t.shLx = -0.3; t.shRx = -0.3;
      t.elL = 0.4; t.elR = 0.4;
      t.bodyX = 0.08 + clamp(-p.vy * 0.02, -0.25, 0.3);
      t.spX = 0.05;
    } else {
      // grounded locomotion / idle
      if (sp > 0.04) this.phase += dt * (5.2 + sp * 5.8);
      const s = Math.sin(this.phase);
      const A = 0.95 * Math.min(sp, 1.15);
      const sg = Math.min(sp * 1.6, 1);
      t.thLx = s * A; t.thRx = -s * A;
      t.knL = Math.max(0, Math.sin(this.phase - 1.3)) * 1.25 * sg;
      t.knR = Math.max(0, Math.sin(this.phase + Math.PI - 1.3)) * 1.25 * sg;
      t.shLx = -s * A * 0.85; t.shRx = s * A * 0.85;
      t.elL = 0.25 + sp * 0.8; t.elR = 0.25 + sp * 0.8;
      t.shLz = 0.1; t.shRz = -0.1;
      t.spX = 0.05 + sp * 0.18 + Math.sin(this.time * 1.7) * 0.015 * (1 - sg);
      t.spY = -s * 0.22 * sg;
      t.hipsY = -Math.abs(Math.cos(this.phase)) * 0.045 * sg - 0.02 * (1 - sg) * (0.5 + 0.5 * Math.sin(this.time * 1.7));
      t.headX = -t.spX * 0.6;
      if (sg < 0.1) {
        t.shLz = 0.14 + Math.sin(this.time * 1.7) * 0.02;
        t.shRz = -0.14 - Math.sin(this.time * 1.7) * 0.02;
        t.elR = 0.45;
      }
      if (p.aiming) {
        t.shRx = -1.45; t.shRz = -0.08; t.elR = 0.1;
        t.shLx = -1.15; t.shLz = 0.5; t.elL = 0.5;
        t.spY = 0;
      }
    }

    if (!p.dead && p.dashing && p.mode !== 'flight') {
      t.bodyX = 0.55;
      t.thLx = 0.9; t.thRx = -0.55; t.knL = 0.2; t.knR = 0.8;
      t.shLx = 0.9; t.shRx = 0.9; t.shLz = 0.2; t.shRz = -0.2;
    }

    if (!p.dead && attacking) {
      const u = ease(p.attack.t);
      const w = Math.sin(clamp(p.attack.t, 0, 1) * Math.PI);
      if (p.attack.idx === 0) {
        t.shRx = lerp(-2.5, 0.5, u); t.shRz = lerp(-0.9, 0.35, u); t.elR = lerp(0.2, 0.5, w);
        t.spY = lerp(0.65, -0.75, u); t.spX = 0.12 + 0.1 * w;
        t.thLx = -0.5; t.thRx = 0.45; t.knL = 0.3; t.knR = 0.2;
        t.shLx = lerp(0.2, -0.9, u);
      } else if (p.attack.idx === 1) {
        t.shRx = lerp(-1.1, -0.15, u); t.shRz = lerp(1.0, -0.9, u); t.elR = lerp(0.9, 0.2, u);
        t.spY = lerp(-0.7, 0.8, u); t.spX = 0.1;
        t.thLx = 0.45; t.thRx = -0.5; t.knL = 0.2; t.knR = 0.3;
        t.shLx = lerp(-0.7, 0.4, u);
      } else {
        t.shRx = lerp(-3.0, 0.15, u); t.shLx = lerp(-2.8, 0.1, u);
        t.shRz = -0.12; t.shLz = 0.12; t.elR = lerp(0.3, 0.1, u); t.elL = 0.3;
        t.spX = lerp(-0.25, 0.65, u); t.spY = 0;
        t.thLx = 0.55; t.thRx = -0.35; t.knL = 0.7; t.knR = 0.5;
        t.hipsY = -0.12 * w;
      }
    }

    // damped application
    const k = 1 - Math.exp(-dt * (attacking ? 30 : 15));
    for (const key of KEYS) this.cur[key] += (t[key] - this.cur[key]) * k;
    const c = this.cur;
    const B = this.bones;
    B[BONE.body].rotation.set(c.bodyX, 0, c.bodyZ);
    B[BONE.body].position.y = p.dead ? 0.15 : 0;
    B[BONE.hips].position.y = this.hipsRest + c.hipsY;
    // the spine bends over two bones so the abdomen deforms smoothly
    B[BONE.spine].rotation.set(c.spX * 0.55, c.spY * 0.5, c.spZ * 0.5);
    B[BONE.chest].rotation.set(c.spX * 0.45, c.spY * 0.5, c.spZ * 0.5);
    B[BONE.head].rotation.set(c.headX, c.headY, 0);
    B[BONE.thL].rotation.set(c.thLx, 0, c.thLz);
    B[BONE.thR].rotation.set(c.thRx, 0, c.thRz);
    B[BONE.knL].rotation.x = c.knL;
    B[BONE.knR].rotation.x = c.knR;
    B[BONE.shL].rotation.set(c.shLx, 0, c.shLz);
    B[BONE.shR].rotation.set(c.shRx, 0, c.shRz);
    B[BONE.elL].rotation.x = -c.elL;
    B[BONE.elR].rotation.x = -c.elR;
    B[BONE.hdL].rotation.x = -c.elL * 0.15;
    B[BONE.hdR].rotation.x = -c.elR * 0.15;

    const planted = p.grounded && p.mode === 'ground' && !p.dead;
    this.plantFeet(dt, p, planted && !p.dashing);

    // feet: level with the ground while planted, pointed in the air
    const footL = planted ? -(c.bodyX + B[BONE.thL].rotation.x + B[BONE.knL].rotation.x) : 0.55;
    const footR = planted ? -(c.bodyX + B[BONE.thR].rotation.x + B[BONE.knR].rotation.x) : 0.45;
    this.foot[0] += (footL - this.foot[0]) * k;
    this.foot[1] += (footR - this.foot[1]) * k;
    B[BONE.ftL].rotation.x = this.foot[0];
    B[BONE.ftR].rotation.x = this.foot[1];

    // crest: antler strands sway, lag behind motion and stream back in flight
    const stream = p.mode === 'flight' ? 1 : clamp(sp, 0, 1);
    for (let i = 0; i < CREST_STRANDS; i++) {
      for (let j = 0; j < CREST_SEGS; j++) {
        const b = B[BONE.crest + i * CREST_SEGS + j];
        const sway = Math.sin(this.time * (1.8 + i * 0.3) + j * 0.9 + i) * 0.12;
        b.rotation.x = -stream * 0.22 + sway * (0.4 + j * 0.3);
        b.rotation.z = Math.sin(this.time * 1.4 + i * 1.7 + j) * 0.08 * (j + 1);
      }
    }
  }

  /**
   * Two-bone IK foot planting: each ankle is moved by the ground offset under it (relative to the ground under
   * the root), the hips drop to let the lower leg reach, and thigh/knee angles are solved analytically.
   */
  private plantFeet(dt: number, p: HeroPose, on: boolean) {
    this.ikW += ((on && p.ground ? 1 : 0) - this.ikW) * (1 - Math.exp(-dt * 8));
    if (this.ikW < 0.01 || !p.ground) return;
    const B = this.bones;
    this.root.updateWorldMatrix(true, true);
    const rootY = this.root.getWorldPosition(_a).y;
    const legs = [[BONE.thL, BONE.knL, BONE.ftL], [BONE.thR, BONE.knR, BONE.ftR]];
    const want = [0, 0];
    for (let i = 0; i < 2; i++) {
      B[legs[i][2]].getWorldPosition(_a);
      want[i] = clamp(p.ground(_a.x, _a.z) - rootY, -0.3, 0.3);
    }
    const kk = 1 - Math.exp(-dt * 12);
    for (let i = 0; i < 2; i++) this.ikOff[i] += (want[i] - this.ikOff[i]) * kk;
    const drop = Math.min(0, this.ikOff[0], this.ikOff[1]) * this.ikW;
    B[BONE.hips].position.y += drop;
    this.root.updateWorldMatrix(true, true);
    for (let i = 0; i < 2; i++) {
      const { l1: L1, l2: L2, a0, a1 } = this.leg[i];
      const [th, kn, ft] = legs[i].map((b) => B[b]);
      ft.getWorldPosition(_t);
      _t.y += this.ikOff[i] * this.ikW;
      B[BONE.hips].worldToLocal(_t);
      const dx = _t.x - th.position.x, dy = _t.y - th.position.y, dz = _t.z - th.position.z;
      const D = clamp(Math.hypot(dx, dy, dz), 0.2, L1 + L2 - 0.002);
      const kb = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1));
      const beta = Math.atan2(L2 * Math.sin(kb), L1 + L2 * Math.cos(kb));
      const z = Math.atan2(dx, Math.hypot(dy, dz));
      const x = Math.atan2(-dz, -dy) - beta;
      const w = this.ikW;
      // bones whose bind offsets lean (a fitted GLB skeleton) are solved relative to their rest angles
      th.rotation.x = lerp(th.rotation.x, x - a0, w);
      th.rotation.z = lerp(th.rotation.z, z, w);
      kn.rotation.x = lerp(kn.rotation.x, kb + a0 - a1, w);
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
