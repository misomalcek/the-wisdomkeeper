/**
 * Mycelial Mind state machine (Biocomputing Blueprint 4.3): a 5→8→4 sigmoid network over the blueprint's player
 * telemetry, producing the four world directives. Weights use the blueprint's deterministic sin/cos
 * initialisation so every player meets the same "mind"; what differs is what they feed it.
 *
 * Fix over the listing: the outputs are read from indices 0–3 (the listing reads `outputs * 2.0` and
 * `outputs[18..20]`, which are NaN/undefined).
 */
export interface PlayerTelemetry {
  /** Remembrances embraced (the Null) */
  embrace: number;
  /** Remembrances purified */
  purify: number;
  /** Seconds spent in 6-DoF free flight */
  flightTime: number;
  /** Root-Blade kills */
  meleeKills: number;
  /** Resonance spent on abilities */
  resonanceSpent: number;
}

export interface WorldDirectives {
  /** 0..2: enemy spawn rate and corruption-stain intensity */
  nullCorruptionAggression: number;
  /** 0.5..2: how long pylon purges take to hold */
  pylonPurgeDifficulty: number;
  /** 0.5..3: environment bioluminescence multiplier */
  floraGlowIntensity: number;
  /** 0..1: propensity toward the Hollow Crown ending */
  hollowCrownProbability: number;
}

export const freshTelemetry = (): PlayerTelemetry => ({ embrace: 0, purify: 0, flightTime: 0, meleeKills: 0, resonanceSpent: 0 });

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export class MycelialMindState {
  readonly wIH: number[][] = [];
  readonly wHO: number[][] = [];
  /** Last hidden activations (for the debug overlay / network visual). */
  hidden: number[] = new Array(8).fill(0);
  outputs: number[] = new Array(4).fill(0);

  constructor() {
    for (let i = 0; i < 5; i++) this.wIH[i] = Array.from({ length: 8 }, (_, j) => Math.sin(i * 8 + j) * 0.5);
    for (let j = 0; j < 8; j++) this.wHO[j] = Array.from({ length: 4 }, (_, k) => Math.cos(j * 4 + k) * 0.5);
  }

  static inputs(t: PlayerTelemetry): number[] {
    return [
      t.embrace / 7,
      t.purify / 7,
      Math.min(1, t.flightTime / 300),
      Math.min(1, t.meleeKills / 100),
      Math.min(1, t.resonanceSpent / 500),
    ];
  }

  evaluate(t: PlayerTelemetry): WorldDirectives {
    const x = MycelialMindState.inputs(t);
    for (let j = 0; j < 8; j++) {
      let s = 0;
      for (let i = 0; i < 5; i++) s += x[i] * this.wIH[i][j];
      this.hidden[j] = sigmoid(s);
    }
    for (let k = 0; k < 4; k++) {
      let s = 0;
      for (let j = 0; j < 8; j++) s += this.hidden[j] * this.wHO[j][k];
      this.outputs[k] = sigmoid(s);
    }
    const o = this.outputs;
    return {
      nullCorruptionAggression: o[0] * 2,
      pylonPurgeDifficulty: o[1] * 1.5 + 0.5,
      floraGlowIntensity: o[2] * 2.5 + 0.5,
      hollowCrownProbability: t.embrace >= 4 ? 1 : o[3],
    };
  }
}
