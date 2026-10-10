import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, LineBasicNodeMaterial } from 'three/webgpu';
import { glowBasic, standard, glowLine, type N } from '../engine/materials';
import { uniform } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Game } from '../game';
import { applyLook, heroMaterial, heroUniforms, type HeroUniforms } from '../assets/heroModel';
import { FB, FIEND_CORE, buildFiendRig, fiendGeometry } from '../assets/fiendModel';
import { CB, CONSTRUCT_CORE, buildConstructRig, constructGeometry, dataPylonGeometry, droneGeometry, ringGeometry } from '../assets/nullModels';
import type { BossVariant, EnemyKind } from '../types';
import { TAU, angleDiff, clamp, damp } from '../util/math';

let nextId = 1;
const HOT = new THREE.Color(0xff3b7a);
const VOIDBARK = new THREE.Color(0x2a1e3a);
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
  drone: { hp: 70, speed: 7.5, radius: 1.0, dmg: 14, value: 3, foot: 0, xp: 12 },
  pylon: { hp: 420, speed: 0, radius: 1.5, dmg: 0, value: 0, foot: 0, xp: 25 },
  boss: { hp: 6800, speed: 4.4, radius: 4.4, dmg: 24, value: 0, foot: 4.8, xp: 600 },
};
export const ENEMY_COST: Record<'mite' | 'spitter' | 'brute' | 'drone', number> = { mite: 1, spitter: 2, brute: 5, drone: 3 };
export const ENEMY_NAME: Record<EnemyKind, string> = {
  mite: 'Null Sprite', spitter: 'Thorn Caster', brute: 'Void-Root Fiend', drone: 'Null-Sentry Drone', pylon: 'Data-River Pylon', boss: 'The Null Warden',
};
export const enemyName = (e: { kind: EnemyKind; variant: BossVariant }) => (e.kind === 'boss' && e.variant === 'construct' ? 'The Void-Infused Construct' : ENEMY_NAME[e.kind]);
/** Blueprint weak-point multiplier (Chest_Core_Bone ×2.5) and the bone-spike armour's rear reduction. */
export const WEAK_POINT_MUL = 2.5;
export const SPIKE_ARMOUR_MUL = 0.5;
export const enemyXp = (k: EnemyKind) => TABLE[k].xp;

const GEO = {
  // octahedral shell with four splayed legs, merged into one draw
  mite: mergeGeometries([
    new THREE.OctahedronGeometry(0.52, 0).deleteAttribute('uv'),
    ...[0, 1, 2, 3].map((i) => {
      const a = (i / 4) * TAU;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * 0.5, -0.2, Math.sin(a) * 0.5),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a) * 1.9, 0, -Math.cos(a) * 1.9)),
        new THREE.Vector3(0.6, 0.6, 0.6),
      );
      return new THREE.ConeGeometry(0.1, 0.55, 5).toNonIndexed().deleteAttribute('uv').applyMatrix4(m);
    }),
  ])!,
  miteEdges: new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.54, 0)),
  miteCore: new THREE.IcosahedronGeometry(0.2, 0),
  spitter: new THREE.ConeGeometry(0.55, 1.5, 5),
  spitterEdges: new THREE.EdgesGeometry(new THREE.ConeGeometry(0.58, 1.54, 5)),
  ring: new THREE.TorusGeometry(0.8, 0.04, 6, 24),
  tele: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5),
  haloRing: [3.4, 4.4].map((r) => new THREE.TorusGeometry(r, 0.06, 6, 64)),
  bar: new THREE.PlaneGeometry(1, 0.1),
  eye: new THREE.SphereGeometry(0.045, 8, 6),
  beam: new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5),
};

