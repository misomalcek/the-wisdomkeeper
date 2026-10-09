import { clamp } from '../util/math';

export type Sfx =
  | 'shoot' | 'echo' | 'hit' | 'kill' | 'hurt' | 'dash' | 'pickup' | 'node' | 'surge'
  | 'choice' | 'click' | 'gate' | 'boss' | 'plant' | 'spit' | 'ready' | 'bossdie' | 'warn';

export interface Mood {
  root: number;
  scale: number[];
  tempo: number;
}

/**
 * Fully procedural audio: a drifting pad, a pentatonic-ish arpeggio that quickens
 * with combat intensity, and synthesised SFX. Zero audio assets to download.
 */
export class AudioEngine {
  private ctx?: AudioContext;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private reverb!: ConvolverNode;
  private noiseBuf!: AudioBuffer;
  private padOscs: OscillatorNode[] = [];
  private padFilter!: BiquadFilterNode;
  private padGain!: GainNode;
  private mood: Mood = { root: 110, scale: [0, 3, 5, 7, 10], tempo: 0.8 };
  private nextStep = 0;
  private step = 0;
  private degree = 0;
  private timer = 0;
  private last: Partial<Record<Sfx, number>> = {};
  intensity = 0;
  private smoothIntensity = 0;
  muted = false;
  volume = 0.7;

  get ready() {
    return !!this.ctx;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.55;
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;

    // Procedural reverb impulse
    const len = ctx.sampleRate * 2.8;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.reverb.connect(wet).connect(this.master);
    this.musicBus.connect(this.master);
    this.musicBus.connect(this.reverb);
    this.sfxBus.connect(this.master);
    this.sfxBus.connect(this.reverb);

    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // Pad
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 420;
    this.padFilter.Q.value = 2;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.07;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(this.padFilter.frequency);
    lfo.start();
    for (const [mult, type, det] of [[1, 'sawtooth', -6], [1.5, 'triangle', 4], [2, 'sawtooth', 7], [0.5, 'sine', 0]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = det;
      o.frequency.value = this.mood.root * mult;
      o.connect(this.padFilter);
      o.start();
      this.padOscs.push(o);
    }
    this.padFilter.connect(this.padGain).connect(this.musicBus);

    this.nextStep = ctx.currentTime + 0.2;
    this.timer = window.setInterval(() => this.schedule(), 90);
  }

  setMood(m: Mood) {
    this.mood = m;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const mults = [1, 1.5, 2, 0.5];
    this.padOscs.forEach((o, i) => o.frequency.setTargetAtTime(m.root * mults[i], t, 1.5));
  }

  setIntensity(v: number) {
    this.intensity = clamp(v, 0, 1);
  }

  setVolume(v: number) {
    this.volume = clamp(v, 0, 1);
    if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  private schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.smoothIntensity += (this.intensity - this.smoothIntensity) * 0.08;
    this.padFilter.frequency.setTargetAtTime(380 + this.smoothIntensity * 900, ctx.currentTime, 0.4);
    this.padGain.gain.setTargetAtTime(0.06 + this.smoothIntensity * 0.04, ctx.currentTime, 0.4);
    const stepLen = 0.5 / (this.mood.tempo * (1 + this.smoothIntensity * 0.9));
    while (this.nextStep < ctx.currentTime + 0.35) {
      this.playArp(this.nextStep);
      this.nextStep += stepLen;
      this.step++;
    }
  }

  private playArp(when: number) {
    const ctx = this.ctx!;
    const { scale, root } = this.mood;
    // random walk across the scale, with occasional leaps
    this.degree += Math.random() < 0.2 ? Math.floor(Math.random() * 5) - 2 : Math.random() < 0.5 ? 1 : -1;
    this.degree = clamp(this.degree, -2, scale.length + 2);
    const oct = Math.floor(this.degree / scale.length);
    const idx = ((this.degree % scale.length) + scale.length) % scale.length;
    const semis = scale[idx] + 12 * oct + 12;
    const f = root * Math.pow(2, semis / 12);
    if (this.step % 2 === 1 && Math.random() < 0.45 - this.smoothIntensity * 0.2) return; // breathing
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = this.smoothIntensity > 0.5 ? 'square' : 'triangle';
    o.frequency.value = f;
    const peak = 0.05 + this.smoothIntensity * 0.025;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, when + 0.9);
    o.connect(g).connect(this.musicBus);
    o.start(when);
    o.stop(when + 1);
  }

