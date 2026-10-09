import * as THREE from 'three';
import type { Game } from '../game';
import { clamp } from '../util/math';

export interface Anchor {
  pos: THREE.Vector3;
  zoneRadius: number;
  setState(s: 'dormant' | 'active' | 'done'): void;
}

/** "Hold the zone": while you stand in an anchor's ring it resonates, and the Static answers in waves. */
export class Encounter {
  progress = 0; // seconds spent inside the zone
  elapsed = 0;
  wave = 0;
  private waveTimer = 0.8;
  phase: 'running' | 'cleanup' = 'running';
  readonly duration: number;
  inside = true;

  constructor(readonly anchor: Anchor, readonly kind: 'node' | 'pylon', stratumIndex: number, diff: number) {
    this.duration = (kind === 'node' ? 9 + 2 * stratumIndex : 18 + 2 * stratumIndex) + (diff - 1) * 3;
  }

  get fraction() {
    return clamp(this.progress / this.duration, 0, 1);
  }

  /** Returns true once the encounter is finished. */
  update(g: Game, dt: number): boolean {
    this.elapsed += dt;
    const p = g.player;
    const a = this.anchor;
    this.inside = (p.x - a.pos.x) ** 2 + (p.z - a.pos.z) ** 2 < (a.zoneRadius * 1.15) ** 2;
    if (this.phase === 'running') {
      if (this.inside) this.progress += dt;
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        const interval = clamp(5.6 - this.wave * 0.3, 3.4, 5.6);
        this.waveTimer = interval;
        const alive = g.enemies.filter((e) => !e.dead && e.fromEvent).length + g.pendingSpawnCount;
        if (alive < 14) {
          const mult = this.kind === 'node' ? 0.8 : 1.15;
          const budget = g.def.waveBase * mult * (1 + this.wave * 0.22) * (0.75 + 0.25 * g.diff);
          g.spawnBudget(Math.round(budget), a.pos.x, a.pos.z, true);
          this.wave++;
        }
      }
      if (this.progress >= this.duration) {
        this.phase = 'cleanup';
        g.ui.say('The song holds. Only the last of the Static remains.');
      }
    } else {
      const left = g.enemies.some((e) => !e.dead && e.fromEvent) || g.pendingSpawnCount > 0;
      if (!left) return true;
    }
    return false;
  }
}
