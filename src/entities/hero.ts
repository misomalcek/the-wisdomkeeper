import * as THREE from 'three';
import type { Skin } from '../types';
import { clamp } from '../util/math';

export type MoveMode = 'ground' | 'air' | 'flight' | 'levitate';

export const SKIN_LOOK: Record<Skin, { vein: number; body: number; armor: number; accent: number }> = {
  resonant: { vein: 0x4fe8ff, body: 0xc6e6f2, armor: 0x1b3560, accent: 0x5cffc1 },
  verdant: { vein: 0x7cff6b, body: 0xcfe9c8, armor: 0x1c4a2a, accent: 0xc2ff7a },
  void: { vein: 0xff3b7a, body: 0xe4c8d4, armor: 0x4a1230, accent: 0xff6aa0 },
};

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
}

export const idlePose = (): HeroPose => ({
  speed: 0, maxSpeed: 8.5, vy: 0, mode: 'ground', grounded: true, attack: { active: false, idx: 0, t: 0 },
  aiming: false, dashing: false, hurt: 0, dead: false, bank: 0,
});

const ease = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type JointKey =
  | 'bodyX' | 'bodyZ' | 'hipsY' | 'spX' | 'spY' | 'spZ' | 'headX' | 'headY'
  | 'thLx' | 'thRx' | 'thLz' | 'thRz' | 'knL' | 'knR'
  | 'shLx' | 'shLz' | 'shRx' | 'shRz' | 'elL' | 'elR';

const KEYS: JointKey[] = ['bodyX', 'bodyZ', 'hipsY', 'spX', 'spY', 'spZ', 'headX', 'headY', 'thLx', 'thRx', 'thLz', 'thRz', 'knL', 'knR', 'shLx', 'shLz', 'shRx', 'shRz', 'elL', 'elR'];

/** The Wisdomkeeper: slender bioluminescent humanoid, ~1.85 units tall, forward = +Z. */
export class Hero {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  private hips = new THREE.Group();
  private spine = new THREE.Group();
  private head = new THREE.Group();
  private thL = new THREE.Group();
  private thR = new THREE.Group();
  private knL = new THREE.Group();
  private knR = new THREE.Group();
  private shL = new THREE.Group();
  private shR = new THREE.Group();
  private elL = new THREE.Group();
  private elR = new THREE.Group();
  private handR = new THREE.Group();
  private blade = new THREE.Group();
  private bolter: THREE.Mesh;
  private tendrils: THREE.Group[][] = [];
  private cur = {} as Record<JointKey, number>;
  private phase = 0;
  private time = 0;
  private held = false;
  private heldUntil = 0;
  private disposables: { dispose(): void }[] = [];
  private u = { uVein: { value: new THREE.Color() }, uT: { value: 0 }, uHurt: { value: 0 } };
  private skinMat: THREE.MeshStandardMaterial;
  private armorMat: THREE.MeshStandardMaterial;
  private glowMat: THREE.MeshBasicMaterial;
  private bladeMat: THREE.MeshBasicMaterial;
  private veinCol = new THREE.Color();

