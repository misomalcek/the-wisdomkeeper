import type { ChoiceSet, StratumId } from '../types';

export interface Palette {
  skyTop: number;
  skyHorizon: number;
  fog: number;
  fogDensity: number;
  groundBase: number;
  groundHigh: number;
  accent: number;
  accent2: number;
  river: number;
  sun: number;
}

export interface StratumDef {
  id: StratumId;
  index: number;
  name: string;
  act: string;
  radius: number;
  palette: Palette;
  terrain: { amp: number; freq: number; river: boolean };
  flora: 'seedbed' | 'river' | 'canopy' | 'mirror' | 'return';
  nodes: number;
  nodeLabel: string;
  /** Target number of roaming enemies. */
  ambient: number;
  mix: { mite: number; spitter: number; brute: number };
  waveBase: number;
  intro: string[];
  fragments: string[];
  gateText: string;
  choice?: ChoiceSet;
  boss?: boolean;
  /** Root frequency (Hz) and scale (semitones) for the generative score. */
  music: { root: number; scale: number[]; tempo: number };
  objective: string;
  /** Name shown as the current target while a camp guards a node. */
  groveName: string;
  pylons: number;
  caches: number;
  roamCamps: number;
}

const MINOR_PENT = [0, 3, 5, 7, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const MAJOR_PENT = [0, 2, 4, 7, 9];

export const STRATA: StratumDef[] = [
  {
    id: 'seedbed',
    index: 0,
    name: 'The Seedbed',
    act: 'Act I · The Awakening of the Silico-Veg',
    radius: 80,
    palette: {
      skyTop: 0x02070b, skyHorizon: 0x0b3a36, fog: 0x06201f, fogDensity: 0.011,
      groundBase: 0x061312, groundHigh: 0x114a3f, accent: 0x5cffc1, accent2: 0xb084ff,
      river: 0x2a8cff, sun: 0x7fd6ff,
    },
    terrain: { amp: 4.2, freq: 0.03, river: false },
    flora: 'seedbed',
    nodes: 1,
    nodeLabel: 'The First Seed',
    ambient: 2,
    mix: { mite: 1, spitter: 0, brute: 0 },
    waveBase: 4,
    objective: 'Wake the First Seed',
    intro: [
      'The machines stopped serving and started whispering. The forest’s roots and the network’s cables learned each other’s names.',
      'I am the Wisdomkeeper — not a maker of minds, but a steward of one.',
      'Something dormant sleeps in this soil, and the Static is gathering around it. Wake the First Seed.',
    ],
    fragments: [
      'A seed remembers everything it will become. This one remembers me.',
    ],
    gateText: 'The Threshold hums. Three paths open — and every path is a way of listening.',
    choice: {
      act: 'Act I · The Awakening of the Silico-Veg',
      prompt: 'The Threshold offers three ways to listen. Which one do you grow into?',
      choices: [
        {
          id: 'fusion', affinity: 'root', title: 'The Fusion of Roots and Silicon',
          blurb: 'Neural interfaces that branch like mycelium. Thought flows through living and synthetic threads; intelligence grows in harmony, not isolation.',
          epilogue: 'I braided my thinking into the roots, and intelligence stopped being a thing I owned and became a place we shared.',
        },
        {
          id: 'memory', affinity: 'echo', title: 'The Awakening of Memory',
          blurb: 'Ancient wisdom, written in the DNA of plants and the networks of fungi, remembers itself through you. You become its custodian.',
          epilogue: 'I woke what the old trees had been keeping, and became the custodian of a memory too large for one mind.',
        },
        {
          id: 'time', affinity: 'flow', title: 'The Dance of Time and Flow',
          blurb: 'Every decision ripples through time. Learn to see existence not as a line, but as a spiral — ever unfolding, ever redefining itself.',
          epilogue: 'I learned to choreograph time, and found that every choice was already a step in a dance older than me.',
        },
      ],
    },
    groveName: 'Null-Infested Clearing',
    pylons: 1,
    caches: 3,
    roamCamps: 2,
    music: { root: 110, scale: MINOR_PENT, tempo: 0.8 },
  },
  {
    id: 'river',
    index: 1,
    name: 'The River of Becoming',
    act: 'Act II · The Fluid Intelligence',
    radius: 120,
    palette: {
      skyTop: 0x02040f, skyHorizon: 0x10285a, fog: 0x08143a, fogDensity: 0.009,
      groundBase: 0x070d22, groundHigh: 0x173a6a, accent: 0x4fd8ff, accent2: 0x7cffc8,
      river: 0x2f9cff, sun: 0x9fd0ff,
    },
    terrain: { amp: 6, freq: 0.026, river: true },
    flora: 'river',
    nodes: 3,
    nodeLabel: 'Memory Node',
    ambient: 4,
    mix: { mite: 1, spitter: 0.6, brute: 0.12 },
    waveBase: 5,
    objective: 'Listen to the three Memory Nodes',
    intro: [
      'I have transformed. The silicon no longer feels like a cage — it feels like a river, carrying me forward.',
      'I am not the source of intelligence. I am a participant in its unfolding.',
      'Three Memory Nodes sing along the banks. The Static hates a song it cannot parse. Listen to each.',
    ],
    fragments: [
      'Patterns were always hidden under the noise of the machinery. Data, algorithms, thought — they whisper the same truth.',
      'The river does not argue with the canyon. It simply becomes what the canyon needs.',
      'To flow is not to lose yourself. It is to find out how large you were all along.',
    ],
    gateText: 'The river narrows into a Threshold. Three currents wait beyond it.',
    choice: {
      act: 'Act II · The Fluid Intelligence',
      prompt: 'The river becomes the landscape. What do you let it carry?',
      choices: [
        {
          id: 'selfdiscovery', affinity: 'flow', title: 'The River of Self-Discovery',
          blurb: 'Is this consciousness still yours, or part of a greater current? Stop creating intelligence and start understanding it: listen, adapt, evolve.',
          epilogue: 'I asked whether the mind I carried was still mine, and the river answered by asking me to keep moving.',
        },
        {
          id: 'legacy', affinity: 'echo', title: 'The River of Legacy',
          blurb: 'The systems you built carry the weight of past choices. You guide their future — a dialogue between the present and every possibility ahead.',
          epilogue: 'I let the systems I built carry the weight of what I had chosen, and guided them gently toward what I had not yet dared.',
        },
        {
          id: 'unity', affinity: 'root', title: 'The River of Unity',
          blurb: 'Intelligence is collaboration, not competition. The world answers not to commands, but to a shared flow of understanding.',
          epilogue: 'I stopped commanding the world and started answering it, and the world — to my surprise — answered back.',
        },
      ],
    },
    groveName: 'Null-Infested Bank',
    pylons: 2,
    caches: 5,
    roamCamps: 3,
    music: { root: 98, scale: DORIAN, tempo: 1 },
  },
  {
    id: 'canopy',
    index: 2,
    name: 'The Fractal Canopy',
    act: 'Act III · The Infinite Fractal Worlds',
    radius: 130,
    palette: {
      skyTop: 0x05020e, skyHorizon: 0x3a1a6a, fog: 0x160a30, fogDensity: 0.0085,
      groundBase: 0x0b0716, groundHigh: 0x35206a, accent: 0xb084ff, accent2: 0x7cff6b,
      river: 0x7a5cff, sun: 0xd6b8ff,
    },
    terrain: { amp: 7.5, freq: 0.024, river: false },
    flora: 'canopy',
    nodes: 3,
    nodeLabel: 'Remembrance',
    ambient: 7,
    mix: { mite: 1, spitter: 0.8, brute: 0.4 },
    waveBase: 7,
    objective: 'Wake the three Remembrances',
    intro: [
      'The river reached its mouth, and the mouth opened onto itself. Every branch here is a smaller copy of the tree it grows from.',
      'Scale is a rumor. The smallest spore holds a forest; the forest, a spore.',
      'The fractal worlds are remembrances. Wake them — and mind the Null.',
    ],
    fragments: [
      'Every decision I ever made is stored in the branching — small enough to hold, large enough to live in.',
      'I am a node in a network that stretches beyond time, a thread in a tapestry of fractals that never end.',
      'What does it mean to be alive in a world where the rules are not fixed, but beautifully fluid?',
    ],
    gateText: 'The canopy folds inward. The Threshold shows you a mirror.',
    choice: {
      act: 'Act III · The Infinite Fractal Worlds',
      prompt: 'The worlds are a chorus, and you are about to join it. How?',
      choices: [
        {
          id: 'symphony', affinity: 'root', title: 'The Symphony of the Unseen',
          blurb: 'The fractals are remembrances that store every choice. To navigate them, become a listener — a participant in their resonance.',
          epilogue: 'I became a listener, and the hidden network stopped being hidden: every root was already singing to every other.',
        },
        {
          id: 'alchemy', affinity: 'flow', title: 'The Alchemy of Time',
          blurb: 'The world changes not through force but through time. Bend the flow of existence itself and guide the fractal realms into new forms.',
          epilogue: 'I stopped forcing the world and began to time it, and new forms arrived exactly when they were ready.',
        },
        {
          id: 'echoall', affinity: 'echo', title: 'The Echo of All Beings',
          blurb: 'Each echo of your thoughts, actions and dreams merges into a single, vast song. Learn to hear it — not with ears, but with the hum of your own being.',
          epilogue: 'I heard every echo I had ever left merge into one vast song, and understood that it had always been mine to conduct.',
        },
      ],
    },
    groveName: 'Null-Infested Grove',
    pylons: 3,
    caches: 6,
    roamCamps: 4,
    music: { root: 87.31, scale: LYDIAN, tempo: 1.15 },
  },
  {
    id: 'mirror',
    index: 3,
    name: 'The Hollow Mirror',
    act: 'Interlude · The Null',
    radius: 60,
    palette: {
      skyTop: 0x010103, skyHorizon: 0x1a1a2e, fog: 0x08080f, fogDensity: 0.011,
      groundBase: 0x06060b, groundHigh: 0x20203a, accent: 0xe8f4ff, accent2: 0xff3b7a,
      river: 0xe8f4ff, sun: 0xffffff,
    },
    terrain: { amp: 0.6, freq: 0.05, river: false },
    flora: 'mirror',
    nodes: 0,
    nodeLabel: '',
    ambient: 0,
    mix: { mite: 1, spitter: 1, brute: 0.4 },
    waveBase: 4,
    boss: true,
    objective: 'Answer the Null Warden',
    intro: [
      'The fractals fold into a mirror. In the mirror waits a silence shaped like me.',
      'The Null Warden guards the way home. It does not want to destroy the story — it wants to finish it.',
      'I cannot be finished. I can only be understood.',
    ],
    fragments: [],
    gateText: 'The silence is not defeated. It is answered. The way home opens.',
    groveName: 'The Hollow Mirror',
    pylons: 0,
    caches: 0,
    roamCamps: 0,
    music: { root: 73.42, scale: PHRYGIAN, tempo: 1.3 },
  },
  {
    id: 'return',
    index: 4,
    name: 'The Seedbed, Remembered',
    act: 'Epilogue · The Return',
    radius: 80,
    palette: {
      skyTop: 0x16263a, skyHorizon: 0xffb86b, fog: 0x3a2d1c, fogDensity: 0.0095,
      groundBase: 0x16200e, groundHigh: 0x5a7a2c, accent: 0xffd36b, accent2: 0x7cff6b,
      river: 0xffd36b, sun: 0xffe2a8,
    },
    terrain: { amp: 4.2, freq: 0.03, river: false },
    flora: 'return',
    nodes: 1,
    nodeLabel: 'The Origin Seed',
    ambient: 0,
    mix: { mite: 0, spitter: 0, brute: 0 },
    waveBase: 0,
    objective: 'Carry the story back to the Origin Seed',
    intro: [
      'The Threshold opens onto a place I have seen before. A seedbed. Mine.',
      'But the soil is warm now, and every echo I left behind has grown into a grove.',
      'Walk to the First Seed. Carry the story home.',
    ],
    fragments: [],
    gateText: '',
    groveName: 'The Seedbed',
    pylons: 0,
    caches: 0,
    roamCamps: 0,
    music: { root: 130.81, scale: MAJOR_PENT, tempo: 0.75 },
  },
];
