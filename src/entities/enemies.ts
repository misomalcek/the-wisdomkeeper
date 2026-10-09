import * as THREE from 'three';
import type { Game } from '../game';
import type { EnemyKind } from '../types';
import { TAU, angleDiff, clamp, damp } from '../util/math';

let nextId = 1;
const HOT = new THREE.Color(0xff3b7a);
const WHITE = new THREE.Color(0xffffff).multiplyScalar(3);
const _v = new THREE.Vector3();
const _xz = { x: 0, z: 0 };

interface Stats {
  hp: number;
  speed: number;
  radius: number;
  dmg: number;
  value: number;
  /** center height above the feet */
  foot: number;
  xp: number;
}
const TABLE: Record<EnemyKind, Stats> = {
  mite: { hp: 24, speed: 8.6, radius: 0.7, dmg: 12, value: 1, foot: 0, xp: 3 },
  spitter: { hp: 46, speed: 5.2, radius: 0.85, dmg: 13, value: 2, foot: 0, xp: 7 },
  brute: { hp: 260, speed: 4.2, radius: 2.1, dmg: 22, value: 5, foot: 1.9, xp: 30 },
  boss: { hp: 6800, speed: 4.4, radius: 4.4, dmg: 24, value: 0, foot: 4.8, xp: 600 },
};
export const ENEMY_COST: Record<Exclude<EnemyKind, 'boss'>, number> = { mite: 1, spitter: 2, brute: 5 };
export const ENEMY_NAME: Record<EnemyKind, string> = { mite: 'Null Sprite', spitter: 'Thorn Caster', brute: 'Void-Root Fiend', boss: 'The Null Warden' };
export const enemyXp = (k: EnemyKind) => TABLE[k].xp;

const GEO = {
  mite: new THREE.OctahedronGeometry(0.52, 0),
  miteEdges: new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.54, 0)),
  miteCore: new THREE.IcosahedronGeometry(0.2, 0),
  spitter: new THREE.ConeGeometry(0.55, 1.5, 5),
  spitterEdges: new THREE.EdgesGeometry(new THREE.ConeGeometry(0.58, 1.54, 5)),
  ring: new THREE.TorusGeometry(0.8, 0.04, 6, 24),
  spike: new THREE.ConeGeometry(0.1, 0.55, 5),
  tele: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5),
  haloRing: [3.4, 4.4].map((r) => new THREE.TorusGeometry(r, 0.06, 6, 64)),
  bar: new THREE.PlaneGeometry(1, 0.1),
  eye: new THREE.SphereGeometry(0.045, 8, 6),
};

/** tapered limb hanging from its pivot (same helper as the hero) */
function limbGeo(r0: number, r1: number, len: number, bulge = 0.2) {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, r0 * 0.6)];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector2((r0 + (r1 - r0) * t) * (1 + bulge * Math.sin(Math.min(1, t * 1.3) * Math.PI)), -len * t));
  }
  pts.push(new THREE.Vector2(0.001, -len - r1 * 0.6));
  return new THREE.LatheGeometry(pts, 8);
}
const FIEND_GEO = {
  thigh: limbGeo(0.2, 0.13, 0.9),
  shin: limbGeo(0.13, 0.07, 0.9),
  upper: limbGeo(0.16, 0.11, 1.0),
  fore: limbGeo(0.11, 0.08, 1.05),
  torso: new THREE.SphereGeometry(0.75, 12, 10),
  claw: new THREE.ConeGeometry(0.06, 0.5, 4),
  thorn: new THREE.ConeGeometry(0.09, 0.55, 5),
  head: new THREE.SphereGeometry(0.34, 12, 10),
  core: new THREE.IcosahedronGeometry(0.3, 1),
  antlers: (() => {
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const side = i % 2 ? 1 : -1;
      const k = Math.floor(i / 2);
      const pts = [
        new THREE.Vector3(side * 0.12, 0.2, -0.05),
        new THREE.Vector3(side * (0.3 + k * 0.1), 0.55 + k * 0.1, -0.12 - k * 0.08),
        new THREE.Vector3(side * (0.45 + k * 0.2), 0.95 + k * 0.15, -0.3 - k * 0.1),
        new THREE.Vector3(side * (0.4 + k * 0.28), 1.35 + k * 0.1, -0.5 - k * 0.1),
      ];
      geos.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.04 - k * 0.006, 5, false));
    }
    return geos;
  })(),
};

