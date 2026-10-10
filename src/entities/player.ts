import * as THREE from 'three';
import { CAMERA } from '../engine/camera';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Game } from '../game';
import { Hero, idlePose, type HeroPose, type MoveMode } from './hero';
import { angleDiff, clamp, damp } from '../util/math';
import { Tether } from './tether';
import { HERO_GRAVITY, JUMP_SPEED, KCC, PHYSICS_PROFILES, TraversalMode } from '../physics/profiles';
import type { GroundHit } from '../physics/physics';
import type { SurfaceTag, TetherAnchor } from '../world/traversal';
import type { TravMode } from '../ui/traversal-ui';

export interface Intent {
  /** desired world-space horizontal direction (length ≤ 1) */
  mx: number;
  mz: number;
  jump: boolean;
  flightToggle: boolean;
  up: boolean;
  down: boolean;
  boost: boolean;
  dash: boolean;
  attackPressed: boolean;
  attackHeld: boolean;
  aim: boolean;
  /** Released the tether / fired it (T). The game resolves the target. */
  tether: boolean;
}

export const BASE_SPEED = 8.5;
export const GRAVITY = HERO_GRAVITY;
const JUMP_V = JUMP_SPEED;
const FLY = PHYSICS_PROFILES[TraversalMode.FREE_FLIGHT];
const LEV = PHYSICS_PROFILES[TraversalMode.AQUATIC_LEVITATION];
/** Thruster pack: terminal speed = sqrt(thrust / drag) = 22 m/s cruising, 1.8× that on afterburner. */
const FLIGHT_THRUST = FLY.acceleration;
const FLIGHT_DRAG = FLIGHT_THRUST / (FLY.maxSpeed * FLY.maxSpeed);
const BOOST_MUL = KCC.flightBoost * KCC.flightBoost;
const HOVER_H = KCC.hoverHeight;
export const MAX_FIBER = 100;
export const TETHER_RANGE = 42;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();
const _hand = new THREE.Vector3();

/**
 * Third-person controller on Rapier's kinematic character controller: bipedal walk (≤ 45° slopes, autostep,
 * snap-to-ground, platform riding), 6-DOF thruster flight with thrust/drag/gravity, conducted-flow levitation,
 * and the spring-damper Mycelial Tether.
 */
export class Player {
  readonly hero: Hero;
  readonly group: THREE.Group;
  x = 0; y = 0; z = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0;
  mode: MoveMode = 'ground';
  grounded = true;
  hp = 100;
  res = 0;
  /** Mycelial Fiber: flight/levitation fuel burned before Resonance. */
  fiber = 0;
  shield = 0;
  dead = false;
  invuln = 0;
  hurtT = 0;
  dashCD = 0;
  dashT = 0;
  dashDirX = 0;
  dashDirZ = 0;
  dashHit = new Set<number>();
  dashCount = 0;
  fireCD = 0;
  aiming = false;
  // melee combo
  atkActive = false;
  atkIdx = 0;
  atkT = 0;
  atkDur = 0.34;
  atkHit = false;
  comboT = 0;
  private coyote = 0;
  private trailAcc = 0;
  private stepAcc = 0;
  private bank = 0;
  private prevYaw = 0;
  private pose: HeroPose = idlePose();
  private blob: THREE.Mesh;
  private blobMat: MeshBasicNodeMaterial;
  speed = 0;
  /** true during the frame the hero left the ground by jumping */
  justJumped = false;
  readonly tether: Tether;
  tetherCD = 0;
  /** Levitation chosen from the wheel (hovers anywhere while fuel lasts), as opposed to riding a river. */
  private levManual = false;
  readonly gnd: GroundHit = { y: 0, nx: 0, ny: 1, nz: 0, collider: null };
  /** Height of the surface under the hero (terrain or platform). */
  groundY = 0;
  private fallV = 0;
  private probe: ((x: number, z: number) => number) | null = null;

