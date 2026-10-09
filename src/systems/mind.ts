import type { PlayStats } from '../types';
import { Rng } from '../util/rng';
import { clamp } from '../util/math';

export function freshStats(): PlayStats {
  return { shots: 0, hits: 0, damageTaken: 0, distance: 0, time: 0, combatTime: 0, dashes: 0 };
}

export interface Features {
  aggression: number; // how trigger-happy
  accuracy: number;
  vulnerability: number; // how hard the stratum hurt
  roaming: number; // how far the player wandered
  evasion: number; // dash use
}

export function digest(s: PlayStats, maxHp: number): Features {
  const t = Math.max(s.time, 1);
  return {
    aggression: clamp(s.shots / t / 3.5, 0, 1),
    accuracy: s.shots > 0 ? clamp(s.hits / s.shots, 0, 1) : 0.4,
    vulnerability: clamp(s.damageTaken / (maxHp * 2), 0, 1),
    roaming: clamp(s.distance / t / 14, 0, 1),
    evasion: clamp(s.dashes / t / 0.25, 0, 1),
  };
}

export const featureVector = (f: Features) => [f.aggression, f.accuracy, f.vulnerability, f.roaming, f.evasion];

const HIDDEN = 8;
const INPUTS = 5;
const OUTPUTS = 4;

/**
 * A tiny feed-forward network (5→8→4, seeded per run, ~70 weights) that turns the
 * player's style into a "latent world code". No downloads, no training server —
 * just enough neural texture to make the world feel like it is listening.
 * Output channels: [ruggedness, flora density, hue drift, arena scale], each in [-1, 1].
 */
export class MycelialMind {
  private w1: number[][];
  private w2: number[][];
  constructor(seed: number) {
    const rng = new Rng(seed ^ 0xa5a5);
    const mat = (r: number, c: number, scale: number) =>
      Array.from({ length: r }, () => Array.from({ length: c }, () => rng.gauss() * scale));
    this.w1 = mat(HIDDEN, INPUTS, 0.9);
    this.w2 = mat(OUTPUTS, HIDDEN, 0.7);
  }

  forward(x: number[]): number[] {
    const h = this.w1.map((row) => Math.tanh(row.reduce((a, w, i) => a + w * (x[i] - 0.5) * 2, 0)));
    return this.w2.map((row) => Math.tanh(row.reduce((a, w, i) => a + w * h[i], 0)));
  }

  /** Blend of hand-written intent (legible) and the net (individual). */
  latent(f: Features): number[] {
    const heuristic = [
      f.aggression - f.roaming * 0.6,
      0.5 - f.aggression * 0.8 + f.evasion * 0.3,
      f.accuracy - 0.5,
      f.roaming - 0.5,
    ];
    const net = this.forward(featureVector(f));
    return heuristic.map((h, i) => clamp(h * 0.6 + net[i] * 0.4, -1, 1));
  }
}

export const NEUTRAL_LATENT = [0, 0, 0, 0];

export function latentToParams(l: number[]) {
  return {
    ruggedness: 1 + 0.25 * l[0],
    floraDensity: 1 + 0.3 * l[1],
    hueShift: l[2] * 0.08,
    arenaScale: 1 + 0.1 * l[3],
  };
}

/** Keeps the fight in the "flow channel": hurt players get mercy, cruising players get teeth. */
export function adaptDifficulty(prev: number, f: Features): number {
  let d = prev;
  if (f.vulnerability > 0.6) d -= 0.12;
  else if (f.vulnerability < 0.25) d += 0.12;
  if (f.accuracy > 0.6) d += 0.05;
  return clamp(d, 0.7, 1.9);
}

export function describeStyle(f: Features, l: number[]): string {
  const parts: string[] = [];
  if (f.vulnerability > 0.6) parts.push('You bled in the last world. The soil softened beneath your feet.');
  else if (f.vulnerability < 0.2) parts.push('The Static barely touched you. It has grown teeth in answer.');
  if (f.roaming > 0.55) parts.push('You wander, and the valleys widened to follow.');
  else if (f.roaming < 0.3) parts.push('You hold your ground; the land drew in close around you.');
  if (f.aggression > 0.55) parts.push('You strike first. The mycelium grew thorns where you will need them.');
  else if (f.evasion > 0.5) parts.push('You dance away from harm, and the world learned your rhythm.');
  if (f.accuracy > 0.65) parts.push('Your aim is a song the Static cannot parse — it sings louder.');
  if (!parts.length) parts.push('The mycelium is still learning how you move.');
  const hue = l[2] > 0.15 ? ' The sky leans warmer.' : l[2] < -0.15 ? ' The sky leans colder.' : '';
  return parts.slice(0, 2).join(' ') + hue;
}