export class Enemy {
  readonly id = nextId++;
  readonly kind: EnemyKind;
  readonly group = new THREE.Group();
  readonly body = new THREE.Group();
  x = 0; y = 0; z = 0;
  vx = 0; vz = 0;
  hp: number;
  maxHp: number;
  radius: number;
  speed: number;
  dmg: number;
  value: number;
  foot: number;
  scale = 1;
  dead = false;
  spawnT = 0;
  flash = 0;
  slowT = 0;
  slowF = 0.5;
  rootT = 0;
  state = 'chase';
  st = 0;
  cd = 0.5 + Math.random();
  lockAng = 0;
  yawFace = 0;
  contactCD = 0;
  fromEvent = false;
  // camp / idle
  idle = false;
  aggroR = 26;
  campId = -1;
  homeX = 0;
  homeZ = 0;
  // boss
  phase = 1;
  activated = false;
  atk: 'radial' | 'spiral' | 'summon' | 'charge' | 'volley' | null = null;
  atkT = 0;
  atkN = 0;
  invuln = 0;
  // visuals
  coreMat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  edgeMat: THREE.LineBasicMaterial;
  baseEmissive = 0.7;
  tele?: THREE.Mesh;
  teleMat?: THREE.MeshBasicMaterial;
  spinners: THREE.Object3D[] = [];
  extraMats: THREE.Material[] = [];
  readonly uHurt = { value: 0 };
  readonly uT = { value: 0 };
  j: { legL?: THREE.Group; legR?: THREE.Group; armL?: THREE.Group; armR?: THREE.Group; head?: THREE.Group; torso?: THREE.Group; core?: THREE.Mesh } = {};
  bar?: THREE.Mesh;
  barBg?: THREE.Mesh;
  phaseAnim = Math.random() * 6;

