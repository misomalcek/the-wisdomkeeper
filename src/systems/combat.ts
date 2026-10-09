import * as THREE from 'three';
import type { Game } from '../game';
import type { Enemy } from '../entities/enemies';
import { enemyXp } from '../entities/enemies';
import type { Player } from '../entities/player';
import { BOLT_COLORS, type Bolt } from '../entities/projectiles';
import { AbilityFx } from '../entities/abilities';
import { AFFINITY_COLOR } from '../entities/echoes';
import { angleDiff, clamp } from '../util/math';

const HOT = new THREE.Color(0xff3b7a);
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

export const COST = { spike: 25, shield: 35, surge: 75 };
export const CD = { spike: 4.5, shield: 10, surge: 14 };

interface Ghost {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  reach: number;
  half: number;
  dmg: number;
}
interface SpikeJob {
  t: number;
  x: number;
  z: number;
  dmg: number;
  root: number;
}

/** Melee, ranged, abilities, damage and death — everything that hurts or heals. */
export class Combat {
  readonly fx = new AbilityFx();
  swingYaw = 0;
  cd = { spike: 0, shield: 0, surge: 0 };
  shieldT = 0;
  shieldMax = 70;
  private ghosts: Ghost[] = [];
  private jobs: SpikeJob[] = [];

  constructor(private g: Game) {}

  get D() {
    return this.g.derived;
  }

  gainRes(n: number) {
    const p = this.g.player;
    p.res = Math.min(this.D.maxRes, p.res + n * this.D.resGain);
  }

  affinityColor(): THREE.Color {
    const t = this.g.run.tiers;
    if (t.root >= 1 && t.root >= t.echo && t.root >= t.flow) return BOLT_COLORS.root;
    if (t.echo >= 1 && t.echo >= t.flow) return BOLT_COLORS.echo;
    if (t.flow >= 1) return BOLT_COLORS.flow;
    return BOLT_COLORS.base;
  }

  // ---------------------------------------------------------------- melee

