import * as THREE from 'three';
import type { Game } from '../game';
import { Hero, idlePose, type HeroPose, type MoveMode } from './hero';
import { angleDiff, clamp, damp } from '../util/math';

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
}

export const BASE_SPEED = 8.5;
const GRAVITY = 30;
const JUMP_V = 11.5;
const FLIGHT_SPEED = 21;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();
const _xz = { x: 0, z: 0 };

/** Third-person controller: ground walk, air, 6-axis free flight, and river levitation. */
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
  private blobMat: THREE.MeshBasicMaterial;
  speed = 0;
  /** true during the frame the hero left the ground by jumping */
  justJumped = false;

  constructor(skin: 'resonant' | 'verdant' | 'void' = 'resonant') {
    this.hero = new Hero(skin);
    this.group = this.hero.root;
    this.blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
    this.blob = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16).rotateX(-Math.PI / 2), this.blobMat);
    this.blob.renderOrder = 1;
  }

  get blobMesh() {
    return this.blob;
  }
  /** chest height world position (target for enemy aim) */
  get cy() {
    return this.y + (this.mode === 'flight' ? 0.5 : 1.05);
  }
  get cameraTarget() {
    return _v.set(this.x, this.y + (this.mode === 'flight' ? 1.2 : 1.55), this.z);
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
  }

  /** Teleport without resetting stats (fast travel). */
  place(x: number, y: number, z: number) {
    this.x = x; this.y = y; this.z = z;
    this.vx = this.vy = this.vz = 0;
    this.mode = 'ground';
  }

  update(g: Game, dt: number, it: Intent, camYaw: number, camFwd: THREE.Vector3) {
    const D = g.derived;
    const terrain = g.world.terrain;
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
    if (!this.dead) {
      // dash (any mode)
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
        g.combat.onDash(this);
      }

      const speedMul = D.speedMul * (this.aiming ? 0.72 : 1) * (this.atkActive ? 0.5 : 1);
      if (this.mode === 'flight') this.flight(g, dt, it, camFwd, active);
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
      }

      // integrate horizontal
      this.integrate(g, dt);

      // resonance regen (not while flying)
      if (this.mode !== 'flight') this.res = Math.min(D.maxRes, this.res + D.resRegen * dt);
      else this.res = Math.min(D.maxRes, this.res);
    }

    // ---------------------------------------------------------------- visuals
    this.speed = Math.hypot(this.vx, this.vz);
    const dyaw = angleDiff(this.prevYaw, this.yaw);
    this.prevYaw = this.yaw;
    this.bank = damp(this.bank, clamp(-dyaw / Math.max(dt, 0.001) * 0.18, -1, 1), 6, dt);
    const gh = terrain.heightAt(this.x, this.z);
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
    this.hero.update(dt, pose);
    this.group.visible = !(this.invuln > 0 && this.hurtT > 0 && Math.sin(g.time * 50) > 0) || this.dead;
    this.blob.position.set(this.x, gh + 0.08, this.z);
    const h = Math.max(0, this.y - gh);
    this.blob.scale.setScalar(1 / (1 + h * 0.18));
    this.blobMat.opacity = 0.38 / (1 + h * 0.25);
    this.blob.visible = !this.dead;
    g.gfx.playerLight.position.set(this.x, this.y + 2.6, this.z);

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
    if (this.mode === 'levitate' && active && this.speed > 1) {
      g.particles.emit(this.x, gh + 0.5, this.z, (Math.random() - 0.5), 0.8, (Math.random() - 0.5), g.palette.accent2HDR, 0.4, 0.7, 2);
    }
  }

  private walk(g: Game, dt: number, it: Intent, speedMul: number, active: boolean, moving: boolean) {
    const terrain = g.world.terrain;
    const maxSp = BASE_SPEED * speedMul;
    const k = this.grounded || this.mode === 'levitate' ? 14 : 3.2;
    const tx = active && moving ? it.mx * maxSp : 0;
    const tz = active && moving ? it.mz * maxSp : 0;
    this.vx = damp(this.vx, tx, this.grounded || this.mode === 'levitate' ? (moving ? k : 10) : k, dt);
    this.vz = damp(this.vz, tz, this.grounded || this.mode === 'levitate' ? (moving ? k : 10) : k, dt);

    const gh = terrain.heightAt(this.x, this.z);
    const river = terrain.riverAt(this.x, this.z);

    // levitation over the river of light
    if (this.mode === 'levitate') {
      if (river < 0.25) this.mode = 'ground';
    } else if (river > 0.5 && this.y - gh < 2.2 && this.vy <= 0.5) {
      this.mode = 'levitate';
      g.particles.ring(_v.set(this.x, gh + 0.4, this.z), g.palette.accent2HDR, 18, 4, 0.4, 0.6);
    }

    if (this.mode === 'levitate') {
      const target = terrain.waterY(this.x, this.z) + 1.35 + Math.sin(g.time * 2.2) * 0.06;
      this.y = damp(this.y, target, 9, dt);
      this.vy = 0;
      this.grounded = false;
      if (active && it.jump) {
        this.vy = JUMP_V * 0.9;
        this.mode = 'air';
        this.justJumped = true;
      }
      const f = g.flowAt(this.x, this.z);
      this.vx += f.x * dt * 2.4;
      this.vz += f.y * dt * 2.4;
      if (active && it.flightToggle && this.res >= 10) this.startFlight(g);
      return;
    }

    // gravity & jump
    if (this.grounded) {
      this.coyote = 0.1;
    }
    if (active && it.jump) {
      if (this.coyote > 0) {
        this.vy = JUMP_V;
        this.grounded = false;
        this.coyote = 0;
        this.justJumped = true;
        g.audio.sfx('dash', 1.4);
      } else if (this.mode === 'air' && this.res >= 10 && !this.justJumped) {
        this.startFlight(g);
        return;
      }
    }
    if (active && it.flightToggle && this.res >= 10) {
      this.startFlight(g);
      return;
    }
    this.vy -= GRAVITY * dt;
    this.y += this.vy * dt;
    const gh2 = terrain.heightAt(this.x, this.z);
    if (this.y <= gh2) {
      if (this.vy < -16) g.onHardLanding(this, -this.vy);
      this.y = gh2;
      this.vy = 0;
      this.grounded = true;
      this.mode = 'ground';
    } else {
      this.grounded = this.y - gh2 < 0.08 && this.vy <= 0;
      this.mode = this.grounded ? 'ground' : 'air';
    }
  }

  private startFlight(g: Game) {
    this.mode = 'flight';
    this.grounded = false;
    this.vy = Math.max(this.vy, 4);
    g.particles.burst(_v.set(this.x, this.y + 0.5, this.z), g.palette.accentHDR, 16, 6, 0.5, 0.6);
    g.audio.sfx('dash', 0.7);
  }

  private flight(g: Game, dt: number, it: Intent, camFwd: THREE.Vector3, active: boolean) {
    const D = g.derived;
    const terrain = g.world.terrain;
    // 6-axis: forward/back along the view direction (pitch included), strafe, ascend/descend
    _fwd.copy(camFwd);
    const hl = Math.hypot(_fwd.x, _fwd.z) || 1;
    const fx = _fwd.x / hl;
    const fzh = _fwd.z / hl;
    // it.mx/mz is already a world-space direction; split it into view-forward and view-right amounts
    const fwdAmt = it.mx * fx + it.mz * fzh;
    const rgtAmt = it.mx * -fzh + it.mz * fx;
    _right.set(-fzh, 0, fx);
    const sp = FLIGHT_SPEED * D.speedMul * (it.boost ? 1.7 : 1);
    let tx = 0, ty = 0, tz = 0;
    if (active) {
      tx = (_fwd.x * fwdAmt + _right.x * rgtAmt) * sp;
      ty = _fwd.y * fwdAmt * sp + ((it.up ? 1 : 0) - (it.down ? 1 : 0)) * sp * 0.6;
      tz = (_fwd.z * fwdAmt + _right.z * rgtAmt) * sp;
    }
    const k = 2.8;
    this.vx = damp(this.vx, tx, k, dt);
    this.vy = damp(this.vy, ty, k, dt);
    this.vz = damp(this.vz, tz, k, dt);
    const drain = (it.boost ? 12 : 5) * D.flightDrain;
    if (active) this.res = Math.max(0, this.res - drain * dt * (Math.hypot(tx, ty, tz) > 1 ? 1 : 0.35));
    const gh = terrain.heightAt(this.x, this.z);
    this.y += this.vy * dt;
    const floor = gh + 0.4;
    if (this.y < floor) {
      this.y = floor;
      if (this.vy < 0) this.vy = 0;
      // gentle touchdown when descending near the ground
      if (active && it.down) {
        this.mode = 'ground';
        this.grounded = true;
        return;
      }
    }
    this.y = Math.min(this.y, gh + 70);
    if (active && (it.flightToggle || this.res <= 0)) {
      this.mode = 'air';
      this.vy = Math.min(this.vy, 0);
    }
    if (this.res <= 0 && active) g.ui.toast('Resonance depleted — thrusters offline');
  }

  private integrate(g: Game, dt: number) {
    const terrain = g.world.terrain;
    let nx = this.x + this.vx * dt;
    let nz = this.z + this.vz * dt;
    if (this.mode === 'ground' || this.mode === 'air') {
      // slope constraint: refuse to climb walls steeper than ~45°
      const oldH = terrain.heightAt(this.x, this.z);
      const newH = terrain.heightAt(nx, nz);
      if (newH - oldH > 0.02 && terrain.slopeAt(nx, nz) > 1.05 && this.y - oldH < 0.3) {
        nx = this.x + (nx - this.x) * 0.2;
        nz = this.z + (nz - this.z) * 0.2;
      }
    }
    const R = g.world.radius * (this.mode === 'flight' ? 1.1 : 1.01);
    const rr = Math.hypot(nx, nz);
    if (rr > R) {
      nx *= R / rr;
      nz *= R / rr;
    }
    _xz.x = nx;
    _xz.z = nz;
    if (this.y - terrain.heightAt(nx, nz) < 9) g.world.colliders.resolve(_xz, 0.5);
    this.x = _xz.x;
    this.z = _xz.z;
    g.stats.distance += Math.hypot(this.vx, this.vz) * dt;
  }

  dispose() {
    this.hero.dispose();
    this.blob.geometry.dispose();
    this.blobMat.dispose();
  }
}