  constructor(skin: Skin = 'resonant') {
    for (const k of KEYS) this.cur[k] = 0;
    const look = SKIN_LOOK[skin];
    this.skinMat = this.makeSkinMat(look.body);
    this.armorMat = new THREE.MeshStandardMaterial({ color: look.armor, roughness: 0.38, metalness: 0.55, emissive: look.vein, emissiveIntensity: 0.08 });
    this.glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(look.vein).multiplyScalar(2.2) });
    this.bladeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(look.accent).multiplyScalar(2.2) });
    this.disposables.push(this.skinMat, this.armorMat, this.glowMat, this.bladeMat);

    const geo = <T extends THREE.BufferGeometry>(g: T) => (this.disposables.push(g), g);
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => new THREE.Mesh(geo(g), m);
    const capsule = (r: number, len: number, mat: THREE.Material, dy = 0) => {
      const m = mesh(new THREE.CapsuleGeometry(r, len, 5, 10), mat);
      m.position.y = dy;
      return m;
    };
    /** Tapered, slightly muscled limb hanging down from its pivot. */
    const limb = (r0: number, r1: number, len: number, mat: THREE.Material, bulge = 0.2) => {
      const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, r0 * 0.6)];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        pts.push(new THREE.Vector2((r0 + (r1 - r0) * t) * (1 + bulge * Math.sin(Math.min(1, t * 1.3) * Math.PI)), -len * t));
      }
      pts.push(new THREE.Vector2(0.001, -len - r1 * 0.7));
      return mesh(new THREE.LatheGeometry(pts, 12), mat);
    };

    this.root.add(this.body);
    this.body.add(this.hips);
    this.hips.position.y = 0.98;

    // pelvis
    const pelvis = mesh(new THREE.SphereGeometry(0.15, 14, 10), this.armorMat);
    pelvis.scale.set(1.15, 0.72, 0.85);
    this.hips.add(pelvis);

    // legs
    const makeLeg = (thigh: THREE.Group, knee: THREE.Group, side: number) => {
      thigh.position.set(side * 0.105, -0.05, 0);
      thigh.add(limb(0.082, 0.052, 0.44, this.skinMat, 0.22));
      const thighGuard = mesh(new THREE.CapsuleGeometry(0.07, 0.17, 4, 8), this.armorMat);
      thighGuard.position.set(0, -0.15, 0.012);
      thigh.add(thighGuard);
      knee.position.y = -0.44;
      knee.add(limb(0.055, 0.036, 0.43, this.skinMat, 0.25));
      const greave = mesh(new THREE.CapsuleGeometry(0.052, 0.16, 4, 8), this.armorMat);
      greave.position.set(0, -0.2, 0.012);
      knee.add(greave);
      const foot = mesh(new THREE.CapsuleGeometry(0.048, 0.14, 4, 8), this.armorMat);
      foot.rotation.x = Math.PI / 2;
      foot.position.set(0, -0.46, 0.06);
      knee.add(foot);
      const kneeGlow = mesh(new THREE.SphereGeometry(0.03, 8, 6), this.glowMat);
      kneeGlow.position.set(0, 0, 0.06);
      knee.add(kneeGlow);
      thigh.add(knee);
      this.hips.add(thigh);
    };
    makeLeg(this.thL, this.knL, -1);
    makeLeg(this.thR, this.knR, 1);

    // spine / torso
    this.hips.add(this.spine);
    this.spine.position.y = 0.1;
    const prof = [[0.001, -0.02], [0.115, 0], [0.1, 0.14], [0.125, 0.3], [0.16, 0.46], [0.15, 0.58], [0.085, 0.65], [0.001, 0.67]].map(([r, y]) => new THREE.Vector2(r, y));
    const torso = mesh(new THREE.LatheGeometry(prof, 18), this.skinMat);
    torso.scale.set(1, 1, 0.72);
    this.spine.add(torso);
    const chest = mesh(new THREE.SphereGeometry(0.175, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.7), this.armorMat);
    chest.scale.set(1.0, 0.85, 0.7);
    chest.position.set(0, 0.4, 0.03);
    this.spine.add(chest);
    const ridge = mesh(new THREE.BoxGeometry(0.012, 0.3, 0.012), this.glowMat);
    ridge.position.set(0, 0.42, 0.145);
    this.spine.add(ridge);
    const core = mesh(new THREE.OctahedronGeometry(0.045, 0), this.glowMat);
    core.position.set(0, 0.44, 0.15);
    this.spine.add(core);
    const belt = mesh(new THREE.TorusGeometry(0.135, 0.016, 6, 20), this.glowMat);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.08;
    belt.scale.set(1, 0.8, 1);
    this.spine.add(belt);
    // thruster backpack ("Fractal Resonance Thruster")
    const pack = mesh(new THREE.CapsuleGeometry(0.07, 0.24, 4, 8), this.armorMat);
    pack.position.set(0, 0.36, -0.17);
    this.spine.add(pack);
    const jet = mesh(new THREE.ConeGeometry(0.04, 0.12, 8), this.glowMat);
    jet.rotation.x = Math.PI;
    jet.position.set(0, 0.2, -0.19);
    this.spine.add(jet);

    // head
    this.spine.add(this.head);
    this.head.position.y = 0.72;
    const neck = capsule(0.04, 0.05, this.skinMat, -0.06);
    this.head.add(neck);
    const skull = mesh(new THREE.SphereGeometry(0.108, 18, 14), this.skinMat);
    skull.scale.set(0.9, 1.22, 1.02);
    skull.position.y = 0.07;
    this.head.add(skull);
    const visor = mesh(new THREE.SphereGeometry(0.1, 14, 10, 0, Math.PI, 0.9, 0.7), this.glowMat);
    visor.rotation.y = 0;
    visor.scale.set(0.95, 0.75, 1.0);
    visor.position.set(0, 0.075, 0.02);
    this.head.add(visor);
    // crown tendrils: five trailing strands of four segments
    for (let i = 0; i < 5; i++) {
      const strand: THREE.Group[] = [];
      const base = new THREE.Group();
      const a = (i / 5) * Math.PI * 1.2 - Math.PI * 0.6;
      base.position.set(Math.sin(a) * 0.07, 0.16, -0.045 - Math.cos(a) * 0.01);
      base.rotation.set(-0.5, 0, Math.sin(a) * 0.5);
      let parent: THREE.Object3D = base;
      for (let j = 0; j < 4; j++) {
        const seg = new THREE.Group();
        const m = mesh(new THREE.CapsuleGeometry(0.014 - j * 0.002, 0.12, 3, 5), j === 3 ? this.glowMat : this.skinMat);
        m.position.y = 0.06;
        seg.add(m);
        seg.position.y = j === 0 ? 0 : 0.12;
        parent.add(seg);
        strand.push(seg);
        parent = seg;
      }
      this.head.add(base);
      this.tendrils.push(strand);
    }

    // arms
    const makeArm = (sh: THREE.Group, el: THREE.Group, side: number) => {
      sh.position.set(side * 0.23, 0.58, 0);
      const pad = mesh(new THREE.SphereGeometry(0.1, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), this.armorMat);
      pad.scale.set(1.15, 0.9, 1.05);
      pad.position.y = 0.035;
      sh.add(pad);
      const spike = mesh(new THREE.ConeGeometry(0.03, 0.14, 5), this.glowMat);
      spike.position.set(side * 0.07, 0.1, 0);
      spike.rotation.z = -side * 0.9;
      sh.add(spike);
      sh.add(limb(0.052, 0.04, 0.33, this.skinMat, 0.2));
      el.position.y = -0.33;
      el.add(limb(0.04, 0.03, 0.3, this.skinMat, 0.22));
      const bracer = mesh(new THREE.CapsuleGeometry(0.05, 0.14, 4, 8), this.armorMat);
      bracer.position.y = -0.2;
      el.add(bracer);
      const hand = mesh(new THREE.SphereGeometry(0.045, 10, 8), this.skinMat);
      hand.position.y = -0.37;
      el.add(hand);
      sh.add(el);
      this.spine.add(sh);
    };
    makeArm(this.shL, this.elL, -1);
    makeArm(this.shR, this.elR, 1);
    this.handR.position.y = -0.37;
    this.elR.add(this.handR);

    // spore bolter orb (visible while aiming)
    this.bolter = mesh(new THREE.IcosahedronGeometry(0.075, 1), this.glowMat);
    this.bolter.visible = false;
    this.handR.add(this.bolter);

    // Root-Blade: shaft, living-wood wrap, leaf blade
    const shaft = mesh(new THREE.CylinderGeometry(0.014, 0.018, 1.25, 6), this.armorMat);
    this.blade.add(shaft);
    for (let i = 0; i < 4; i++) {
      const ring = mesh(new THREE.TorusGeometry(0.03, 0.007, 5, 10), this.bladeMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -0.3 + i * 0.14;
      this.blade.add(ring);
    }
    const leaf = mesh(new THREE.ConeGeometry(0.06, 0.5, 4), this.bladeMat);
    leaf.scale.set(1, 1, 0.2);
    leaf.position.y = 0.88;
    this.blade.add(leaf);
    const tip = mesh(new THREE.OctahedronGeometry(0.03, 0), this.bladeMat);
    tip.position.y = -0.64;
    this.blade.add(tip);
    this.setBlade(false);

    this.setSkin(skin);
  }

  private makeSkinMat(color: number) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.1, emissive: 0x06201c, emissiveIntensity: 0.6 });
    const u = this.u;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uVein = u.uVein;
      sh.uniforms.uT = u.uT;
      sh.uniforms.uHurt = u.uHurt;
      sh.vertexShader = sh.vertexShader.replace('void main() {', 'varying vec3 vOP;\nvoid main() {\n  vOP = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', 'varying vec3 vOP; uniform vec3 uVein; uniform float uT; uniform float uHurt;\nvoid main() {')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float hv = sin(vOP.y * 34.0 + sin(vOP.x * 22.0 + vOP.z * 14.0) * 1.9 + uT * 0.8);
          float vein = smoothstep(0.93, 0.995, hv) * (0.55 + 0.45 * sin(vOP.x * 40.0 + vOP.z * 31.0));
          float rim = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), 2.4);
          totalEmissiveRadiance += uVein * (vein * (1.1 + 0.4 * sin(uT * 2.0)) + rim * 0.5) + vec3(1.0, 0.25, 0.35) * uHurt;`,
        );
    };
    m.customProgramCacheKey = () => 'heroSkin';
    return m;
  }

  setSkin(skin: Skin) {
    const l = SKIN_LOOK[skin];
    this.skinMat.color.set(l.body);
    this.armorMat.color.set(l.armor);
    this.armorMat.emissive.set(l.vein);
    this.veinCol.set(l.vein);
    this.u.uVein.value.copy(this.veinCol);
    this.glowMat.color.set(l.vein).multiplyScalar(2.2);
    this.bladeMat.color.set(l.accent).multiplyScalar(2.2);
  }

  /** Put the blade in the right hand (true) or on the back (false). */
  private setBlade(held: boolean) {
    if (held === this.held && this.blade.parent) return;
    this.held = held;
    this.blade.removeFromParent();
    if (held) {
      this.handR.add(this.blade);
      this.blade.position.set(0, 0.2, 0.02);
      this.blade.rotation.set(Math.PI / 2 - 0.25, 0, 0);
    } else {
      this.spine.add(this.blade);
      this.blade.position.set(0.02, 0.4, -0.24);
      this.blade.rotation.set(0.25, 0, 0.7);
    }
  }

  /** Keep the blade in hand regardless of combat (inventory portrait). */
  forceBlade(held: boolean) {
    this.heldUntil = held ? Infinity : 0;
  }

  handWorld(out: THREE.Vector3) {
    return this.handR.getWorldPosition(out);
  }

  update(dt: number, p: HeroPose) {
    this.time += dt;
    this.u.uT.value = this.time;
    this.u.uHurt.value = Math.max(0, p.hurt) * 0.8;
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
    this.body.rotation.set(c.bodyX, 0, c.bodyZ);
    this.body.position.y = p.dead ? 0.15 : 0;
    this.hips.position.y = 0.98 + c.hipsY;
    this.spine.rotation.set(c.spX, c.spY, c.spZ);
    this.head.rotation.set(c.headX, c.headY, 0);
    this.thL.rotation.set(c.thLx, 0, c.thLz);
    this.thR.rotation.set(c.thRx, 0, c.thRz);
    this.knL.rotation.x = c.knL;
    this.knR.rotation.x = c.knR;
    this.shL.rotation.set(c.shLx, 0, c.shLz);
    this.shR.rotation.set(c.shRx, 0, c.shRz);
    this.elL.rotation.x = -c.elL;
    this.elR.rotation.x = -c.elR;

    // tendrils: lag behind motion, stream back in flight
    const stream = p.mode === 'flight' ? 1 : clamp(sp, 0, 1);
    for (let i = 0; i < this.tendrils.length; i++) {
      const strand = this.tendrils[i];
      for (let j = 0; j < strand.length; j++) {
        const sway = Math.sin(this.time * (1.8 + i * 0.3) + j * 0.9 + i) * 0.22;
        strand[j].rotation.x = -0.1 - stream * 0.35 + sway * 0.5;
        strand[j].rotation.z = Math.sin(this.time * 1.4 + i * 1.7 + j) * 0.2;
      }
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