  constructor(kind: EnemyKind, x: number, z: number, diff: number, groundY: number) {
    this.kind = kind;
    const s = TABLE[kind];
    const hpMul = 0.85 + 0.3 * diff;
    this.hp = this.maxHp = Math.round(s.hp * hpMul);
    this.speed = s.speed * (0.95 + 0.08 * diff);
    this.radius = s.radius;
    this.dmg = Math.round(s.dmg * (0.9 + 0.15 * diff));
    this.value = s.value;
    this.foot = s.foot;
    this.x = x;
    this.z = z;
    this.homeX = x;
    this.homeZ = z;
    const hover = kind === 'mite' ? 1.6 : kind === 'spitter' ? 2.6 : s.foot;
    this.y = groundY + hover;
    this.group.add(this.body);
    this.edgeMat = new THREE.LineBasicMaterial({ color: HOT.clone().multiplyScalar(2.2) });
    const solid = (emissive: number) =>
      new THREE.MeshStandardMaterial({ color: 0x14060c, emissive: HOT, emissiveIntensity: emissive, roughness: 0.4, metalness: 0.6, flatShading: true });

    if (kind === 'mite') {
      this.coreMat = solid(0.8);
      this.baseEmissive = 0.8;
      const core = new THREE.Mesh(GEO.miteCore, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff9ab8).multiplyScalar(2.6) }));
      this.extraMats.push(core.material as THREE.Material);
      this.body.add(new THREE.Mesh(GEO.mite, this.coreMat), new THREE.LineSegments(GEO.miteEdges, this.edgeMat), core);
      for (let i = 0; i < 4; i++) {
        const sp = new THREE.Mesh(GEO.spike, this.coreMat);
        const a = (i / 4) * TAU;
        sp.position.set(Math.cos(a) * 0.5, -0.2, Math.sin(a) * 0.5);
        sp.scale.setScalar(0.6);
        sp.rotation.set(Math.sin(a) * 1.9, 0, -Math.cos(a) * 1.9);
        this.body.add(sp);
      }
    } else if (kind === 'spitter') {
      this.coreMat = solid(0.6);
      this.baseEmissive = 0.6;
      const cone = new THREE.Mesh(GEO.spitter, this.coreMat);
      cone.rotation.x = Math.PI;
      const edges = new THREE.LineSegments(GEO.spitterEdges, this.edgeMat);
      edges.rotation.x = Math.PI;
      const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8a3b).multiplyScalar(2) });
      this.extraMats.push(ringMat);
      const ring = new THREE.Mesh(GEO.ring, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.6;
      this.spinners.push(ring);
      this.body.add(cone, edges, ring);
    } else {
      this.scale = kind === 'boss' ? 3.2 : 1.25;
      this.buildFiend();
      this.coreMat = this.j.core!.material as THREE.MeshBasicMaterial;
      this.baseEmissive = 1;
      this.group.scale.setScalar(0.01);
      if (kind === 'boss') {
        GEO.haloRing.forEach((g, i) => {
          const rm = new THREE.MeshBasicMaterial({ color: (i === 0 ? new THREE.Color(0xe8f4ff) : HOT.clone()).multiplyScalar(2.2) });
          this.extraMats.push(rm);
          const r = new THREE.Mesh(g, rm);
          r.position.y = 5.2;
          r.rotation.set(0.35 * (i ? -1 : 1), i, 0);
          r.userData.axis = new THREE.Vector3(Math.sin(i * 2.3), 1, Math.cos(i * 1.7)).normalize();
          r.userData.rate = 0.4 + i * 0.3;
          this.spinners.push(r);
          this.body.add(r);
        });
        this.makeTele(5.5, 80);
        this.invuln = 99;
        this.aggroR = 36;
      } else {
        this.makeTele(2.8, 18);
        // floating health bar for fiends
        this.barBg = new THREE.Mesh(GEO.bar, new THREE.MeshBasicMaterial({ color: 0x1a0a12, transparent: true, opacity: 0.8, depthWrite: false }));
        this.bar = new THREE.Mesh(GEO.bar, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3b7a).multiplyScalar(1.4), depthWrite: false }));
        this.extraMats.push(this.barBg.material as THREE.Material, this.bar.material as THREE.Material);
        this.barBg.scale.set(1.6, 1, 1);
        this.bar.renderOrder = this.barBg.renderOrder + 1;
        this.barBg.position.set(0, 4.6, 0);
        this.bar.position.set(0, 4.6, 0.01);
        this.barBg.visible = this.bar.visible = false;
        this.group.add(this.barBg, this.bar);
      }
    }
    if (kind !== 'brute' && kind !== 'boss') this.group.scale.setScalar(0.01);
    else this.group.scale.setScalar(0.01);
    this.yawFace = Math.random() * TAU;
  }

  private fiendMat(color: number, vein: number) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.35, flatShading: false, emissive: 0x050208, emissiveIntensity: 1 });
    const uHurt = this.uHurt;
    const uT = this.uT;
    const veinCol = new THREE.Color(vein);
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uHurt = uHurt;
      sh.uniforms.uT = uT;
      sh.uniforms.uVein = { value: veinCol };
      sh.vertexShader = sh.vertexShader.replace('void main() {', 'varying vec3 vOP;\nvoid main() {\n  vOP = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', 'varying vec3 vOP; uniform vec3 uVein; uniform float uT; uniform float uHurt;\nvoid main() {')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float fv = sin(vOP.y * 9.0 + sin(vOP.x * 7.0 + vOP.z * 5.0) * 2.0 + uT * 0.5);
          float fvein = smoothstep(0.9, 0.99, fv) * (0.6 + 0.4 * sin(uT * 2.2 + vOP.x * 5.0));
          float frim = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += uVein * (fvein * 1.4 + frim * 0.35) + vec3(1.0, 0.95, 0.95) * uHurt;`,
        );
    };
    m.customProgramCacheKey = () => 'fiendSkin';
    this.extraMats.push(m);
    return m;
  }

  /** Void-Root Fiend: hunched, antlered, thorned; glowing mycelial core is the weak point. */
  private buildFiend() {
    const bodyMat = this.fiendMat(0x1b1426, 0x7cff6b);
    const darkMat = this.fiendMat(0x0f0a18, 0x4fd8ff);
    const thornMat = new THREE.MeshStandardMaterial({ color: 0x0a0610, roughness: 0.5, metalness: 0.4, emissive: 0x7cff6b, emissiveIntensity: 0.25 });
    this.extraMats.push(thornMat);
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x8cff9a).multiplyScalar(2.4) });
    this.extraMats.push(glow);
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa24a).multiplyScalar(2.6) });
    this.extraMats.push(coreMat);
    const b = this.body;

    const torso = new THREE.Group();
    torso.position.set(0, 1.45, 0);
    const chest = new THREE.Mesh(FIEND_GEO.torso, bodyMat);
    chest.scale.set(1.0, 1.12, 0.72);
    torso.add(chest);
    const hump = new THREE.Mesh(FIEND_GEO.torso, darkMat);
    hump.scale.set(0.8, 0.7, 0.7);
    hump.position.set(0, 0.5, -0.35);
    torso.add(hump);
    for (let i = 0; i < 9; i++) {
      const th = new THREE.Mesh(FIEND_GEO.thorn, thornMat);
      const a = (i / 9) * Math.PI * 1.4 - 0.7;
      th.position.set(Math.sin(a) * 0.62, 0.5 + (i % 3) * 0.2, -0.45 - Math.cos(a) * 0.1);
      th.rotation.set(-1.0 - (i % 3) * 0.3, 0, -Math.sin(a) * 1.0);
      th.scale.setScalar(0.8 + (i % 4) * 0.25);
      torso.add(th);
    }
    // mycelial core (weak point) nested in the chest
    const core = new THREE.Mesh(FIEND_GEO.core, coreMat);
    core.position.set(0, 0.05, 0.5);
    torso.add(core);
    const cage: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const rib = new THREE.Mesh(FIEND_GEO.claw, thornMat);
      const a = (i / 4) * TAU + 0.4;
      rib.position.set(Math.cos(a) * 0.32, 0.05 + Math.sin(a) * 0.32, 0.5);
      rib.rotation.set(Math.sin(a) * 1.2 + Math.PI / 2, 0, -Math.cos(a) * 1.2);
      rib.scale.set(1.2, 0.8, 1.2);
      torso.add(rib);
      cage.push(rib);
    }
    b.add(torso);
    this.j.torso = torso;
    this.j.core = core;

    const head = new THREE.Group();
    head.position.set(0, 0.95, 0.28);
    const skull = new THREE.Mesh(FIEND_GEO.head, darkMat);
    skull.scale.set(0.8, 1.15, 1.1);
    head.add(skull);
    for (const eyeX of [-0.12, 0.12]) {
      const eye = new THREE.Mesh(GEO.eye, glow);
      eye.position.set(eyeX, 0.05, 0.36);
      head.add(eye);
    }
    for (const g of FIEND_GEO.antlers) head.add(new THREE.Mesh(g, thornMat));
    torso.add(head);
    this.j.head = head;

    const arm = (side: number) => {
      const sh = new THREE.Group();
      sh.position.set(side * 0.8, 0.45, 0.05);
      sh.add(new THREE.Mesh(FIEND_GEO.upper, bodyMat));
      const el = new THREE.Group();
      el.position.y = -1.0;
      el.add(new THREE.Mesh(FIEND_GEO.fore, darkMat));
      for (let i = -1; i <= 1; i++) {
        const c = new THREE.Mesh(FIEND_GEO.claw, thornMat);
        c.position.set(i * 0.07, -1.18, 0.04);
        c.rotation.set(Math.PI + 0.2, 0, i * 0.3);
        el.add(c);
      }
      el.rotation.x = -0.5;
      sh.add(el);
      sh.rotation.z = side * 0.25;
      torso.add(sh);
      return sh;
    };
    this.j.armL = arm(-1);
    this.j.armR = arm(1);

    const leg = (side: number) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.42, 1.0, 0);
      hip.add(new THREE.Mesh(FIEND_GEO.thigh, bodyMat));
      const knee = new THREE.Group();
      knee.position.y = -0.9;
      knee.rotation.x = 0.9;
      knee.add(new THREE.Mesh(FIEND_GEO.shin, darkMat));
      for (let i = -1; i <= 1; i++) {
        const c = new THREE.Mesh(FIEND_GEO.claw, thornMat);
        c.position.set(i * 0.07, -0.96, 0.12);
        c.rotation.set(Math.PI / 2 + 0.3, 0, i * 0.25);
        knee.add(c);
      }
      hip.add(knee);
      hip.rotation.x = -0.45;
      b.add(hip);
      return hip;
    };
    this.j.legL = leg(-1);
    this.j.legR = leg(1);
    void cage;
    b.scale.setScalar(this.scale);
  }

  private makeTele(width: number, len: number) {
    this.teleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3b4a).multiplyScalar(1.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.tele = new THREE.Mesh(GEO.tele, this.teleMat);
    this.tele.scale.set(width, 1, len);
    this.tele.visible = false;
    this.group.add(this.tele);
  }

  /** World position of the weak point (mycelial core). */
  coreWorld(out: THREE.Vector3) {
    return out.set(this.x, this.y + 0.1 * this.scale, this.z);
  }

  wake(g: Game) {
    if (!this.idle) return;
    this.idle = false;
    if (this.campId >= 0) g.wakeCamp(this.campId, this);
  }

  dispose() {
    this.coreMat.dispose();
    this.edgeMat.dispose();
    this.teleMat?.dispose();
    this.extraMats.forEach((m) => m.dispose());
    this.tele?.removeFromParent();
  }
}

// ---------------------------------------------------------------------------------------------

export function updateEnemy(e: Enemy, g: Game, dt: number) {
  const p = g.player;
  const terrain = g.world.terrain;
  const dxp = p.x - e.x;
  const dzp = p.z - e.z;
  const distXZ = Math.hypot(dxp, dzp);

  // far away: don't simulate or draw
  if (distXZ > 130 && e.kind !== 'boss') {
    e.group.visible = false;
    return;
  }
  e.group.visible = true;

  if (e.spawnT < 1) {
    e.spawnT = Math.min(1, e.spawnT + dt / (e.kind === 'boss' ? 1.8 : 0.55));
    const s = e.spawnT * e.spawnT * (3 - 2 * e.spawnT);
    e.group.scale.set(s, Math.max(s, 0.01), s);
  }
  e.flash = Math.max(0, e.flash - dt);
  e.contactCD -= dt;
  e.slowT -= dt;
  e.rootT -= dt;
  const ts = (e.slowT > 0 ? e.slowF : 1) * g.enemyTimeScale * (e.rootT > 0 ? 0 : 1);
  const sdt = dt * ts;

  // knockback decay
  e.x += e.vx * dt;
  e.z += e.vz * dt;
  const kd = Math.max(0, 1 - 7 * dt);
  e.vx *= kd;
  e.vz *= kd;

  const gh = terrain.heightAt(e.x, e.z);
  if (e.idle) idleStep(e, g, dt, distXZ, gh);
  else if (e.spawnT >= 1 && !p.dead) aiStep(e, g, sdt, dt, gh);
  else if (p.dead) e.y = damp(e.y, gh + (e.kind === 'mite' ? 1.6 : e.kind === 'spitter' ? 2.6 : e.foot), 4, dt);

  // keep inside the arena and out of solid scenery
  const R = g.world.radius * 0.99;
  const rr = Math.hypot(e.x, e.z);
  if (rr > R) {
    e.x *= R / rr;
    e.z *= R / rr;
  }
  if (e.kind !== 'mite' && e.kind !== 'spitter') {
    _xz.x = e.x;
    _xz.z = e.z;
    g.world.colliders.resolve(_xz, e.radius * 0.45);
    e.x = _xz.x;
    e.z = _xz.z;
  }

  // soft separation
  if (e.kind !== 'boss') {
    for (const o of g.enemies) {
      if (o === e || o.dead || o.kind === 'boss') continue;
      const dx = e.x - o.x;
      const dz = e.z - o.z;
      const min = (e.radius + o.radius) * 0.8;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const push = ((min - d) / d) * 0.5 * Math.min(1, dt * 12);
        e.x += dx * push;
        e.z += dz * push;
      }
    }
  }

  // visuals ---------------------------------------------------------------------------------
  const groundNow = terrain.heightAt(e.x, e.z);
  if (e.foot > 0) {
    // walkers follow the ground
    const feet = groundNow + (e.kind === 'boss' ? 0.25 + Math.sin(g.time * 1.3) * 0.12 : 0);
    e.y = damp(e.y, feet + e.foot, 12, dt);
    e.group.position.set(e.x, e.y - e.foot, e.z);
  } else {
    e.y = Math.max(e.y, groundNow + 1.1);
    e.group.position.set(e.x, e.y, e.z);
  }
  const f = e.flash > 0;
  e.edgeMat.color.copy(f ? WHITE : HOT).multiplyScalar(f ? 1 : 2.2);
  e.uHurt.value = f ? 0.8 : 0;
  e.uT.value = g.time;
  if (e.coreMat instanceof THREE.MeshStandardMaterial) e.coreMat.emissiveIntensity = f ? 4 : e.baseEmissive + (e.state === 'wind' ? 1.5 : 0);
  else {
    // fiend core pulses; brighter while telegraphing
    const pulse = 2.6 + Math.sin(g.time * (e.state === 'wind' ? 14 : 4)) * 0.6;
    e.coreMat.color.copy(f ? WHITE : new THREE.Color(0xffa24a)).multiplyScalar(f ? 1 : pulse);
  }
  e.group.rotation.y = e.kind === 'mite' || e.kind === 'spitter' ? 0 : e.yawFace;
  animateEnemy(e, g, dt);

  // fiend health bar
  if (e.kind === 'brute') {
    const show = e.hp < e.maxHp && !e.dead;
    const bar = e.bar!;
    const barBg = e.barBg!;
    barBg.visible = bar.visible = show;
    if (show) {
      const k = clamp(e.hp / e.maxHp, 0.001, 1);
      bar.scale.set(1.6 * k, 1, 1);
      bar.position.x = -0.8 * (1 - k);
      const qb = g.gfx.camera.quaternion;
      bar.quaternion.copy(qb).premultiply(_inv.copy(e.group.quaternion).invert());
      barBg.quaternion.copy(bar.quaternion);
    }
  }
}
const _inv = new THREE.Quaternion();

function idleStep(e: Enemy, g: Game, dt: number, dist: number, gh: number) {
  // camp guards loiter near home and face the player until provoked
  const sway = g.time * 0.5 + e.id;
  if (e.kind === 'mite' || e.kind === 'spitter') {
    e.x += (e.homeX + Math.cos(sway) * 3 - e.x) * Math.min(1, dt * 0.5);
    e.z += (e.homeZ + Math.sin(sway * 1.3) * 3 - e.z) * Math.min(1, dt * 0.5);
    e.y = damp(e.y, gh + (e.kind === 'mite' ? 1.8 : 2.8) + Math.sin(g.time * 1.4 + e.id) * 0.25, 3, dt);
  }
  const want = Math.atan2(g.player.x - e.x, g.player.z - e.z);
  e.yawFace += angleDiff(e.yawFace, want) * Math.min(1, dt * 1.5);
  if (e.spawnT >= 1 && dist < e.aggroR && !g.player.dead) e.wake(g);
}

function animateEnemy(e: Enemy, g: Game, dt: number) {
  const t = g.time;
  if (e.kind === 'mite') {
    e.body.rotation.y += dt * (e.idle ? 1 : 4);
    e.body.rotation.x = Math.sin(t * 5 + e.id) * 0.3;
    if (Math.random() < 0.04 || e.flash > 0) e.body.scale.set(1 + (Math.random() - 0.5) * 0.3, 1 + (Math.random() - 0.5) * 0.2, 1 + (Math.random() - 0.5) * 0.3);
    else e.body.scale.lerp(_one, Math.min(1, dt * 18));
  } else if (e.kind === 'spitter') {
    e.body.rotation.y += dt * 1.5;
    for (const s of e.spinners) s.rotation.z += dt * 5;
  } else {
    const j = e.j;
    const moving = !e.idle && (e.state === 'chase' || e.state === 'charge') && e.rootT <= 0;
    const sp = e.state === 'charge' ? 2.4 : moving ? 1 : 0;
    e.phaseAnim += dt * (2.6 + sp * 2.2) * (sp > 0 ? 1 : 0);
    const s = Math.sin(e.phaseAnim);
    const k = 1 - Math.exp(-dt * 12);
    const set = (o: THREE.Object3D | undefined, axis: 'x' | 'z', v: number) => {
      if (o) o.rotation[axis] += (v - o.rotation[axis]) * k;
    };
    set(j.legL, 'x', -0.45 + s * 0.7 * Math.min(sp, 1));
    set(j.legR, 'x', -0.45 - s * 0.7 * Math.min(sp, 1));
    const wind = e.state === 'wind';
    set(j.armL, 'x', wind ? -2.6 : e.state === 'charge' ? 0.8 : -s * 0.6 * Math.min(sp, 1) + Math.sin(t * 1.4 + e.id) * 0.06);
    set(j.armR, 'x', wind ? -2.6 : e.state === 'charge' ? 0.8 : s * 0.6 * Math.min(sp, 1) + Math.sin(t * 1.4 + e.id + 1) * 0.06);
    set(j.torso, 'x', wind ? -0.3 : e.state === 'charge' ? 0.55 : e.state === 'recover' ? 0.35 : 0.08 + Math.sin(t * 1.4 + e.id) * 0.03);
    set(j.head, 'x', wind ? -0.4 : 0.1);
    if (j.torso) j.torso.position.y = 1.45 + Math.sin(t * 1.4 + e.id) * 0.03 - Math.abs(s) * 0.05 * Math.min(sp, 1);
    for (const sp2 of e.spinners) sp2.rotateOnAxis(sp2.userData.axis as THREE.Vector3, dt * (sp2.userData.rate as number));
    // keep floating halos around the chest of a boss
    if (j.core) j.core.rotation.y += dt * 2;
  }
}
const _one = new THREE.Vector3(1, 1, 1);

/** Fires at the player's chest, leading the shot by the player's velocity. */
function leadTarget(g: Game, from: { x: number; y: number; z: number }, speed: number, out: THREE.Vector3) {
  const p = g.player;
  const d = Math.hypot(p.x - from.x, p.cy - from.y, p.z - from.z);
  const lead = Math.min(1.1, d / speed);
  return out.set(p.x + p.vx * lead, p.cy + p.vy * lead * 0.5, p.z + p.vz * lead);
}

function aiStep(e: Enemy, g: Game, dt: number, rawDt: number, gh: number) {
  const p = g.player;
  const dx = p.x - e.x;
  const dz = p.z - e.z;
  const dxz = Math.hypot(dx, dz) || 0.001;
  const d3 = Math.hypot(dxz, p.cy - e.y);
  const toP = Math.atan2(dx, dz);
  const flow = g.flowAt(e.x, e.z);
  if (e.foot === 0 || e.kind === 'brute') {
    e.x += flow.x * rawDt * 0.5;
    e.z += flow.y * rawDt * 0.5;
  }
  e.yawFace += angleDiff(e.yawFace, toP) * Math.min(1, rawDt * (e.state === 'charge' ? 0 : 5));
  const playerAlt = p.y - g.world.terrain.heightAt(p.x, p.z);

  const touch = (reach = e.radius + 0.7) => {
    if (d3 < reach && e.contactCD <= 0) {
      if (g.hurtPlayer(e.dmg, e.x, e.z)) {
        e.contactCD = 0.9;
        e.vx -= (dx / dxz) * 6;
        e.vz -= (dz / dxz) * 6;
      } else e.contactCD = 0.25;
    }
  };

  switch (e.kind) {
    case 'mite': {
      const wob = Math.sin(g.time * 3 + e.id * 1.7) * (dxz > 6 ? 0.55 : 0.15);
      const a = toP + wob;
      const sp = e.speed * (dxz < 2.2 ? 0.5 : 1);
      e.x += Math.sin(a) * sp * dt;
      e.z += Math.cos(a) * sp * dt;
      const targetY = clamp(p.cy + 0.3, gh + 1.4, gh + 14);
      e.y += clamp(targetY - e.y, -7 * dt, 7 * dt);
      touch(e.radius + 0.6);
      break;
    }
    case 'spitter': {
      e.cd -= dt;
      const targetY = clamp(p.cy + 1.5, gh + 2.6, gh + 9);
      e.y += clamp(targetY - e.y, -4 * dt, 4 * dt);
      if (e.state === 'chase') {
        const want = 14;
        const side = Math.sin(g.time * 0.8 + e.id) * 0.9;
        let a = toP;
        let sp = 0;
        if (dxz > want + 3) sp = e.speed;
        else if (dxz < want - 4) {
          a = toP + Math.PI;
          sp = e.speed * 0.9;
        } else {
          a = toP + (Math.PI / 2) * Math.sign(side || 1);
          sp = e.speed * 0.45;
        }
        e.x += Math.sin(a) * sp * dt;
        e.z += Math.cos(a) * sp * dt;
        if (e.cd <= 0 && dxz < 36) {
          e.state = 'wind';
          e.st = 0.5;
        }
      } else if (e.state === 'wind') {
        e.st -= dt;
        if (e.st <= 0) {
          const n = g.diff > 1.35 ? 3 : g.diff > 1.0 ? 2 : 1;
          const orbSpeed = 20 + g.diff * 1.5;
          const T = leadTarget(g, e, orbSpeed, _v);
          const aimA = Math.atan2(T.x - e.x, T.z - e.z);
          const dist = Math.hypot(T.x - e.x, T.z - e.z);
          for (let i = 0; i < n; i++) {
            const a = aimA + (i - (n - 1) / 2) * 0.2 + (Math.random() - 0.5) * 0.08;
            g.projectiles.fireEnemy(e.x, e.y, e.z, e.x + Math.sin(a) * dist, T.y, e.z + Math.cos(a) * dist, orbSpeed, e.dmg);
          }
          g.audio.sfx('spit');
          e.state = 'chase';
          e.cd = 2.2 / (0.85 + 0.15 * g.diff) + Math.random() * 0.7;
        }
      }
      touch();
      break;
    }
    case 'brute': {
      e.cd -= dt;
      const reach = e.radius + 0.9;
      if (e.state === 'chase') {
        e.x += Math.sin(toP) * e.speed * dt;
        e.z += Math.cos(toP) * e.speed * dt;
        if (e.cd <= 0) {
          if (playerAlt > 4.5 && dxz < 34) {
            // out of reach in the air: lob thorn orbs
            const T = leadTarget(g, e, 24, _v);
            for (let i = -1; i <= 1; i++) g.projectiles.fireEnemy(e.x, e.y + 1.8, e.z, T.x + i * 2, T.y, T.z, 24, e.dmg * 0.7, 4, 6);
            g.audio.sfx('spit');
            e.cd = 2.4;
          } else if (dxz < 20) {
            e.state = 'wind';
            e.st = 0.85;
            g.audio.sfx('warn');
          }
        }
      } else if (e.state === 'wind') {
        e.st -= dt;
        e.lockAng = toP;
        e.yawFace += angleDiff(e.yawFace, toP) * Math.min(1, rawDt * 10);
        if (e.tele && e.teleMat) {
          e.tele.visible = true;
          e.tele.position.y = -e.foot + 0.3;
          e.tele.rotation.y = e.lockAng - e.yawFace;
          e.teleMat.opacity = 0.25 + 0.35 * (1 - e.st / 0.85);
        }
        if (e.st <= 0) {
          e.state = 'charge';
          e.st = 0.7;
          if (e.tele) e.tele.visible = false;
        }
      } else if (e.state === 'charge') {
        e.st -= dt;
        e.x += Math.sin(e.lockAng) * 20 * dt;
        e.z += Math.cos(e.lockAng) * 20 * dt;
        e.yawFace = e.lockAng;
        if (Math.random() < 0.7) g.particles.burst(_v.set(e.x, e.y - e.foot + 0.4, e.z), HOT, 1, 4, 0.5, 0.4);
        if (d3 < reach && Math.abs(p.cy - e.y) < 3 && e.contactCD <= 0) {
          if (g.hurtPlayer(Math.round(e.dmg * 1.4), e.x, e.z)) {
            e.contactCD = 1.2;
            g.shake(0.8);
          }
        }
        if (e.st <= 0) {
          e.state = 'recover';
          e.st = 0.9;
        }
      } else if (e.state === 'recover') {
        e.st -= dt;
        if (e.st <= 0) {
          e.state = 'chase';
          e.cd = 2.2 + Math.random();
        }
      }
      if (e.state !== 'charge' && Math.abs(p.cy - e.y) < 3) touch(reach);
      break;
    }
    case 'boss':
      bossStep(e, g, dt, dxz, toP, gh);
      break;
  }
}

function bossStep(e: Enemy, g: Game, dt: number, dxz: number, toP: number, gh: number) {
  const p = g.player;
  if (!e.activated) {
    if (dxz < 38) {
      e.activated = true;
      e.invuln = 0.6;
      e.cd = 2;
      g.audio.sfx('boss');
      g.shake(1);
      g.bossAwake(e);
    }
    return;
  }
  e.invuln = Math.max(0, e.invuln - dt);
  e.yawFace += angleDiff(e.yawFace, e.atk === 'charge' && e.state === 'charge' ? e.lockAng : toP) * Math.min(1, dt * 4);
  const ratio = e.hp / e.maxHp;
  const phase = ratio > 0.66 ? 1 : ratio > 0.33 ? 2 : 3;
  if (phase > e.phase) {
    e.phase = phase;
    e.atk = null;
    e.cd = 1.6;
    e.invuln = 1.2;
    g.projectiles.clearEnemyBolts();
    g.particles.ring(_v.set(e.x, e.y, e.z), HOT.clone().multiplyScalar(3), 60, 26, 0.9, 1.0);
    g.audio.sfx('boss');
    g.shake(1.2);
    g.bossPhase(e, phase);
  }

  if (e.atk !== 'charge') {
    const want = 20;
    let a = toP;
    let sp = 0;
    if (dxz > want + 5) sp = e.speed;
    else if (dxz < want - 7) {
      a = toP + Math.PI;
      sp = e.speed * 0.8;
    } else {
      a = toP + Math.PI / 2;
      sp = e.speed * 0.35;
    }
    e.x += Math.sin(a) * sp * dt;
    e.z += Math.cos(a) * sp * dt;
  }

  const shots = [14, 18, 24][e.phase - 1];
  const pos = _v.set(e.x, e.y, e.z);
  const ringY = () => Math.max(gh + 1.2, p.cy);

  if (e.atk === null) {
    e.cd -= dt;
    if (e.cd <= 0) {
      const pool: ('radial' | 'spiral' | 'summon' | 'charge' | 'volley')[] =
        e.phase === 1
          ? ['radial', 'radial', 'volley', 'volley', 'summon']
          : e.phase === 2
            ? ['radial', 'spiral', 'spiral', 'volley', 'volley', 'summon', 'charge']
            : ['radial', 'spiral', 'spiral', 'volley', 'charge', 'charge', 'summon'];
      let pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick === 'summon' && g.enemies.filter((o) => !o.dead && o.kind !== 'boss').length > 7) pick = 'radial';
      e.atk = pick;
      e.atkN = 0;
      e.atkT = pick === 'radial' ? 0.7 : pick === 'spiral' ? 3.6 : pick === 'summon' ? 1.0 : pick === 'volley' ? 0.6 : 1.1;
      if (pick === 'volley') {
        e.atkN = 3 + e.phase;
        e.st = 0;
      }
      if (pick === 'charge') {
        e.lockAng = toP;
        g.audio.sfx('warn');
      }
    }
    return;
  }

  e.atkT -= dt;
  const fireRing = (n: number, offset: number, speed: number) => {
    const y = ringY();
    for (let i = 0; i < n; i++) g.projectiles.fireEnemyFlat(e.x, y, e.z, offset + (i / n) * TAU, speed, 10);
    g.audio.sfx('spit');
  };
  switch (e.atk) {
    case 'radial':
      e.state = 'wind';
      if (e.atkT <= 0) {
        fireRing(shots, Math.random() * TAU, 11 + e.phase * 1.2);
        if (e.phase >= 3) fireRing(shots, Math.random() * TAU, 8);
        g.particles.ring(pos, HOT.clone().multiplyScalar(2.5), 24, 12, 0.6, 0.6);
        e.atk = null;
        e.state = 'chase';
        e.cd = [2.4, 1.9, 1.5][e.phase - 1];
      }
      break;
    case 'spiral': {
      e.state = 'wind';
      e.atkN -= dt;
      if (e.atkN <= 0) {
        e.atkN = 0.1 - e.phase * 0.008;
        const a = g.time * 3.2;
        const arms = e.phase + 1;
        const y = ringY();
        for (let i = 0; i < arms; i++) g.projectiles.fireEnemyFlat(e.x, y, e.z, a + (i / arms) * TAU, 12, 9);
      }
      if (e.atkT <= 0) {
        e.atk = null;
        e.state = 'chase';
        e.cd = 2.2;
      }
      break;
    }
    case 'volley':
      e.state = 'wind';
      if (e.atkT > 0) break;
      e.st -= dt;
      if (e.st <= 0) {
        if (e.atkN <= 0) {
          e.atk = null;
          e.state = 'chase';
          e.cd = [2.2, 1.8, 1.5][e.phase - 1];
          break;
        }
        e.atkN--;
        e.st = 0.34;
        const speed = 22 + e.phase * 1.5;
        const T = leadTarget(g, e, speed, new THREE.Vector3());
        const aimA = Math.atan2(T.x - e.x, T.z - e.z);
        const dist = Math.hypot(T.x - e.x, T.z - e.z);
        const half = e.phase >= 2 ? 2 : 1;
        for (let i = -half; i <= half; i++) {
          const a = aimA + i * 0.15;
          g.projectiles.fireEnemy(e.x, e.y, e.z, e.x + Math.sin(a) * dist, T.y, e.z + Math.cos(a) * dist, speed, 12);
        }
        g.audio.sfx('spit');
      }
      break;
    case 'summon':
      e.state = 'wind';
      if (e.atkT <= 0) {
        const n = 2 + e.phase;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + Math.random();
          const r = 9 + Math.random() * 5;
          g.queueSpawn(e.phase === 3 && i % 2 ? 'spitter' : 'mite', e.x + Math.cos(a) * r, e.z + Math.sin(a) * r, false);
        }
        e.atk = null;
        e.state = 'chase';
        e.cd = 3;
      }
      break;
    case 'charge':
      if (e.atkT > 0.0 && e.state !== 'charge') {
        e.state = 'wind';
        e.lockAng = toP;
        if (e.tele && e.teleMat) {
          e.tele.visible = true;
          e.tele.position.y = -e.foot + 0.3;
          e.tele.rotation.y = e.lockAng - e.yawFace;
          e.teleMat.opacity = 0.2 + 0.4 * (1 - e.atkT / 1.1);
        }
      }
      if (e.atkT <= 0 && e.state !== 'charge') {
        e.state = 'charge';
        e.atkT = 0.9;
        if (e.tele) e.tele.visible = false;
        g.audio.sfx('boss');
      } else if (e.state === 'charge') {
        e.x += Math.sin(e.lockAng) * 28 * dt;
        e.z += Math.cos(e.lockAng) * 28 * dt;
        g.particles.burst(_v.set(e.x, gh + 0.5, e.z), HOT, 2, 6, 0.8, 0.5);
        const d3 = Math.hypot(p.x - e.x, p.cy - e.y, p.z - e.z);
        if (d3 < e.radius + 0.9 && e.contactCD <= 0 && g.hurtPlayer(Math.round(e.dmg * 1.3), e.x, e.z)) e.contactCD = 1;
        if (e.atkT <= 0) {
          e.atk = null;
          e.state = 'chase';
          e.cd = 1.4;
        }
      }
      break;
  }
  if (e.atk !== 'charge' && Math.hypot(p.x - e.x, p.cy - e.y, p.z - e.z) < e.radius + 0.9 && e.contactCD <= 0) {
    if (g.hurtPlayer(e.dmg, e.x, e.z)) e.contactCD = 1;
  }
}
