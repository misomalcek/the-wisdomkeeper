import type { Enemy } from '../entities/enemies';
import type { EnemyKind, Remembrance } from '../types';
import type { Pylon } from '../world/structures';

/**
 * The game's edition surface: what happened, as events, plus the few decisions an edition may take part in.
 *
 * The web edition never listens, so every emit is a no-op here. The desktop edition (Infinite Evolutions, a fork
 * that merges this repo one way) hangs its living world off these events instead of reaching into Game's
 * internals, so a refactor here either keeps an event firing or fails to compile. Add an event before an edition
 * needs to wrap a method; never remove or rename one without the fork's adapter moving with it.
 */
export interface GameEvents {
  /** A stratum was entered (new, continued or re-entered), after the world was built. */
  stratum: { index: number; id: string };
  /** One play update, with the frame's dt before slow motion. */
  tick: { dt: number };
  /** A spawn the game made (camps, ambient waves, events, editions' `queueSpawn`). */
  spawn: { enemy: Enemy; kind: EnemyKind; x: number; z: number };
  /** An enemy died. */
  kill: { enemy: Enemy };
  /** The hero took a hit: `amount` after armour (0 when a shield took it). */
  hurt: { amount: number; x: number; z: number };
  /** The hero fell. */
  death: { x: number; z: number };
  /** The hero rose again at the checkpoint. */
  respawn: { x: number; z: number };
  /** A Remembrance was purified or embraced. */
  remembrance: { choice: Remembrance };
  /** A Pylon's purge completed. */
  pylon: { pylon: Pylon };
  /** An echo-tree took root. */
  echo: { x: number; z: number; source: 'dash' | 'kill' | 'node' | 'manual' };
}

export type GameEvent = keyof GameEvents;

export class GameHooks {
  private fns: { [E in GameEvent]?: ((p: GameEvents[E]) => void)[] } = {};

  /**
   * An edition may close fast travel to a place (a siege over a Pylon, say): return the line to show the player,
   * or null to let the hero travel.
   */
  travelGate: ((x: number, z: number) => string | null) | null = null;

  /** Subscribes to an event; returns the unsubscribe. */
  on<E extends GameEvent>(e: E, fn: (p: GameEvents[E]) => void): () => void {
    const list = (this.fns[e] ??= []) as ((p: GameEvents[E]) => void)[];
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Whether anything listens (lets a caller skip building a payload). */
  has(e: GameEvent) {
    return !!this.fns[e]?.length;
  }

  /** Calls every listener; one that throws is logged and never stops the game or the others. */
  emit<E extends GameEvent>(e: E, p: GameEvents[E]) {
    const list = this.fns[e];
    if (!list?.length) return;
    for (const fn of list.slice()) {
      try {
        fn(p);
      } catch (err) {
        console.error(`[hooks] ${e} listener failed`, err);
      }
    }
  }
}