  constructor(skin: 'resonant' | 'verdant' | 'void' = 'resonant') {
    this.hero = new Hero(skin);
    this.group = this.hero.root;
    this.blobMat = new MeshBasicNodeMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
    this.blob = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16).rotateX(-Math.PI / 2), this.blobMat);
    this.blob.renderOrder = 1;
    this.tether = new Tether(new THREE.Color(0xc2ff7a).multiplyScalar(1.4));
  }

  get blobMesh() {
    return this.blob;
  }
  /** chest height world position (target for enemy aim) */
  get cy() {
    return this.y + (this.mode === 'flight' ? 0.5 : 1.05);
  }
  get cameraTarget() {
    return _v.set(this.x, this.y + (this.mode === 'flight' ? 1.2 : CAMERA.height), this.z);
  }

  reset(x: number, y: number, z: number, hp: number) {
    this.x = x; this.y = y; this.z = z;
    this.vx = this.vy = this.vz = 0;
    this.hp = hp;
    this.dead = false;
    this.mode = 'ground';
    this.grounded = true;
    this.invuln = 1.5;
    this.fireCD = 0;
    this.dashT = 0;
    this.dashCD = 0;
    this.atkActive = false;
    this.comboT = 0;
    this.shield = 0;
    this.group.visible = true;
    this.hero.root.scale.setScalar(1);
    this.tether.release();
    this.levManual = false;
  }

  /** Teleport without resetting stats (fast travel). */
  place(x: number, y: number, z: number) {
    this.x = x; this.y = y; this.z = z;
    this.vx = this.vy = this.vz = 0;
    this.mode = 'ground';
    this.tether.release();
    this.levManual = false;
  }

  get travMode(): TravMode {
    if (this.tether.active) return 'tether';
    if (this.mode === 'flight') return 'flight';
    if (this.mode === 'levitate') return 'levitate';
    return 'walk';
  }

  /** Burn flight fuel: Mycelial Fiber first, then Resonance. Returns false when both are empty. */
  spendFuel(n: number) {
    if (this.fiber >= n) {
      this.fiber -= n;
      return true;
    }
    n -= this.fiber;
    this.fiber = 0;
    if (this.res <= 0) return false;
    this.res = Math.max(0, this.res - n);
    return true;
  }
  get fuel() {
    return this.fiber + this.res;
  }

  /** Switch traversal mode from the wheel. Returns a reason string when the switch is refused. */
  requestMode(g: Game, m: TravMode): string | null {
    if (m === 'walk') {
      this.tether.release();
      this.levManual = false;
      if (this.mode === 'flight' || this.mode === 'levitate') {
        this.mode = 'air';
        this.vy = Math.min(this.vy, 0);
      }
      return null;
    }
    if (m === 'flight') {
      if (this.fuel < 10) return 'Not enough fuel — gather Mycelial Fiber or Resonance';
      this.tether.release();
      this.levManual = false;
      if (this.mode !== 'flight') this.startFlight(g);
      return null;
    }
    if (m === 'levitate') {
      if (this.fuel < 5) return 'Not enough fuel to levitate';
      this.tether.release();
      this.levManual = true;
      this.mode = 'levitate';
      this.vy = Math.max(this.vy, 2);
      g.particles.ring(_v.set(this.x, this.groundY + 0.4, this.z), g.palette.accent2HDR, 18, 4, 0.4, 0.6);
      g.audio.sfx('dash', 0.6);
      return null;
    }
    return null;
  }

  /** Latch the tether onto a world point or anchor. */
  fireTether(g: Game, point: THREE.Vector3, anchor: TetherAnchor | null) {
    this.handPos(_hand);
    this.tether.attach(_hand, point, anchor);
    this.tetherCD = 0.35;
    this.levManual = false;
    if (this.mode === 'flight' || this.mode === 'levitate') this.mode = 'air';
    this.grounded = false;
    g.audio.sfx('dash', 1.8);
    g.particles.burst(_v.copy(this.tether.anchor), new THREE.Color(0xc2ff7a).multiplyScalar(2.4), 14, 5, 0.4, 0.5);
  }

  /** World position of the casting hand (tether origin). */
  handPos(out: THREE.Vector3) {
    return out.set(this.x + Math.sin(this.yaw + 0.5) * 0.35, this.y + 1.35, this.z + Math.cos(this.yaw + 0.5) * 0.35);
  }

  update(g: Game, dt: number, it: Intent, camYaw: number, camFwd: THREE.Vector3) {
    const D = g.derived;
    this.invuln = Math.max(0, this.invuln - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.dashCD -= dt;
    this.fireCD -= dt;
    this.comboT -= dt;
    this.coyote -= dt;
    this.justJumped = false;
    const active = g.mode === 'play' && !this.dead;
    const moving = Math.hypot(it.mx, it.mz) > 0.05;
    this.aiming = active && it.aim && !this.atkActive;
    const atkSpeed = D.attackSpeed * (g.run.tiers.flow >= 3 ? 1.5 : 1);

    // ---------------------------------------------------------------- melee combo
    if (active) {
      if (!this.atkActive && !this.aiming && (it.attackPressed || it.attackHeld)) {
        this.atkIdx = this.comboT > 0 ? (this.atkIdx + 1) % 3 : 0;
        this.atkActive = true;
        this.atkT = 0;
        this.atkHit = false;
        this.atkDur = [0.34, 0.34, 0.52][this.atkIdx] / atkSpeed;
        g.combat.beginSwing(this);
      }
      if (this.atkActive) {
        this.atkT += dt / this.atkDur;
        if (!this.atkHit && this.atkT >= 0.4) {
          this.atkHit = true;
          g.combat.meleeHit(this);
        }
        if (this.atkT >= 1) {
          this.atkActive = false;
          this.comboT = 0.5;
        }
      }
      if (this.aiming && this.fireCD <= 0) {
        this.fireCD = 0.16 / atkSpeed;
        g.combat.fireBolt(this);
      }
    } else {
      this.atkActive = false;
    }

    // ---------------------------------------------------------------- facing
    let faceTarget = this.yaw;
    if (this.mode === 'flight') {
      faceTarget = moving ? Math.atan2(this.vx, this.vz) : camYaw;
      if (Math.hypot(this.vx, this.vz) < 2) faceTarget = camYaw;
    } else if (this.aiming || this.atkActive) faceTarget = this.atkActive ? g.combat.swingYaw : camYaw;
    else if (moving) faceTarget = Math.atan2(it.mx, it.mz);
    this.yaw += angleDiff(this.yaw, faceTarget) * Math.min(1, dt * (this.atkActive ? 22 : 13));

    // ---------------------------------------------------------------- locomotion
    this.tetherCD -= dt;
    if (!this.dead) {
      // dash (any mode but flight)
      if (active && it.dash && this.dashCD <= 0 && this.dashT <= 0) {
        this.dashT = g.run.tiers.flow >= 1 ? 0.22 : 0.18;
        this.dashCD = (g.run.tiers.flow >= 1 ? 0.6 : 1.0) * D.dashCdMul;
        this.dashHit.clear();
        if (moving) {
          this.dashDirX = it.mx / Math.hypot(it.mx, it.mz);
          this.dashDirZ = it.mz / Math.hypot(it.mx, it.mz);
        } else {
          this.dashDirX = Math.sin(this.yaw);
          this.dashDirZ = Math.cos(this.yaw);
        }
        this.dashCount++;
        if (this.tether.active) this.tether.release();
        g.combat.onDash(this);
      }

      g.world.physics.groundBelow(this.x, this.y + 0.9, this.z, 90, this.gnd);
      this.groundY = this.gnd.y;

      const speedMul = D.speedMul * (this.aiming ? 0.72 : 1) * (this.atkActive ? 0.5 : 1);
      if (this.tether.active) this.swing(g, dt, it, active);
      else if (this.mode === 'flight') this.flight(g, dt, it, camFwd, active);
      else if (this.mode === 'levitate') this.levitate(g, dt, it, speedMul, active, moving);
      else this.walk(g, dt, it, speedMul, active, moving);

      // dash velocity override
      if (this.dashT > 0) {
        this.dashT -= dt;
        const sp = 36;
        this.vx = this.dashDirX * sp;
        this.vz = this.dashDirZ * sp;
        this.invuln = Math.max(this.invuln, 0.14);
        g.particles.emit(this.x, this.y + 1, this.z, 0, 0.3, 0, g.palette.accentHDR, 0.9, 0.5, 3);
        if (g.run.tiers.flow >= 1) g.combat.dashDamage(this);
        g.world.props.strike(this.x + this.dashDirX, this.y + 0.8, this.z + this.dashDirZ, 1.4, 0, 9, this.dashDirX, this.dashDirZ);
      }

      this.move(g, dt, it, active);

      // resonance regen (not while burning fuel)
      if (this.mode !== 'flight' && !(this.mode === 'levitate' && this.levManual)) this.res = Math.min(D.maxRes, this.res + D.resRegen * dt);
      else this.res = Math.min(D.maxRes, this.res);
      this.fiber = Math.min(MAX_FIBER, this.fiber);
    }

    // ---------------------------------------------------------------- visuals
    this.speed = Math.hypot(this.vx, this.vz);
    const dyaw = angleDiff(this.prevYaw, this.yaw);
    this.prevYaw = this.yaw;
    this.bank = damp(this.bank, clamp(-dyaw / Math.max(dt, 0.001) * 0.18, -1, 1), 6, dt);
    const gh = this.groundY;
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
    const pose = this.pose;
    pose.speed = this.speed;
    pose.maxSpeed = BASE_SPEED;
    pose.vy = this.vy;
    pose.mode = this.mode;
    pose.grounded = this.grounded;
    pose.attack.active = this.atkActive;
    pose.attack.idx = this.atkIdx;
    pose.attack.t = this.atkT;
    pose.aiming = this.aiming;
    pose.dashing = this.dashT > 0;
    pose.hurt = this.hurtT > 0 ? this.hurtT / 0.6 : 0;
    pose.dead = this.dead;
    pose.bank = this.bank;
    // foot planting reads the terrain only while standing on it (platforms are flat)
    const terr = g.world.terrain;
    const onTerrain = Math.abs(gh - terr.heightAt(this.x, this.z)) < 0.15;
    pose.ground = onTerrain ? (this.probe ??= (x: number, z: number) => g.world.terrain.heightAt(x, z)) : null;
    this.hero.update(dt, pose);
    this.group.visible = !(this.invuln > 0 && this.hurtT > 0 && Math.sin(g.time * 50) > 0) || this.dead;
    this.blob.position.set(this.x, gh + 0.08, this.z);
    const h = Math.max(0, this.y - gh);
    this.blob.scale.setScalar(1 / (1 + h * 0.18));
    this.blobMat.opacity = 0.38 / (1 + h * 0.25);
    this.blob.visible = !this.dead;
    g.gfx.playerLight.position.set(this.x, this.y + 2.6, this.z);
    const A = this.tether.anchor;
    const tension = this.tether.active ? clamp((this.handPos(_hand).distanceTo(A) - this.tether.restLen) / 2 + 0.6, 0, 1) : 0;
    this.tether.update(dt, g.time, this.handPos(_hand), tension);

    // movement dust / root tracks
    if (active && this.grounded && this.speed > 3 && this.mode === 'ground') {
      this.trailAcc += dt;
      if (this.trailAcc > 0.07) {
        this.trailAcc = 0;
        g.particles.emit(this.x, gh + 0.2, this.z, (Math.random() - 0.5) * 0.8, 0.5, (Math.random() - 0.5) * 0.8, g.palette.accentHDR, 0.28, 0.55, 2);
      }
      this.stepAcc += dt;
      if (this.stepAcc > 2.4) {
        this.stepAcc = 0;
        g.world.mycelium.seed(this.x, this.z, 1, 1, 22);
      }
    }
    if (this.mode === 'flight' && active) {
      g.particles.emit(this.x - Math.sin(this.yaw) * 0.3, this.y + 0.9, this.z - Math.cos(this.yaw) * 0.3, -this.vx * 0.1, -this.vy * 0.1 - 0.5, -this.vz * 0.1, g.palette.accentHDR, 0.55, 0.55, 2);
    }
    if (this.mode === 'levitate' && active && (this.speed > 1 || this.levManual)) {
      g.particles.emit(this.x, gh + 0.5, this.z, (Math.random() - 0.5), 0.8, (Math.random() - 0.5), g.palette.accent2HDR, 0.4, 0.7, 2);
    }
  }

  // ---------------------------------------------------------------- modes

  private walk(g: Game, dt: number, it: Intent, speedMul: number, active: boolean, moving: boolean) {
    const terrain = g.world.terrain;
    const maxSp = BASE_SPEED * speedMul;
    const k = this.grounded ? (moving ? 14 : 10) : 3.2;
    const tx = active && moving ? it.mx * maxSp : 0;
    const tz = active && moving ? it.mz * maxSp : 0;
    this.vx = damp(this.vx, tx, k, dt);
    this.vz = damp(this.vz, tz, k, dt);

    // conducted flow: rivers of light lift the hero automatically
    const river = terrain.riverAt(this.x, this.z);
    // mycelial cords lift you too, when you run with their grain
    const cord = river > 0.5 ? 0 : g.cordAt(this.x, this.z);
    const f = cord > 0.65 ? g.flowAt(this.x, this.z) : null;
    const along = f ? (this.vx * f.x + this.vz * f.y) / ((Math.hypot(this.vx, this.vz) || 1) * (Math.hypot(f.x, f.y) || 1)) : 0;
    if ((river > 0.5 || (cord > 0.65 && Math.hypot(this.vx, this.vz) > 6 && Math.abs(along) > 0.85)) && this.y - this.groundY < 2.2 && this.vy <= 0.5) {
      this.mode = 'levitate';
      this.levManual = false;
      g.particles.ring(_v.set(this.x, this.groundY + 0.4, this.z), g.palette.accent2HDR, 18, 4, 0.4, 0.6);
      return;
    }

    if (this.grounded) this.coyote = 0.1;
    if (active && it.jump) {
      if (this.coyote > 0) {
        this.vy = JUMP_V;
        this.grounded = false;
        this.coyote = 0;
        this.justJumped = true;
        g.audio.sfx('dash', 1.4);
      } else if (this.mode === 'air' && this.fuel >= 10 && !this.justJumped) {
        this.startFlight(g);
        return;
      }
    }
    if (active && it.flightToggle && this.fuel >= 10) {
      this.startFlight(g);
      return;
    }
    // gravity (Rapier's controller has none of its own): stay pressed onto the ground while grounded
    if (this.grounded && !this.justJumped) this.vy = -2;
    else this.vy -= GRAVITY * dt;
  }

  private levitate(g: Game, dt: number, it: Intent, speedMul: number, active: boolean, moving: boolean) {
    const terrain = g.world.terrain;
    const river = terrain.riverAt(this.x, this.z);
    // conducted flow: a river, or one of the glowing mycelial cords
    const onFlow = river > 0.25 || g.cordAt(this.x, this.z) > 0.3;
    if (!onFlow && !this.levManual) {
      this.mode = 'air';
      return;
    }
    // conducted flow is fast (14 m/s profile); hovering off the flow lines is a little quicker than walking
    const maxSp = (onFlow ? LEV.maxSpeed : BASE_SPEED * 1.15) * speedMul;
    const tx = active && moving ? it.mx * maxSp : 0;
    const tz = active && moving ? it.mz * maxSp : 0;
    this.vx = damp(this.vx, tx, moving ? LEV.acceleration * 0.4 : LEV.dragDamping, dt);
    this.vz = damp(this.vz, tz, moving ? LEV.acceleration * 0.4 : LEV.dragDamping, dt);
    const surface = river > 0.25 ? Math.max(this.groundY, terrain.waterY(this.x, this.z)) : this.groundY;
    const target = surface + HOVER_H + Math.sin(g.time * 2.2) * 0.06;
    this.vy = clamp((target - this.y) * 9, -14, 14);
    this.grounded = false;
    if (onFlow) {
      // flow-induced draft: the current carries the hero downstream
      const f = g.flowAt(this.x, this.z);
      // cords carry you whichever way you ride them; rivers only downstream
      const sgn = river <= 0.25 && this.vx * f.x + this.vz * f.y < 0 ? -1 : 1;
      this.vx += f.x * sgn * dt * 2.4;
      this.vz += f.y * sgn * dt * 2.4;
    } else if (active && !this.spendFuel(LEV.resonanceCostPerSec * 2.5 * g.derived.flightDrain * dt)) {
      this.levManual = false;
      this.mode = 'air';
      g.ui.toast('Fuel spent — levitation collapses');
      return;
    }
    if (active && it.jump) {
      this.vy = JUMP_V * 0.9;
      this.mode = 'air';
      this.levManual = false;
      this.justJumped = true;
      return;
    }
    if (active && it.flightToggle && this.fuel >= 10) this.startFlight(g);
  }

  private startFlight(g: Game) {
    this.mode = 'flight';
    this.grounded = false;
    this.levManual = false;
    this.vy = Math.max(this.vy, 4);
    g.particles.burst(_v.set(this.x, this.y + 0.5, this.z), g.palette.accentHDR, 16, 6, 0.5, 0.6);
    g.audio.sfx('dash', 0.7);
  }

  /** 6-DOF thruster flight: thrust along the view, quadratic drag, hover assist while fuel lasts. */
  private flight(g: Game, dt: number, it: Intent, camFwd: THREE.Vector3, active: boolean) {
    const D = g.derived;
    _fwd.copy(camFwd);
    const hl = Math.hypot(_fwd.x, _fwd.z) || 1;
    const fx = _fwd.x / hl;
    const fzh = _fwd.z / hl;
    const fwdAmt = it.mx * fx + it.mz * fzh;
    const rgtAmt = it.mx * -fzh + it.mz * fx;
    _right.set(-fzh, 0, fx);
    let dx = 0, dy = 0, dz = 0;
    if (active) {
      dx = _fwd.x * fwdAmt + _right.x * rgtAmt;
      dy = _fwd.y * fwdAmt + ((it.up ? 1 : 0) - (it.down ? 1 : 0)) * 0.6;
      dz = _fwd.z * fwdAmt + _right.z * rgtAmt;
    }
    const thrusting = Math.hypot(dx, dy, dz) > 0.05;
    const boost = active && it.boost && thrusting;
    const T = FLIGHT_THRUST * D.speedMul * (boost ? BOOST_MUL : 1);
    const v = Math.hypot(this.vx, this.vy, this.vz);
    let ax = dx * T - FLIGHT_DRAG * v * this.vx;
    let ay = dy * T - FLIGHT_DRAG * v * this.vy;
    let az = dz * T - FLIGHT_DRAG * v * this.vz;
    if (!thrusting) {
      // stabilisers bleed off momentum when the stick is released
      ax -= this.vx * 1.6;
      ay -= this.vy * 1.6;
      az -= this.vz * 1.6;
    }
    const drain = FLY.resonanceCostPerSec * (boost ? 2.4 : 1) * D.flightDrain * (thrusting ? 1 : 0.35);
    const fuelled = !active || this.spendFuel(drain * dt);
    if (!fuelled) ay -= GRAVITY; // hover assist (cancelling gravity) only while fuel lasts
    this.vx += ax * dt;
    this.vy += ay * dt;
    this.vz += az * dt;
    const ceiling = g.world.terrain.heightAt(this.x, this.z) + 70;
    if (this.y > ceiling) this.vy = Math.min(this.vy, 0);
    if (active && it.flightToggle) {
      this.mode = 'air';
      this.vy = Math.min(this.vy, 0);
    }
    if (!fuelled) {
      this.mode = 'air';
      g.ui.toast('Fuel depleted — thrusters offline');
    }
  }

  /** Spring-damper hypha: reels in, swings like a pendulum, slingshots on jump. */
  private swing(g: Game, dt: number, it: Intent, active: boolean) {
    const t = this.tether;
    const A = t.anchor;
    const cx = this.x;
    const cy = this.y + 1.1;
    const cz = this.z;
    let dx = A.x - cx;
    let dy = A.y - cy;
    let dz = A.z - cz;
    const L = Math.hypot(dx, dy, dz) || 1e-3;
    dx /= L;
    dy /= L;
    dz /= L;
    t.restLen = Math.max(2.0, t.restLen - 11 * dt);
    let ax = 0;
    let ay = -GRAVITY;
    let az = 0;
    if (L > t.restLen) {
      const k = 70 * (L - t.restLen);
      ax += dx * k;
      ay += dy * k;
      az += dz * k;
    }
    // damp motion along the rope (mostly outward), keep the tangential swing
    const vr = this.vx * dx + this.vy * dy + this.vz * dz;
    const c = vr < 0 ? 7 : 1.2;
    ax -= dx * vr * c;
    ay -= dy * vr * c;
    az -= dz * vr * c;
    if (active) {
      ax += it.mx * 12;
      az += it.mz * 12;
    }
    this.vx += ax * dt;
    this.vy += ay * dt;
    this.vz += az * dt;
    const sp = Math.hypot(this.vx, this.vy, this.vz);
    if (sp > 32) {
      this.vx *= 32 / sp;
      this.vy *= 32 / sp;
      this.vz *= 32 / sp;
    }
    this.mode = 'air';
    this.grounded = false;
    const release = (hop: number) => {
      t.release();
      this.vy = Math.max(this.vy, 0) + hop;
      this.justJumped = true;
    };
    if (active && (it.jump || it.tether) && t.t > 0.12) {
      release(it.jump ? 7 : 0); // slingshot
      g.particles.burst(_v.set(this.x, this.y + 1, this.z), new THREE.Color(0xc2ff7a).multiplyScalar(2), 10, 5, 0.4, 0.4);
    } else if (L < 2.3) release(5.5);
    else if (t.t > 6 || L > TETHER_RANGE + 12) release(0);
  }

  /** Hand the per-frame translation to Rapier's controller and read back where the capsule may go. */
  private move(g: Game, dt: number, it: Intent, active: boolean) {
    const ph = g.world.physics;
    const ch = ph.char;
    let dx = this.vx * dt;
    let dy = this.vy * dt;
    let dz = this.vz * dt;
    // ride kinematic platforms
    const tag = ph.tagOf<SurfaceTag>(ch.ground ?? (this.y - this.groundY < 0.25 ? this.gnd.collider : null));
    if (this.grounded && tag?.platform) {
      const d = tag.platform.frameDelta;
      dx += d.x;
      dy += d.y;
      dz += d.z;
    }
    ch.setSnap(this.mode === 'ground' && this.vy <= 0 && !this.justJumped);
    this.fallV = this.vy;
    const r = ch.move(this.x, this.y, this.z, dx, dy, dz, dt);
    let nx = r.x;
    let nz = r.z;
    const R = g.world.radius * (this.mode === 'flight' ? 1.1 : 1.01);
    const rr = Math.hypot(nx, nz);
    if (!g.world.terrain.wild && rr > R) {
      nx *= R / rr;
      nz *= R / rr;
    }
    g.stats.distance += Math.hypot(nx - this.x, nz - this.z);
    this.x = nx;
    // safety net: the analytic terrain is never penetrable (covers chunks that are not streamed in yet)
    const floor = g.world.terrain.heightAt(nx, nz);
    this.y = Math.max(r.y, floor - 0.02);
    if (r.y < floor - 0.02) r.grounded = true;
    this.z = nz;
    if (r.ceiling && this.vy > 0) this.vy = 0;

    if (this.mode === 'ground' || this.mode === 'air') {
      if (r.grounded && this.vy <= 0 && !this.tether.active) {
        if (!this.grounded && this.fallV < -16) g.onHardLanding(this, -this.fallV);
        this.grounded = true;
        this.mode = 'ground';
        this.vy = 0;
        const under = ph.tagOf<SurfaceTag>(ch.ground) ?? ph.tagOf<SurfaceTag>(this.gnd.collider);
        if (under?.bounce && this.y - this.groundY < 0.4) {
          // violet bounce caps fling the hero skyward
          this.vy = under.bounce;
          this.grounded = false;
          this.mode = 'air';
          this.justJumped = true;
          g.audio.sfx('dash', 0.5);
          g.particles.ring(_v.set(this.x, this.y + 0.2, this.z), new THREE.Color(0xd16bff).multiplyScalar(2.4), 20, 7, 0.4, 0.6);
          g.shake(0.15);
        }
      } else if (!r.grounded) {
        this.grounded = false;
        this.mode = 'air';
      }
    } else if (this.mode === 'flight' && active && it.down && r.grounded) {
      // gentle touchdown when descending onto a surface
      this.mode = 'ground';
      this.grounded = true;
      this.vy = 0;
    }
  }

  dispose() {
    this.hero.dispose();
    this.blob.geometry.dispose();
    this.blobMat.dispose();
    this.tether.dispose();
  }
}