  beginSwing(p: Player) {
    const g = this.g;
    // choose a heading: nearest enemy in front (generous aim assist), else where the camera looks
    const camYaw = g.cam.yaw;
    let best: Enemy | null = null;
    let bd = 8 * 8;
    for (const e of g.enemies) {
      if (e.dead || e.spawnT < 0.5) continue;
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > bd) continue;
      if (Math.abs(angleDiff(camYaw, Math.atan2(dx, dz))) > 1.15) continue;
      bd = d2;
      best = e;
    }
    this.swingYaw = best ? Math.atan2(best.x - p.x, best.z - p.z) : camYaw;
    // step into the strike
    if (p.mode !== 'flight') {
      const lunge = p.atkIdx === 2 ? 5 : 7.5;
      p.vx += Math.sin(this.swingYaw) * lunge;
      p.vz += Math.cos(this.swingYaw) * lunge;
    }
    g.stats.shots++;
    g.audio.sfx('shoot', 0.55 + p.atkIdx * 0.12);
  }

  meleeHit(p: Player) {
    const g = this.g;
    const D = this.D;
    const idx = p.atkIdx;
    const tiers = g.run.tiers;
    const reach = (idx === 2 ? 4.8 : 3.7) * (tiers.echo >= 2 ? 1.25 : 1);
    const half = idx === 2 ? Math.PI : tiers.echo >= 2 ? 1.2 : 0.95;
    const dmg = (idx === 2 ? 46 : 26) * D.dmgMul;
    this.strike(p.x, p.y, p.z, this.swingYaw, reach, half, dmg, idx === 2, false);
    const col = this.affinityColor();
    this.fx.swing(p.x, p.y + 0.9, p.z, this.swingYaw, reach * 0.95, half, col);
    this.sweepParticles(p.x, p.y + 1, p.z, this.swingYaw, reach, half, col);
    g.shake(idx === 2 ? 0.45 : 0.14);
    if (tiers.echo >= 1) this.ghosts.push({ t: 0.3, x: p.x, y: p.y, z: p.z, yaw: this.swingYaw, reach, half, dmg: dmg * 0.6 });
  }

  private sweepParticles(x: number, y: number, z: number, yaw: number, reach: number, half: number, col: THREE.Color) {
    const g = this.g;
    const n = half > 2 ? 34 : 16;
    for (let i = 0; i < n; i++) {
      const a = yaw + (i / (n - 1) - 0.5) * 2 * half;
      const r = reach * (0.7 + Math.random() * 0.25);
      g.particles.emit(x + Math.sin(a) * r, y + (Math.random() - 0.4) * 0.6, z + Math.cos(a) * r, Math.sin(a) * 4, 0.5, Math.cos(a) * 4, col, 0.35, 0.35, 3);
    }
  }

  /** Apply a cone/arc hit. Returns the number of enemies struck. */
  private strike(x: number, y: number, z: number, yaw: number, reach: number, half: number, dmg: number, slam: boolean, echo: boolean) {
    const g = this.g;
    const D = this.D;
    let hits = 0;
    for (const e of g.enemies) {
      if (e.dead || e.spawnT < 0.5) continue;
      const dx = e.x - x;
      const dz = e.z - z;
      const d = Math.hypot(dx, dz);
      if (d - e.radius > reach) continue;
      if (half < Math.PI && Math.abs(angleDiff(yaw, Math.atan2(dx, dz))) > half + Math.atan2(e.radius, Math.max(d, 0.5))) continue;
      if (Math.abs(e.y - (y + 1)) > e.radius + 2.6) continue;
      const slow = g.run.tiers.root >= 1 ? 0.45 + D.slowBonus : 0;
      this.damageEnemy(e, dmg, dx, dz, { slow, echo, knock: slam ? 14 : 6 });
      hits++;
    }
    if (hits && !echo) {
      if (slam) g.enemyTimeScale = Math.min(g.enemyTimeScale, 0.3); // brief hit-stop on the slam
      this.gainRes(2.5 + hits * 0.8);
      g.audio.sfx('hit', slam ? 0.6 : 1);
    }
    return hits;
  }

  // ---------------------------------------------------------------- ranged

  fireBolt(p: Player) {
    const g = this.g;
    const D = this.D;
    const tiers = g.run.tiers;
    p.hero.handWorld(_p);
    const T = g.aim.point;
    const dmg = 9 * D.dmgMul;
    const color = this.affinityColor();
    const pierce = tiers.echo >= 2 ? 1 : 0;
    const slow = tiers.root >= 1 ? 0.4 + D.slowBonus : 0;
    g.projectiles.firePlayer(_p.x, _p.y, _p.z, T.x, T.y, T.z, { dmg, color, pierce, slow, spread: 0.6 });
    if (tiers.echo >= 1) g.projectiles.fireDelayed(0.3, _p.x, _p.y, _p.z, T.x, T.y, T.z, { dmg: dmg * 0.6, color: BOLT_COLORS.echo, pierce, slow });
    g.stats.shots++;
    g.audio.sfx('shoot', 0.9 + Math.random() * 0.2);
    g.particles.emit(_p.x, _p.y, _p.z, 0, 0.5, 0, color, 0.5, 0.15, 4);
  }

  boltHit(e: Enemy, b: Bolt) {
    let mult = 1;
    let crit = false;
    if (e.kind === 'brute' || e.kind === 'boss') {
      // weak point: the mycelial core, struck from the front
      e.coreWorld(_v);
      const dx = b.x - _v.x;
      const dy = b.y - _v.y;
      const dz = b.z - _v.z;
      const coreR = (e.kind === 'boss' ? 0.5 : 0.7) * e.scale;
      const f = Math.sin(e.yawFace) * b.vx + Math.cos(e.yawFace) * b.vz;
      if (dx * dx + dy * dy + dz * dz < coreR * coreR && f < 0) {
        mult = 1.7;
        crit = true;
      }
    }
    this.damageEnemy(e, b.dmg * mult, b.vx, b.vz, { slow: b.slow, echo: b.echo, crit, knock: 2 });
    if (!b.echo) this.gainRes(0.6);
  }

  // ---------------------------------------------------------------- damage & death

  damageEnemy(e: Enemy, dmgIn: number, dirx: number, dirz: number, o: { slow?: number; echo?: boolean; crit?: boolean; knock?: number }) {
    const g = this.g;
    if (e.dead) return;
    if (e.invuln > 0) {
      e.flash = 0.04;
      return;
    }
    e.wake(g);
    const dmg = dmgIn * this.D.voidMul;
    e.hp -= dmg;
    e.flash = 0.09;
    if (!o.echo) g.stats.hits++;
    const l = Math.hypot(dirx, dirz) || 1;
    const k = e.kind === 'boss' ? 0 : (o.knock ?? 4) * (e.kind === 'brute' ? 0.3 : 1);
    e.vx += (dirx / l) * k;
    e.vz += (dirz / l) * k;
    if (o.slow) {
      e.slowT = 2.2;
      e.slowF = 1 - o.slow;
    }
    g.particles.burst(_v.set(e.x, e.y, e.z), (o.crit ? new THREE.Color(0xffc14a) : HOT).clone().multiplyScalar(2.5), o.crit ? 9 : 4, 5, 0.35, 0.35);
    g.audio.sfx('hit', o.crit ? 1.6 : 1);
    g.ui.hitMarker(!!o.crit);
    this.damageNumber(e, dmg, !!o.crit);
    if (e.hp <= 0) this.killEnemy(e);
  }

  private damageNumber(e: Enemy, dmg: number, crit: boolean) {
    const g = this.g;
    _v.set(e.x + (Math.random() - 0.5) * 0.8, e.y + e.radius * 0.8, e.z).project(g.gfx.camera);
    if (_v.z > 1) return;
    g.ui.damageNumber((_v.x * 0.5 + 0.5) * window.innerWidth, (-_v.y * 0.5 + 0.5) * window.innerHeight, Math.round(dmg), crit);
  }

  killEnemy(e: Enemy) {
    const g = this.g;
    if (e.dead) return;
    e.dead = true;
    const pos = new THREE.Vector3(e.x, e.y, e.z);
    g.stratumKills++;
    g.run.kills++;
    this.gainRes(e.value * 3.5);
    g.particles.burst(pos, HOT.clone().multiplyScalar(3), e.kind === 'brute' ? 40 : 18, 9, 0.6, 0.8);
    g.particles.ring(pos, new THREE.Color(0x5cffc1).multiplyScalar(2), 14, 8, 0.4, 0.6);
    g.audio.sfx('kill', e.kind === 'brute' ? 0.6 : 1);
    g.shake(e.kind === 'brute' ? 0.5 : 0.1);
    g.gainXp(enemyXp(e.kind));
    g.onEnemyKilled(e);
    if (e.kind === 'boss') {
      g.bossDefeated(e);
      return;
    }
    const roll = Math.random();
    if (e.kind === 'brute') {
      g.pickups.drop(e.x, e.z, 'heal');
      g.pickups.drop(e.x, e.z, 'res');
      g.pickups.drop(e.x, e.z, 'res');
      g.dropLoot(e.x, e.z, 'fiend');
    } else if (roll < (e.kind === 'spitter' ? 0.28 : 0.14)) g.pickups.drop(e.x, e.z, 'heal');
    else if (roll < 0.55) g.pickups.drop(e.x, e.z, 'res');
    if (e.kind !== 'brute' && Math.random() < (e.kind === 'spitter' ? 0.1 : 0.04)) g.dropLoot(e.x, e.z, 'kill');
    const D = this.D;
    const p = g.player;
    if (g.run.tiers.root >= 2) p.hp = Math.min(D.maxHp, p.hp + 3);
    if (D.healOnKill) p.hp = Math.min(D.maxHp, p.hp + D.healOnKill);
    if (Math.random() < (e.kind === 'brute' ? 1 : e.kind === 'spitter' ? 0.2 : 0.09)) g.plantEcho(e.x, e.z, 'kill');
    g.world.mycelium.seed(e.x, e.z, e.kind === 'brute' ? 4 : 1, 1, 20);
  }

  // ---------------------------------------------------------------- dash

  onDash(p: Player) {
    const g = this.g;
    g.stats.dashes++;
    g.audio.sfx('dash');
    g.particles.burst(_v.set(p.x, p.y + 0.9, p.z), BOLT_COLORS.base, 12, 7, 0.5, 0.5);
    g.cam.fovBoost = 8;
    if (p.dashCount % 3 === 0) g.plantEcho(p.x, p.z, 'dash');
    if (this.D.afterimage) {
      for (const e of g.enemies) {
        if (e.dead) continue;
        if (Math.hypot(e.x - p.x, e.z - p.z) < 4 + e.radius) this.damageEnemy(e, 28 * this.D.dmgMul, e.x - p.x, e.z - p.z, { echo: true });
      }
      g.particles.ring(_v.set(p.x, p.y + 0.5, p.z), BOLT_COLORS.echo, 24, 8, 0.5, 0.5);
    }
  }

  dashDamage(p: Player) {
    for (const e of this.g.enemies) {
      if (e.dead || p.dashHit.has(e.id)) continue;
      if (Math.hypot(e.x - p.x, e.z - p.z) < e.radius + 1.4 && Math.abs(e.y - p.cy) < e.radius + 2) {
        p.dashHit.add(e.id);
        this.damageEnemy(e, 30 * this.D.dmgMul, p.dashDirX, p.dashDirZ, {});
      }
    }
  }

  // ---------------------------------------------------------------- abilities

  castSpike(p: Player): boolean {
    const g = this.g;
    if (this.cd.spike > 0 || p.res < COST.spike) return this.denied(this.cd.spike > 0 ? 'Root Spike recharging' : 'Not enough Resonance');
    p.res -= COST.spike;
    this.cd.spike = CD.spike;
    const D = this.D;
    const yaw = g.cam.yaw;
    const n = D.spikeCount;
    const dmg = 34 * D.power * D.dmgMul;
    const root = 2.2 + D.rootBonus;
    for (let i = 0; i < n; i++) {
      const d = 2.6 + i * 1.9;
      const wobble = Math.sin(i * 0.8) * 0.6;
      const x = p.x + Math.sin(yaw) * d + Math.cos(yaw) * wobble;
      const z = p.z + Math.cos(yaw) * d - Math.sin(yaw) * wobble;
      this.jobs.push({ t: i * 0.06, x, z, dmg, root });
      this.fx.addSpike(x, g.world.terrain.heightAt(x, z), z, i * 0.06, 1 + Math.random() * 0.4);
    }
    g.audio.sfx('plant');
    g.shake(0.3);
    return true;
  }

  castShield(p: Player): boolean {
    const g = this.g;
    if (this.cd.shield > 0 || p.res < COST.shield) return this.denied(this.cd.shield > 0 ? 'Fractal Shield recharging' : 'Not enough Resonance');
    p.res -= COST.shield;
    this.cd.shield = CD.shield;
    this.shieldMax = this.D.shieldCap;
    p.shield = this.shieldMax;
    this.shieldT = 8;
    this.fx.showShield(true);
    g.audio.sfx('choice');
    g.particles.ring(_v.set(p.x, p.y + 1, p.z), new THREE.Color(0x4fd8ff).multiplyScalar(3), 30, 7, 0.5, 0.7);
    return true;
  }

  shieldAbsorb(dmg: number, x: number, y: number, z: number) {
    const g = this.g;
    const p = g.player;
    p.shield -= dmg;
    this.fx.flashShield();
    g.audio.sfx('hit', 2);
    g.particles.burst(_v.set(x, y, z), new THREE.Color(0x4fd8ff).multiplyScalar(3), 6, 4, 0.35, 0.4);
    if (p.shield <= 0) this.breakShield();
  }

  private breakShield() {
    const g = this.g;
    const p = g.player;
    p.shield = 0;
    this.shieldT = 0;
    this.fx.showShield(false);
    g.particles.ring(_v.set(p.x, p.y + 1, p.z), new THREE.Color(0x9fefff).multiplyScalar(3), 36, 11, 0.6, 0.7);
    g.audio.sfx('kill', 1.4);
  }

  castSurge(p: Player): boolean {
    const g = this.g;
    if (this.cd.surge > 0 || p.res < COST.surge) return this.denied(this.cd.surge > 0 ? 'Surge recharging' : 'Not enough Resonance');
    p.res -= COST.surge;
    this.cd.surge = CD.surge;
    const D = this.D;
    const tiers = g.run.tiers;
    const radius = (D.chrono ? 1.3 : 1) * (tiers.flow >= 2 ? 20 : 15);
    const origin = new THREE.Vector3(p.x, p.y + 1, p.z);
    this.fx.castSurge(p.x, p.y, p.z, radius);
    g.particles.ring(origin, new THREE.Color(0xb084ff).multiplyScalar(3), 70, 28, 0.8, 0.9);
    g.particles.ring(origin, new THREE.Color(0x5cffc1).multiplyScalar(3), 50, 18, 0.7, 0.9);
    g.audio.sfx('surge');
    g.shake(1);
    p.hp = Math.min(D.maxHp, p.hp + 20);
    p.invuln = Math.max(p.invuln, 0.8);
    for (const e of g.enemies) {
      if (e.dead) continue;
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      if (dx * dx + dz * dz < (radius + e.radius) ** 2) {
        this.damageEnemy(e, (e.kind === 'boss' ? 90 : 60) * D.power * D.dmgMul, dx, dz, { knock: 16 });
        if (tiers.flow >= 2 || D.chrono) {
          e.slowT = 4;
          e.slowF = 0.35;
        }
      }
    }
    g.projectiles.clearEnemyBolts();
    g.world.mycelium.seed(p.x, p.z, 14, 0, 70);
    if (tiers.root >= 3) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.random();
        g.world.grove.plant(p.x + Math.cos(a) * 3.2, p.z + Math.sin(a) * 3.2, 'root', { sentinel: true, ttl: 12, scale: 0.8 });
      }
      g.ui.toast('Sentinel Blooms unfurl.');
    }
    if (tiers.echo >= 3) {
      for (const eg of g.world.grove.echoes) {
        if (eg.sentinel || (eg.x - p.x) ** 2 + (eg.z - p.z) ** 2 > 40 * 40) continue;
        const t = g.nearestEnemy(eg.x, eg.z, 50);
        if (!t) continue;
        for (let i = -1; i <= 1; i++) g.projectiles.firePlayer(eg.x, eg.y + 3, eg.z, t.x + i * 1.2, t.y, t.z, { dmg: 14 * D.dmgMul, color: BOLT_COLORS.echo, pierce: 1, echo: true });
      }
    }
    return true;
  }

  private denied(msg: string) {
    this.g.ui.toast(msg);
    return false;
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number) {
    const g = this.g;
    const p = g.player;
    this.cd.spike = Math.max(0, this.cd.spike - dt);
    this.cd.shield = Math.max(0, this.cd.shield - dt);
    this.cd.surge = Math.max(0, this.cd.surge - dt);
    if (p.shield > 0) {
      this.shieldT -= dt;
      if (this.shieldT <= 0) this.breakShield();
    }
    // echo ghost slashes
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const gh = this.ghosts[i];
      gh.t -= dt;
      if (gh.t <= 0) {
        this.strike(gh.x, gh.y, gh.z, gh.yaw, gh.reach, gh.half, gh.dmg, false, true);
        this.fx.swing(gh.x, gh.y + 0.9, gh.z, gh.yaw, gh.reach * 0.95, gh.half, BOLT_COLORS.echo);
        g.audio.sfx('echo');
        this.ghosts.splice(i, 1);
      }
    }
    // root spikes erupt in sequence
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i];
      j.t -= dt;
      if (j.t > 0) continue;
      this.jobs.splice(i, 1);
      g.particles.burst(_v.set(j.x, g.world.terrain.heightAt(j.x, j.z) + 0.3, j.z), new THREE.Color(0x9bff6b).multiplyScalar(2.2), 8, 6, 0.4, 0.5);
      for (const e of g.enemies) {
        if (e.dead) continue;
        const dx = e.x - j.x;
        const dz = e.z - j.z;
        if (dx * dx + dz * dz < (2.5 + e.radius) ** 2 && e.y - e.foot < g.world.terrain.heightAt(j.x, j.z) + 5) {
          this.damageEnemy(e, j.dmg, dx, dz, { knock: 3 });
          if (!e.dead && e.kind !== 'boss') e.rootT = j.root;
        }
      }
    }
    this.fx.update(dt, p.shield, this.shieldMax, _v.set(p.x, p.y, p.z));
    this.updateTurrets(dt);
  }

  private updateTurrets(dt: number) {
    const g = this.g;
    const tiers = g.run.tiers;
    const p = g.player;
    for (const eg of g.world.grove.echoes) {
      const isSentinel = eg.sentinel;
      if (!isSentinel && tiers.echo < 3) continue;
      if (isSentinel && eg.ttl !== undefined && eg.ttl <= 0) continue;
      if ((eg.x - p.x) ** 2 + (eg.z - p.z) ** 2 > 50 * 50) continue;
      eg.shootCD -= dt;
      if (eg.shootCD > 0) continue;
      const t = g.nearestEnemy(eg.x, eg.z, isSentinel ? 24 : 18);
      if (!t) {
        eg.shootCD = 0.25;
        continue;
      }
      eg.shootCD = isSentinel ? 0.55 : 1.4;
      g.projectiles.firePlayer(eg.x, eg.y + 3, eg.z, t.x, t.y, t.z, {
        dmg: (isSentinel ? 8 : 9) * this.D.dmgMul,
        color: isSentinel ? BOLT_COLORS.root : BOLT_COLORS.echo,
        echo: true,
      });
    }
  }

  reset() {
    this.ghosts.length = 0;
    this.jobs.length = 0;
    this.shieldT = 0;
    this.fx.showShield(false);
    this.g.player.shield = 0;
    this.cd.spike = this.cd.shield = this.cd.surge = 0;
  }

  /** Cooldown fraction ready (0..1) for HUD. */
  ready(which: 'spike' | 'shield' | 'surge') {
    return 1 - clamp(this.cd[which] / CD[which], 0, 1);
  }

  affinityHex(a: 'root' | 'echo' | 'flow') {
    return AFFINITY_COLOR[a];
  }
}
