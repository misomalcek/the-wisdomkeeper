import { MyceliumReservoir } from './reservoir';
import { FungalMemristor, SeedPool } from './entropy';
import { MycelialMindState, type PlayerTelemetry, type WorldDirectives } from './mindState';
import { clamp } from '../util/math';

export type DirectorPhase = 'calm' | 'stirring' | 'surge' | 'respite';

export interface DirectorInput {
  /** 0..1 hero health fraction */
  hp: number;
  /** enemies currently engaged with the hero */
  engaged: number;
  /** seconds since the hero last took damage */
  sinceHurt: number;
  /** stratum difficulty (Mycelial Mind style adaptation) */
  difficulty: number;
}

export interface DirectorOutput {
  phase: DirectorPhase;
  /** multiplies the ambient enemy target and spawning-pool rates */
  threat: number;
  /** extra chance that an ambient spawn is a Void-Root Fiend (blueprint: entropy spikes feed Fiend pools) */
  fiendBias: number;
  /** 0.85..1.2: geometric recursion / scale modulation of fractal flora ("scale is a rumor") */
  fractalScale: number;
  /** current world directives from the Mycelial Mind */
  directives: WorldDirectives;
}

/**
 * Neural World Director (Technical Grounding Report 4.3): reservoir activity → memristor → SHA-256 pool feeds a
 * decision state machine with four arms (threat, spawning pools, fractal scaling, story branching). Phases follow
 * a pacing curve — calm → stirring → surge → respite — whose transitions are triggered by entropy spikes and held
 * back by the hero's state, so the bio-signal adds texture without ever ambushing a hero at 10% health.
 */
export class NeuralDirector {
  readonly reservoir: MyceliumReservoir;
  readonly memristor = new FungalMemristor();
  readonly pool = new SeedPool();
  readonly mind = new MycelialMindState();
  phase: DirectorPhase = 'calm';
  phaseT = 0;
  private acc = 0;
  private slow = 0;
  private fast = 0;
  /** true while the reservoir is bursting well above its own baseline */
  burst = false;
  out: DirectorOutput;

  constructor(seed: number) {
    this.reservoir = new MyceliumReservoir(48, seed);
    this.out = { phase: 'calm', threat: 1, fiendBias: 0, fractalScale: 1, directives: this.mind.evaluate({ embrace: 0, purify: 0, flightTime: 0, meleeKills: 0, resonanceSpent: 0 }) };
  }

  /** Map a world-space event onto the reservoir (the stratum folds onto the lattice). */
  stimulate(x: number, z: number, radius: number, magnitude: number) {
    const u = clamp(0.5 + x / (radius * 4), 0, 0.999);
    const v = clamp(0.5 + z / (radius * 4), 0, 0.999);
    this.reservoir.stimulate(u, v, magnitude, magnitude > 1 ? 2 : 1);
  }

  /** Entropy-backed uniform random in [0,1) for loot, missions and branching. */
  random() {
    return this.pool.random();
  }

  update(dt: number, inp: DirectorInput, telemetry: PlayerTelemetry): DirectorOutput {
    this.acc += dt;
    this.phaseT += dt;
    // the reservoir runs at 20 Hz regardless of frame rate
    while (this.acc >= 0.05) {
      this.acc -= 0.05;
      const r = this.reservoir;
      r.step();
      // sample fired cells through the memristor; frame-time jitter is part of the signal
      const jitter = (typeof performance !== 'undefined' ? performance.now() : Date.now()) % 1;
      for (const i of r.fired) this.memristor.drive(r.v[i] - 0.5 + jitter * 0.01, 5850 * (i / r.v.length), 0.002);
      this.fast += (r.spikes - this.fast) * 0.2;
      this.slow += (r.spikes - this.slow) * 0.01;
      if (this.memristor.pending >= 512) void this.pool.absorb(this.memristor.whiten(), jitter);
    }
    const d = this.mind.evaluate(telemetry);
    const spike = (this.burst = this.fast > this.slow * 1.6 + 2);
    const safe = inp.hp > 0.45 && inp.sinceHurt > 4;
    switch (this.phase) {
      case 'calm':
        if (this.phaseT > 25 && (spike || this.phaseT > 55) && safe) this.go('stirring');
        break;
      case 'stirring':
        if (this.phaseT > 12 && (spike || this.phaseT > 32) && safe) this.go('surge');
        else if (this.phaseT > 45) this.go('calm');
        break;
      case 'surge':
        if (this.phaseT > 18 + 10 * d.nullCorruptionAggression || inp.hp < 0.3) this.go('respite');
        break;
      case 'respite':
        if (this.phaseT > 20) this.go('calm');
        break;
    }
    const base = { calm: 0.8, stirring: 1.05, surge: 1.45, respite: 0.45 }[this.phase];
    this.out = {
      phase: this.phase,
      threat: base * (0.8 + 0.2 * d.nullCorruptionAggression) * clamp(inp.difficulty, 0.7, 1.9),
      fiendBias: this.phase === 'surge' ? 0.18 + 0.12 * d.nullCorruptionAggression : spike ? 0.08 : 0,
      fractalScale: 0.9 + 0.25 * clamp(this.reservoir.activity * 40, 0, 1),
      directives: d,
    };
    return this.out;
  }

  private go(p: DirectorPhase) {
    this.phase = p;
    this.phaseT = 0;
  }
}
