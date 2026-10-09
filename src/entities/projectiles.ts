import * as THREE from 'three';
import type { Game } from '../game';
import type { Enemy } from './enemies';

export interface Bolt {
  owner: 'player' | 'enemy';
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  dmg: number;
  pierce: number;
  slow: number;
  radius: number;
  hit: Set<Enemy>;
  color: THREE.Color;
  echo: boolean;
  gravity: number;
  /** Set by clearEnemyBolts(); removed silently on the next update. */
  kill?: boolean;
}

const MAX_P = 260;
const MAX_E = 300;
const _o = new THREE.Object3D();
const _t = new THREE.Vector3();

export const BOLT_COLORS = {
  base: new THREE.Color(0x5cffc1).multiplyScalar(2.4),
  root: new THREE.Color(0x9bff6b).multiplyScalar(2.4),
  echo: new THREE.Color(0xb084ff).multiplyScalar(2.6),
  flow: new THREE.Color(0x4fd8ff).multiplyScalar(2.6),
  enemy: new THREE.Color(0xff3b7a).multiplyScalar(2.4),
};

export class Projectiles {
  readonly group = new THREE.Group();
  private pMesh: THREE.InstancedMesh;
  private eMesh: THREE.InstancedMesh;
  private bolts: Bolt[] = [];
  private delayed: { t: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; dmg: number; color: THREE.Color; pierce: number; slow: number }[] = [];