const FIEND_GEO = {
  core: new THREE.IcosahedronGeometry(0.3, 1),
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
  atk: 'radial' | 'spiral' | 'summon' | 'charge' | 'volley' | 'slam' | null = null;
  atkT = 0;
  atkN = 0;
  invuln = 0;
  // visuals
  coreMat!: MeshStandardNodeMaterial | MeshBasicNodeMaterial;
  edgeMat: LineBasicNodeMaterial;
  baseEmissive = 0.7;
  tele?: THREE.Mesh;
  teleMat?: MeshBasicNodeMaterial;
  spinners: THREE.Object3D[] = [];
  extraMats: THREE.Material[] = [];
  readonly uHurt: N = uniform(0);
  readonly uT: N = uniform(0);
  j: { legL?: THREE.Object3D; legR?: THREE.Object3D; armL?: THREE.Object3D; armR?: THREE.Object3D; head?: THREE.Object3D; torso?: THREE.Object3D; core?: THREE.Mesh } = {};
  bar?: THREE.Mesh;
  barBg?: THREE.Mesh;
  phaseAnim = Math.random() * 6;
  readonly variant: BossVariant;
  /** Squad tactics: may this enemy close to melee, and where it holds otherwise (angle around the hero). */
  engage = true;
  slotAng = 0;
  /** Construct: armoured while any data-river pylon stands. */
  armored = false;
  /** whether the last blow that landed was the Root-Blade (melee-kill telemetry) */
  lastMelee = false;
  /** Rest height of the torso bone (animation baseline). */
  torsoY = 1.45;
  /** Drone strafing direction and attack counter. */
  strafe = Math.random() < 0.5 ? -1 : 1;
  shots = 0;
  /** Telegraph beam (drone spike laser, fiend root tether). */
  beam?: THREE.Mesh;
  beamMat?: MeshBasicNodeMaterial;
  tetherHit = false;

  constructor(kind: EnemyKind, x: number, z: number, diff: number, groundY: number, variant: BossVariant = 'warden') {
    this.kind = kind;
    this.variant = variant;
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
    const hover = kind === 'mite' ? 1.6 : kind === 'spitter' ? 2.6 : kind === 'drone' ? 5 : s.foot;
    this.y = groundY + hover;
    this.group.add(this.body);
    this.edgeMat = glowLine({ color: HOT.clone().multiplyScalar(2.2) });
    const solid = (emissive: number) =>
      standard({ color: 0x14060c, emissive: HOT, emissiveIntensity: emissive, roughness: 0.4, metalness: 0.6, flatShading: true });

    if (kind === 'mite') {
      this.coreMat = solid(0.8);
      this.baseEmissive = 0.8;
      const core = new THREE.Mesh(GEO.miteCore, glowBasic({ color: new THREE.Color(0xff9ab8).multiplyScalar(2.6) }));
      this.extraMats.push(core.material as THREE.Material);
      this.body.add(new THREE.Mesh(GEO.mite, this.coreMat), new THREE.LineSegments(GEO.miteEdges, this.edgeMat), core);
    } else if (kind === 'spitter') {
      this.coreMat = solid(0.6);
      this.baseEmissive = 0.6;
      const cone = new THREE.Mesh(GEO.spitter, this.coreMat);
      cone.rotation.x = Math.PI;
      const edges = new THREE.LineSegments(GEO.spitterEdges, this.edgeMat);
      edges.rotation.x = Math.PI;
      const ringMat = glowBasic({ color: new THREE.Color(0xff8a3b).multiplyScalar(2) });
      this.extraMats.push(ringMat);
      const ring = new THREE.Mesh(GEO.ring, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.6;
      this.spinners.push(ring);
      this.body.add(cone, edges, ring);
    } else if (kind === 'drone') {
      this.buildDrone();
    } else if (kind === 'pylon') {
      this.buildPylon();
    } else if (kind === 'boss' && variant === 'construct') {
      this.buildConstruct();
    } else {
      this.scale = kind === 'boss' ? 3.2 : 1.25;
      this.buildFiend();
      this.coreMat = this.j.core!.material as MeshBasicNodeMaterial;
      this.baseEmissive = 1;
      this.group.scale.setScalar(0.01);
      if (kind === 'boss') {
        GEO.haloRing.forEach((g, i) => {
          const rm = glowBasic({ color: (i === 0 ? new THREE.Color(0xe8f4ff) : HOT.clone()).multiplyScalar(2.2) });
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
        this.makeBar(4.6);
        this.makeBeam(0x9a3bff);
      }
    }
    if (kind !== 'brute' && kind !== 'boss') this.group.scale.setScalar(0.01);
    else this.group.scale.setScalar(0.01);
    this.yawFace = Math.random() * TAU;
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== this.bar && o !== this.barBg) o.castShadow = true;
    });
  }

  private makeBar(y: number) {
    this.barBg = new THREE.Mesh(GEO.bar, glowBasic({ color: 0x1a0a12, transparent: true, opacity: 0.8, depthWrite: false }));
    this.bar = new THREE.Mesh(GEO.bar, glowBasic({ color: new THREE.Color(0xff3b7a).multiplyScalar(1.4), depthWrite: false }));
    this.extraMats.push(this.barBg.material as THREE.Material, this.bar.material as THREE.Material);
    this.barBg.scale.set(1.6, 1, 1);
    this.bar.renderOrder = this.barBg.renderOrder + 1;
    this.barBg.position.set(0, y, 0);
    this.bar.position.set(0, y, 0.01);
    this.barBg.visible = this.bar.visible = false;
    this.group.add(this.barBg, this.bar);
  }

  /** A unit-length beam along +Z from the body origin; scaled to length while telegraphing. */
  private makeBeam(color: number) {
    this.beamMat = glowBasic({ color: new THREE.Color(color).multiplyScalar(2.6), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
    this.beam = new THREE.Mesh(GEO.beam, this.beamMat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.group.add(this.beam);
  }

  /** Point the telegraph beam from local `from` at a world target. */
  aimBeam(fromY: number, tx: number, ty: number, tz: number, width = 1) {
    if (!this.beam) return;
    const dx = tx - this.x, dy = ty - (this.group.position.y + fromY), dz = tz - this.z;
    const len = Math.hypot(dx, dy, dz);
    this.beam.visible = true;
    this.beam.position.set(0, fromY, 0);
    this.beam.rotation.set(-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz) - this.group.rotation.y, 0, 'YXZ');
    this.beam.scale.set(width, width, len / Math.max(this.group.scale.x, 0.01));
  }

  private nullMaterial(look: { body: number; armor: number; vein: number; accent: number; dark: number }, veinScale: number, veinGain: number) {
    const u: HeroUniforms = { ...heroUniforms(), uT: this.uT, uHurt: this.uHurt };
    applyLook(u, look);
    const m = heroMaterial(u, veinScale, veinGain);
    this.extraMats.push(m);
    return m;
  }

  /** Null-Sentry Drone: corroded-steel pod, red Null-optic, magnetic suspension rings, spike vanes. */
  private buildDrone() {
    const mat = this.nullMaterial({ body: 0x343a44, armor: 0x6b3426, vein: 0xff2a44, accent: 0xff6a3b, dark: 0x15171c }, 1.4, 0.6);
    const pod = new THREE.Mesh(droneGeometry(), mat);
    pod.castShadow = true;
    this.body.add(pod);
    const ringMat = glowBasic({ color: new THREE.Color(0xff2a44).multiplyScalar(2.4) });
    this.coreMat = ringMat;
    this.baseEmissive = 1;
    for (let i = 0; i < 2; i++) {
      const r = new THREE.Mesh(ringGeometry(0.95 + i * 0.22, 0.025), ringMat);
      r.position.y = -0.35 - i * 0.18;
      r.rotation.x = Math.PI / 2;
      r.userData.axis = new THREE.Vector3(0, 0, 1);
      r.userData.rate = i ? -2.4 : 3.1;
      this.spinners.push(r);
      this.body.add(r);
    }
    this.makeBeam(0xff2a44);
    this.makeBar(1.5);
    this.group.scale.setScalar(0.01);
  }

  /** Integrated Data-River Pylon: a basalt obelisk feeding the Construct; destroying it breaches the armour. */
  private buildPylon() {
    const mat = this.nullMaterial({ body: 0x2a2436, armor: 0x4a2a6a, vein: 0x00e1ff, accent: 0x7af0ff, dark: 0x0d0b14 }, 0.6, 0.8);
    const m = new THREE.Mesh(dataPylonGeometry(), mat);
    m.castShadow = true;
    this.body.add(m);
    const lensMat = glowBasic({ color: new THREE.Color(0x00e1ff).multiplyScalar(2.6) });
    this.coreMat = lensMat;
    this.baseEmissive = 1;
    const ring = new THREE.Mesh(ringGeometry(0.85, 0.05), lensMat);
    ring.position.y = 5.6;
    ring.userData.axis = new THREE.Vector3(0.3, 1, 0.2).normalize();
    ring.userData.rate = 1.6;
    this.spinners.push(ring);
    this.body.add(ring);
    this.makeBeam(0x00e1ff);
    this.makeBar(6.6);
    this.group.scale.setScalar(0.01);
  }

  /** The Void-Infused Construct (Act IV boss): one skinned colossus; armoured while its pylons stand. */
  private buildConstruct() {
    const mat = this.nullMaterial({ body: 0x2c2238, armor: 0x5b2f9a, vein: 0xff2a7a, accent: 0xb084ff, dark: 0x110c18 }, 0.35, 0.7);
    const rig = buildConstructRig();
    const mesh = new THREE.SkinnedMesh(constructGeometry(), mat);
    mesh.add(rig.bones[CB.root]);
    mesh.bind(rig.skeleton);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    this.body.add(mesh);
    const coreMat = glowBasic({ color: new THREE.Color(0xff2a7a).multiplyScalar(2.6) });
    this.extraMats.push(coreMat);
    const core = new THREE.Mesh(FIEND_GEO.core, coreMat);
    core.scale.setScalar(2.2);
    core.position.copy(CONSTRUCT_CORE);
    rig.bones[CB.torso].add(core);
    const B = rig.bones;
    B[CB.shL].rotation.z = -0.12;
    B[CB.shR].rotation.z = 0.12;
    this.j = { torso: B[CB.torso], head: B[CB.head], armL: B[CB.shL], armR: B[CB.shR], legL: B[CB.hipL], legR: B[CB.hipR], core };
    this.torsoY = 3.6;
    this.coreMat = coreMat;
    this.baseEmissive = 1;
    this.foot = 4;
    this.radius = 4.2;
    this.makeTele(6.5, 60);
    this.invuln = 99;
    this.aggroR = 40;
    this.group.scale.setScalar(0.01);
  }

  /** Void-Root Fiend: one sculpted skinned mesh (assets/fiendModel); its glowing mycelial core is the weak point. */
  private buildFiend() {
    const u: HeroUniforms = { ...heroUniforms(), uT: this.uT, uHurt: this.uHurt };
    applyLook(u, { body: 0x3e3052, armor: 0x140c1c, vein: 0x7cff6b, accent: 0x8cff9a, dark: 0x251a36 });
    const mat = heroMaterial(u, 0.5, 0.45);
    this.extraMats.push(mat);
    const coreMat = glowBasic({ color: new THREE.Color(0xffa24a).multiplyScalar(2.6) });
    this.extraMats.push(coreMat);
    const rig = buildFiendRig();
    const mesh = new THREE.SkinnedMesh(fiendGeometry(), mat);
    mesh.add(rig.bones[FB.root]);
    mesh.bind(rig.skeleton);
    mesh.frustumCulled = false;
    this.body.add(mesh);
    const B = rig.bones;
    B[FB.shL].rotation.z = -0.25;
    B[FB.shR].rotation.z = 0.25;
    B[FB.elL].rotation.x = B[FB.elR].rotation.x = -0.5;
    B[FB.knL].rotation.x = B[FB.knR].rotation.x = 0.9;
    B[FB.hipL].rotation.x = B[FB.hipR].rotation.x = -0.45;
    const core = new THREE.Mesh(FIEND_GEO.core, coreMat);
    core.position.copy(FIEND_CORE);
    B[FB.torso].add(core);
    this.j = { torso: B[FB.torso], head: B[FB.head], armL: B[FB.shL], armR: B[FB.shR], legL: B[FB.hipL], legR: B[FB.hipR], core };
    this.body.scale.setScalar(this.scale);
  }

  private makeTele(width: number, len: number) {
    this.teleMat = glowBasic({ color: new THREE.Color(0xff3b4a).multiplyScalar(1.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.tele = new THREE.Mesh(GEO.tele, this.teleMat);
    this.tele.scale.set(width, 1, len);
    this.tele.visible = false;
    this.group.add(this.tele);
  }

  /** World position of the weak point (mycelial core). */
  coreWorld(out: THREE.Vector3) {
    if (this.kind === 'boss' && this.variant === 'construct') {
      const f = CONSTRUCT_CORE.z;
      return out.set(this.x + Math.sin(this.yawFace) * f, this.group.position.y + this.torsoY + CONSTRUCT_CORE.y, this.z + Math.cos(this.yawFace) * f);
    }
    if (this.kind === 'brute') {
      const f = FIEND_CORE.z * this.scale;
      return out.set(this.x + Math.sin(this.yawFace) * f, this.group.position.y + (this.torsoY + FIEND_CORE.y) * this.scale, this.z + Math.cos(this.yawFace) * f);
    }
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
    this.beamMat?.dispose();
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
  else if (p.dead) e.y = damp(e.y, gh + (e.kind === 'mite' ? 1.6 : e.kind === 'spitter' ? 2.6 : e.kind === 'drone' ? 5 : e.foot), 4, dt);

  // keep inside the arena and out of solid scenery
  const R = g.world.radius * 0.99;
  const rr = Math.hypot(e.x, e.z);
  if (!terrain.wild && rr > R) {
    e.x *= R / rr;
    e.z *= R / rr;
  }
  if (e.kind !== 'mite' && e.kind !== 'spitter' && e.kind !== 'drone' && e.kind !== 'pylon') {
    _xz.x = e.x;
    _xz.z = e.z;
    g.world.colliders.resolve(_xz, e.radius * 0.45);
    e.x = _xz.x;
    e.z = _xz.z;
  }

  // soft separation
  if (e.kind !== 'boss' && e.kind !== 'pylon') {
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
  if (e.kind === 'pylon') {
    e.y = groundNow + 3;
    e.group.position.set(e.x, groundNow - 0.2, e.z);
  } else if (e.foot > 0) {
    // walkers follow the ground
    const feet = groundNow + (e.kind === 'boss' && e.variant === 'warden' ? 0.25 + Math.sin(g.time * 1.3) * 0.12 : 0);
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
  if (e.coreMat instanceof MeshStandardNodeMaterial) e.coreMat.emissiveIntensity = f ? 4 : e.baseEmissive + (e.state === 'wind' ? 1.5 : 0);
  else {
    // cores pulse; brighter while telegraphing, dark while a Construct is armoured
    const pulse = (e.armored ? 0.6 : 2.6) + Math.sin(g.time * (e.state === 'wind' ? 14 : 4)) * 0.6;
    e.coreMat.color.copy(f ? WHITE : CORE_COLOR[e.kind === 'boss' ? e.variant : e.kind] ?? CORE_COLOR.brute).multiplyScalar(f ? 1 : pulse);
  }
  e.group.rotation.y = e.kind === 'mite' || e.kind === 'spitter' ? 0 : e.yawFace;
  animateEnemy(e, g, dt);

  // health bars for the tougher foes
  if (e.bar) {
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
const CORE_COLOR: Record<string, THREE.Color> = {
  brute: new THREE.Color(0xffa24a),
  drone: new THREE.Color(0xff2a44),
  pylon: new THREE.Color(0x00e1ff),
  construct: new THREE.Color(0xff2a7a),
  warden: new THREE.Color(0xffa24a),
};

function idleStep(e: Enemy, g: Game, dt: number, dist: number, gh: number) {
  // camp guards loiter near home and face the player until provoked
  const sway = g.time * 0.5 + e.id;
  if (e.kind === 'mite' || e.kind === 'spitter' || e.kind === 'drone') {
    e.x += (e.homeX + Math.cos(sway) * 3 - e.x) * Math.min(1, dt * 0.5);
    e.z += (e.homeZ + Math.sin(sway * 1.3) * 3 - e.z) * Math.min(1, dt * 0.5);
    e.y = damp(e.y, gh + (e.kind === 'mite' ? 1.8 : e.kind === 'drone' ? 5.5 : 2.8) + Math.sin(g.time * 1.4 + e.id) * 0.25, 3, dt);
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
  } else if (e.kind === 'drone' || e.kind === 'pylon') {
    for (const s of e.spinners) s.rotateOnAxis(s.userData.axis as THREE.Vector3, dt * (s.userData.rate as number) * (e.state === 'wind' ? 2.5 : 1));
    if (e.kind === 'drone') {
      // magnetic suspension: bob, and bank into the strafe
      e.body.position.y = Math.sin(t * 2.1 + e.id) * 0.12;
      e.body.rotation.z += (-e.strafe * 0.25 * (e.state === 'chase' ? 1 : 0) - e.body.rotation.z) * Math.min(1, dt * 3);
      e.body.rotation.x += ((e.state === 'wind' ? -0.25 : 0.1) - e.body.rotation.x) * Math.min(1, dt * 4);
      if (e.state === 'stun') e.body.rotation.y += dt * 9;
    }
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
    if (j.torso) j.torso.position.y = e.torsoY + Math.sin(t * 1.4 + e.id) * 0.03 - Math.abs(s) * 0.05 * Math.min(sp, 1);
    const sweep = e.state === 'sweep';
    if (sweep) set(j.armR, 'z', 1.2 - (e.st / 0.45) * 1.8);
    else set(j.armR, 'z', e.kind === 'boss' ? 0.12 : 0.25);
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
  if ((e.foot === 0 && e.kind !== 'pylon') || e.kind === 'brute') {
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
      let a = toP + wob;
      let sp = e.speed * (dxz < 2.2 ? 0.5 : 1);
      if (!e.engage) {
        // waiting its turn: circle at a distance
        e.slotAng += 0.6 * dt;
        const hx = p.x + Math.sin(e.slotAng) * 7 - e.x;
        const hz = p.z + Math.cos(e.slotAng) * 7 - e.z;
        a = Math.atan2(hx, hz);
        sp = Math.min(e.speed, Math.hypot(hx, hz) * 2);
      }
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
        // squad tactics: two fiends close in, the rest hold a ring and harry with root tethers
        let a = toP;
        let sp = e.speed;
        if (!e.engage) {
          const hx = p.x + Math.sin(e.slotAng) * 11 - e.x;
          const hz = p.z + Math.cos(e.slotAng) * 11 - e.z;
          const hd = Math.hypot(hx, hz);
          a = Math.atan2(hx, hz);
          sp = hd > 1.5 ? e.speed * Math.min(1, hd / 4) : 0;
        }
        e.x += Math.sin(a) * sp * dt;
        e.z += Math.cos(a) * sp * dt;
        if (e.cd <= 0) {
          if (playerAlt > 4.5 && dxz < 34) {
            // out of reach in the air: lob thorn orbs
            const T = leadTarget(g, e, 24, _v);
            for (let i = -1; i <= 1; i++) g.projectiles.fireEnemy(e.x, e.y + 1.8, e.z, T.x + i * 2, T.y, T.z, 24, e.dmg * 0.7, 4, 6);
            g.audio.sfx('spit');
            e.cd = 2.4;
          } else if (e.engage && dxz < reach + 1.4) {
            // claw sweep at close range
            e.state = 'sweep';
            e.st = 0.45;
            g.audio.sfx('warn');
          } else if (dxz > 7 && dxz < 17 && (!e.engage || Math.random() < 0.35)) {
            // corrupted root tether: telegraph, then haul the hero in
            e.state = 'tether';
            e.st = 0.7;
            e.tetherHit = false;
            g.audio.sfx('warn');
          } else if (e.engage && dxz < 20) {
            e.state = 'wind';
            e.st = 0.85;
            g.audio.sfx('warn');
          } else e.cd = 0.6;
        }
      } else if (e.state === 'sweep') {
        e.st -= dt;
        e.yawFace += angleDiff(e.yawFace, toP) * Math.min(1, rawDt * 8);
        if (e.st <= 0) {
          if (dxz < reach + 2 && Math.abs(angleDiff(e.yawFace, toP)) < 1.1 && Math.abs(p.cy - e.y) < 3) {
            if (g.hurtPlayer(Math.round(e.dmg * 1.1), e.x, e.z)) g.shake(0.5);
          }
          g.particles.ring(_v.set(e.x + Math.sin(e.yawFace) * 2, e.y - e.foot + 0.6, e.z + Math.cos(e.yawFace) * 2), HOT.clone().multiplyScalar(2), 14, 6, 0.4, 0.4);
          e.state = 'recover';
          e.st = 0.6;
        }
      } else if (e.state === 'tether') {
        e.st -= dt;
        const handY = 2.2 * e.scale;
        if (e.st > 0) {
          // the root reaches out along the telegraph
          const k = 1 - e.st / 0.7;
          e.aimBeam(handY, e.x + (p.x - e.x) * k, p.cy, e.z + (p.z - e.z) * k, 0.6 + k * 0.6);
        } else if (e.st > -0.6 && dxz < 19 && !p.dead) {
          e.aimBeam(handY, p.x, p.cy, p.z, 1.3);
          if (!e.tetherHit) {
            e.tetherHit = true;
            if (g.player.dashT > 0 || p.mode === 'flight') e.st = -1; // a dash or take-off snaps the root
            else g.hurtPlayer(Math.round(e.dmg * 0.4), p.x + dx, p.z + dz);
          }
          if (p.mode !== 'flight' && g.player.dashT <= 0) {
            p.vx -= (dx / dxz) * 34 * rawDt;
            p.vz -= (dz / dxz) * 34 * rawDt;
          }
        } else {
          if (e.beam) e.beam.visible = false;
          e.state = 'recover';
          e.st = 0.5;
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
      } else if (e.state === 'recover' || e.state === 'stun') {
        e.st -= dt;
        if (e.beam) e.beam.visible = false;
        if (e.st <= 0) {
          e.state = 'chase';
          e.cd = 1.6 + Math.random();
        }
      }
      if (e.state !== 'charge' && e.state !== 'stun' && Math.abs(p.cy - e.y) < 3) touch(reach);
      break;
    }
    case 'drone':
      droneStep(e, g, dt, rawDt, gh, dx, dz, dxz, toP);
      break;
    case 'pylon':
      break;
    case 'boss':
      bossStep(e, g, dt, dxz, toP, gh);
      break;
  }
}

let droneVolley = 0;

/**
 * Squad tactics, run once per frame before the enemies step: melee foes take engagement tokens by distance
 * (two Fiends, four Sprites at a time) and the rest are given holding slots spread evenly around the hero, so a
 * pack surrounds and rotates in instead of stacking into one blob. Drones share a ring of firing positions.
 */
export function updateSquads(g: Game) {
  const p = g.player;
  const groups: Record<'brute' | 'mite' | 'drone', Enemy[]> = { brute: [], mite: [], drone: [] };
  for (const e of g.enemies) {
    if (e.dead || e.idle || e.spawnT < 1) continue;
    if (e.kind === 'brute' || e.kind === 'mite' || e.kind === 'drone') groups[e.kind].push(e);
  }
  const tokens = { brute: 2, mite: 4, drone: 99 };
  for (const kind of ['brute', 'mite', 'drone'] as const) {
    const list = groups[kind];
    if (!list.length) continue;
    list.sort((a, b) => (a.x - p.x) ** 2 + (a.z - p.z) ** 2 - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2));
    const holders = list.slice(tokens[kind]);
    list.slice(0, tokens[kind]).forEach((e) => (e.engage = true));
    if (kind === 'drone') {
      // keep drones evenly spread: nudge each slot toward its share of the circle
      const base = Math.atan2(list[0].x - p.x, list[0].z - p.z);
      list.forEach((e, i) => {
        const want = base + (i / list.length) * TAU;
        e.slotAng += angleDiff(e.slotAng, want) * 0.02;
      });
      continue;
    }
    // holders: order by their current bearing so slots never cross, then spread over the circle
    holders.sort((a, b) => Math.atan2(a.x - p.x, a.z - p.z) - Math.atan2(b.x - p.x, b.z - p.z));
    const base = holders.length ? Math.atan2(holders[0].x - p.x, holders[0].z - p.z) : 0;
    holders.forEach((e, i) => {
      e.engage = false;
      if (kind === 'brute') e.slotAng = base + (i / Math.max(holders.length, 3)) * TAU;
    });
  }
}

/** A completed pylon purge stuns every Fiend nearby (blueprint animation `pylon_purge_stun`). */
export function purgeStun(g: Game, x: number, z: number, r: number) {
  for (const e of g.enemies) {
    if (e.dead || (e.kind !== 'brute' && e.kind !== 'drone')) continue;
    if ((e.x - x) ** 2 + (e.z - z) ** 2 > r * r) continue;
    e.state = 'stun';
    e.st = 3.2;
    if (e.beam) e.beam.visible = false;
    if (e.tele) e.tele.visible = false;
  }
}

/**
 * Null-Sentry Drone: magnetic suspension keeps it 5–7 m up, strafing around its squad slot; it paints the hero
 * with a red targeting laser and fires an energy spike, and every third attack deploys a fan of spikes that
 * lob down around the hero. Ability hits overload its core (stun, double damage) and it bursts when destroyed.
 */
function droneStep(e: Enemy, g: Game, dt: number, rawDt: number, gh: number, dx: number, dz: number, dxz: number, toP: number) {
  const p = g.player;
  e.cd -= dt;
  const hoverY = clamp(Math.max(gh + 5 + Math.sin(g.time * 0.7 + e.id) * 0.8, p.cy + 2.5), gh + 3, gh + 16);
  e.y += clamp(hoverY - e.y, -5 * dt, 5 * dt);
  if (e.state === 'stun') {
    e.st -= dt;
    if (e.beam) e.beam.visible = false;
    if (e.st <= 0) e.state = 'chase';
    return;
  }
  if (e.state === 'chase') {
    // strafe around the slot at ~15 m, flipping direction now and then
    if (Math.random() < rawDt * 0.25) e.strafe *= -1;
    e.slotAng += e.strafe * 0.35 * dt;
    const want = 15;
    const tx = p.x + Math.sin(e.slotAng) * want;
    const tz = p.z + Math.cos(e.slotAng) * want;
    const hx = tx - e.x;
    const hz = tz - e.z;
    const hd = Math.hypot(hx, hz) || 1;
    const sp = Math.min(e.speed, hd * 1.5);
    e.x += (hx / hd) * sp * dt;
    e.z += (hz / hd) * sp * dt;
    // squad fire discipline: drones take turns
    if (e.cd <= 0 && dxz < 34 && g.time > droneVolley) {
      droneVolley = g.time + 0.55;
      e.state = 'wind';
      e.st = 0.75;
      e.shots++;
      g.audio.sfx('warn');
    }
  } else if (e.state === 'wind') {
    e.st -= dt;
    const deploy = e.shots % 3 === 0;
    if (!deploy) e.aimBeam(0, p.x, p.cy, p.z, 0.5 + (1 - e.st / 0.75));
    if (e.st <= 0) {
      if (e.beam) e.beam.visible = false;
      if (deploy) {
        // spike deployment: a fan of spikes lobbed to land around the hero
        for (let i = 0; i < 4; i++) {
          const a = toP + (i / 4) * TAU;
          const r = 1.5 + Math.random() * 2.5;
          g.projectiles.fireEnemy(e.x, e.y - 0.6, e.z, p.x + Math.sin(a) * r + p.vx * 0.6, gh, p.z + Math.cos(a) * r + p.vz * 0.6, 16, Math.round(e.dmg * 0.8), 3, 14);
        }
      } else {
        const speed = 38;
        const T = leadTarget(g, e, speed, _v);
        g.projectiles.fireEnemy(e.x, e.y, e.z, T.x, T.y, T.z, speed, e.dmg);
      }
      g.audio.sfx('spit');
      e.state = 'chase';
      e.cd = 2.4 + Math.random() * 0.8;
    }
  }
  void dx;
  void dz;
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

  if (e.atk !== 'charge' && e.atk !== 'slam') {
    const want = e.variant === 'construct' ? 11 : 20;
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
      const construct = e.variant === 'construct';
      const pool: ('radial' | 'spiral' | 'summon' | 'charge' | 'volley' | 'slam')[] = construct
        ? e.phase === 1
          ? ['slam', 'volley', 'volley', 'radial', 'summon']
          : ['slam', 'slam', 'volley', 'spiral', 'radial', 'summon']
        : e.phase === 1
          ? ['radial', 'radial', 'volley', 'volley', 'summon']
          : e.phase === 2
            ? ['radial', 'spiral', 'spiral', 'volley', 'volley', 'summon', 'charge']
            : ['radial', 'spiral', 'spiral', 'volley', 'charge', 'charge', 'summon'];
      let pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick === 'summon' && g.enemies.filter((o) => !o.dead && o.kind !== 'boss').length > 7) pick = 'radial';
      e.atk = pick;
      e.atkN = 0;
      e.atkT = pick === 'radial' ? 0.7 : pick === 'spiral' ? 3.6 : pick === 'summon' ? 1.0 : pick === 'volley' ? 0.6 : pick === 'slam' ? 1.3 : 1.1;
      if (pick === 'slam') g.audio.sfx('warn');
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
          const kind = e.variant === 'construct' ? (i % 2 ? 'drone' : 'mite') : e.phase === 3 && i % 2 ? 'spitter' : 'mite';
          g.queueSpawn(kind, e.x + Math.cos(a) * r, e.z + Math.sin(a) * r, false);
        }
        e.atk = null;
        e.state = 'chase';
        e.cd = 3;
      }
      break;
    case 'slam': {
      // both fists raised, then a ground-shattering shockwave: a ring of bolts plus a close-range blast
      e.state = 'wind';
      if (e.j.armL && e.j.armR) {
        const k = 1 - Math.max(0, e.atkT) / 1.3;
        e.j.armL.rotation.x = -2.6 * k;
        e.j.armR.rotation.x = -2.6 * k;
      }
      if (e.tele && e.teleMat) {
        e.tele.visible = true;
        e.tele.position.y = 0.3;
        e.tele.rotation.y = 0;
        e.teleMat.opacity = 0.15 + 0.3 * (1 - e.atkT / 1.3);
      }
      if (e.atkT <= 0) {
        if (e.tele) e.tele.visible = false;
        fireRing(shots + 6, Math.random() * TAU, 13);
        g.particles.ring(_v.set(e.x, gh + 0.4, e.z), HOT.clone().multiplyScalar(3), 70, 30, 0.9, 1.1);
        g.shake(1.1);
        g.audio.sfx('boss');
        if (dxz < 9 && p.cy - gh < 3) g.hurtPlayer(Math.round(e.dmg * 1.5), e.x, e.z);
        g.world.props.debris.burst('rubble', e.x, gh + 0.5, e.z, 14, 9, VOIDBARK, 1.6);
        e.atk = null;
        e.state = 'chase';
        e.cd = [2.6, 2.1, 1.7][e.phase - 1];
      }
      break;
    }
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