  // ---- SFX ----------------------------------------------------------------

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, gain: number, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(dur: number, type: BiquadFilterType, f0: number, f1: number, gain: number, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(t);
    s.stop(t + dur + 0.05);
  }

  sfx(name: Sfx, pitch = 1) {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const minGap: Partial<Record<Sfx, number>> = { shoot: 0.05, hit: 0.04, kill: 0.05, echo: 0.08, spit: 0.1 };
    if (now - (this.last[name] ?? -1) < (minGap[name] ?? 0)) return;
    this.last[name] = now;
    const p = pitch;
    switch (name) {
      case 'shoot':
        this.tone(900 * p, 320 * p, 0.09, 'triangle', 0.09);
        break;
      case 'echo':
        this.tone(1300 * p, 500 * p, 0.12, 'sine', 0.05);
        break;
      case 'spit':
        this.tone(220, 90, 0.2, 'sawtooth', 0.06);
        break;
      case 'hit':
        this.noise(0.06, 'bandpass', 2400, 900, 0.1);
        this.tone(300 * p, 150 * p, 0.05, 'square', 0.04);
        break;
      case 'kill':
        this.noise(0.28, 'lowpass', 3000, 200, 0.16);
        this.tone(520 * p, 70, 0.28, 'sawtooth', 0.08);
        this.tone(1040 * p, 1560 * p, 0.12, 'sine', 0.04, 0.05);
        break;
      case 'hurt':
        this.tone(180, 55, 0.35, 'sawtooth', 0.18);
        this.noise(0.25, 'lowpass', 1600, 150, 0.18);
        break;
      case 'dash':
        this.noise(0.22, 'highpass', 600, 5000, 0.12);
        break;
      case 'pickup':
        this.tone(660, 660, 0.12, 'sine', 0.08);
        this.tone(990, 990, 0.18, 'sine', 0.07, 0.07);
        break;
      case 'plant':
        this.tone(200, 520, 0.3, 'sine', 0.1);
        this.tone(520, 780, 0.25, 'triangle', 0.05, 0.1);
        break;
      case 'ready':
        this.tone(880, 1320, 0.14, 'sine', 0.06);
        break;
      case 'node': {
        const f = this.mood.root * 4;
        [1, 1.25, 1.5, 2, 3].forEach((m, i) => this.tone(f * m, f * m, 2.2, 'sine', 0.06 / (1 + i * 0.3), i * 0.06));
        break;
      }
      case 'surge':
        this.tone(110, 35, 0.9, 'sine', 0.35);
        this.noise(0.7, 'lowpass', 200, 4000, 0.18);
        this.tone(440, 1760, 0.6, 'triangle', 0.06);
        break;
      case 'choice': {
        const f = this.mood.root * 4;
        [1, 1.5, 2, 3].forEach((m, i) => this.tone(f * m, f * m * 1.01, 1.6, 'triangle', 0.06, i * 0.09));
        break;
      }
      case 'click':
        this.tone(1200, 800, 0.05, 'square', 0.03);
        break;
      case 'gate': {
        const f = this.mood.root * 2;
        [1, 1.5, 2, 2.5, 3, 4].forEach((m, i) => this.tone(f * m * 0.5, f * m, 1.4, 'sawtooth', 0.04, i * 0.12));
        this.noise(1.5, 'lowpass', 300, 6000, 0.12);
        break;
      }
      case 'boss':
        this.tone(70, 35, 1.2, 'sawtooth', 0.28);
        this.tone(73, 36, 1.2, 'square', 0.12);
        this.noise(1, 'lowpass', 900, 80, 0.2);
        break;
      case 'bossdie':
        this.tone(220, 20, 2.4, 'sawtooth', 0.3);
        this.noise(2.4, 'lowpass', 5000, 100, 0.3);
        [1, 1.5, 2, 3].forEach((m, i) => this.tone(330 * m, 330 * m, 2.5, 'sine', 0.07, 1 + i * 0.15));
        break;
      case 'warn':
        this.tone(300, 300, 0.1, 'square', 0.05);
        break;
    }
  }

  dispose() {
    window.clearInterval(this.timer);
    void this.ctx?.close();
  }
}