  constructor() {
    const mk = (geo: THREE.BufferGeometry, max: number) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), max);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    this.pMesh = mk(new THREE.SphereGeometry(0.11, 8, 6).scale(1, 1, 4.2), MAX_P);
    this.eMesh = mk(new THREE.IcosahedronGeometry(0.34, 0), MAX_E);
  }

  get count() {
    return this.bolts.length;
  }

  /** Fire from (x,y,z) toward the target point. */
  firePlayer(x: number, y: number, z: number, tx: number, ty: number, tz: number, o: { dmg: number; color: THREE.Color; pierce?: number; slow?: number; speed?: number; life?: number; echo?: boolean; spread?: number }) {
    if (this.bolts.length > MAX_P + MAX_E - 10) return;
    const sp = o.speed ?? 70;
    _t.set(tx - x, ty - y, tz - z);
    if (o.spread) _t.add(new THREE.Vector3((Math.random() - 0.5) * o.spread, (Math.random() - 0.5) * o.spread, (Math.random() - 0.5) * o.spread));
    _t.normalize().multiplyScalar(sp);
    this.bolts.push({
      owner: 'player', x, y, z, vx: _t.x, vy: _t.y, vz: _t.z, life: o.life ?? 1.1, dmg: o.dmg, pierce: o.pierce ?? 0,
      slow: o.slow ?? 0, radius: 0.35, hit: new Set(), color: o.color, echo: !!o.echo, gravity: 0,
    });
  }

  /** Echo tier 1: a ghost bolt arrives a moment later. */
  fireDelayed(delay: number, x: number, y: number, z: number, tx: number, ty: number, tz: number, o: { dmg: number; color: THREE.Color; pierce: number; slow: number }) {
    this.delayed.push({ t: delay, x, y, z, tx, ty, tz, ...o });
  }

  fireEnemy(x: number, y: number, z: number, tx: number, ty: number, tz: number, speed: number, dmg: number, life = 4.5, gravity = 0) {
    if (this.bolts.length > MAX_P + MAX_E - 10) return;
    _t.set(tx - x, ty - y, tz - z).normalize().multiplyScalar(speed);
    this.bolts.push({
      owner: 'enemy', x, y, z, vx: _t.x, vy: _t.y, vz: _t.z, life, dmg, pierce: 0, slow: 0, radius: 0.5,
      hit: new Set(), color: BOLT_COLORS.enemy, echo: false, gravity,
    });
  }

  /** Enemy orb along a horizontal heading (boss rings / spirals). */
  fireEnemyFlat(x: number, y: number, z: number, ang: number, speed: number, dmg: number, life = 5) {
    this.fireEnemy(x, y, z, x + Math.sin(ang), y, z + Math.cos(ang), speed, dmg, life);
  }

  /** Safe to call mid-update (e.g. when a boss dies): bolts are flagged, not removed. */
  clearEnemyBolts() {
    for (const b of this.bolts) if (b.owner === 'enemy') b.kill = true;
  }

  clear() {
    this.bolts.length = 0;
    this.delayed.length = 0;
  }

  update(game: Game, dt: number) {
    const terrain = game.world.terrain;
    const R = game.world.radius * 1.2;
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i];
      d.t -= dt;
      if (d.t <= 0) {
        this.firePlayer(d.x, d.y, d.z, d.tx, d.ty, d.tz, { dmg: d.dmg, color: d.color, pierce: d.pierce, slow: d.slow, echo: true });
        game.audio.sfx('echo');
        this.delayed.splice(i, 1);
      }
    }

    const player = game.player;
    const shielded = player.shield > 0;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      if (!b) continue;
      if (b.kill) {
        this.bolts.splice(i, 1);
        continue;
      }
      const ts = b.owner === 'enemy' ? game.enemyTimeScale : 1;
      b.life -= dt;
      b.vy -= b.gravity * dt * ts;
      b.x += b.vx * dt * ts;
      b.y += b.vy * dt * ts;
      b.z += b.vz * dt * ts;
      let dead = b.life <= 0 || b.x * b.x + b.z * b.z > R * R;
      if (!dead && b.y < terrain.heightAt(b.x, b.z) + 0.15) dead = true;

      if (!dead && b.owner === 'player') {
        for (const e of game.enemies) {
          if (e.dead || e.spawnT < 0.5 || b.hit.has(e)) continue;
          const dx = e.x - b.x;
          const dy = e.y - b.y;
          const dz = e.z - b.z;
          const rr = e.radius + 0.25;
          if (dx * dx + dy * dy + dz * dz < rr * rr) {
            b.hit.add(e);
            game.combat.boltHit(e, b);
            if (b.pierce > 0) b.pierce--;
            else {
              dead = true;
              break;
            }
          }
        }
      } else if (!dead && b.owner === 'enemy') {
        const dx = player.x - b.x;
        const dy = player.cy - b.y;
        const dz = player.z - b.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (shielded && d2 < 2.0 * 2.0) {
          game.combat.shieldAbsorb(b.dmg, b.x, b.y, b.z);
          dead = true;
        } else if (d2 < 0.85 * 0.85) {
          if (game.hurtPlayer(b.dmg, b.x, b.z)) dead = true;
        }
      }

      if (!dead && Math.random() < (b.owner === 'player' ? 0.7 : 0.4)) {
        game.particles.emit(b.x, b.y, b.z, (Math.random() - 0.5) * 1.2, (Math.random() - 0.3) * 1.2, (Math.random() - 0.5) * 1.2, b.color, b.owner === 'player' ? 0.22 : 0.34, 0.3, 3);
      }
      if (dead) {
        if (b.life > 0 || b.owner === 'enemy') game.particles.burst(_t.set(b.x, b.y, b.z), b.color, 4, 3, 0.3, 0.3);
        this.bolts.splice(i, 1);
      }
    }

    let pi = 0;
    let ei = 0;
    const t = game.time;
    for (const b of this.bolts) {
      if (b.owner === 'player') {
        _o.position.set(b.x, b.y, b.z);
        _t.set(b.x + b.vx, b.y + b.vy, b.z + b.vz);
        _o.lookAt(_t);
        _o.scale.setScalar(b.echo ? 0.75 : 1);
        _o.updateMatrix();
        this.pMesh.setMatrixAt(pi, _o.matrix);
        this.pMesh.setColorAt(pi, b.color);
        pi++;
      } else {
        _o.position.set(b.x, b.y, b.z);
        _o.rotation.set(t * 3, t * 4, 0);
        _o.scale.setScalar(1 + 0.15 * Math.sin(t * 14 + b.x));
        _o.updateMatrix();
        this.eMesh.setMatrixAt(ei, _o.matrix);
        this.eMesh.setColorAt(ei, b.color);
        ei++;
      }
    }
    this.pMesh.count = pi;
    this.eMesh.count = ei;
    this.pMesh.instanceMatrix.needsUpdate = this.eMesh.instanceMatrix.needsUpdate = true;
    if (this.pMesh.instanceColor) this.pMesh.instanceColor.needsUpdate = true;
    if (this.eMesh.instanceColor) this.eMesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.pMesh, this.eMesh]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}
