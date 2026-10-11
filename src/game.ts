import * as THREE from 'three';
import type { Affinity, BossVariant, Choice, EnemyKind, Item, LibraryEntry, PlayStats, PunchKind, Remembrance, RunState, Skin } from './types';
import { setPortraitRenderer } from './ui/portrait';
import { Gfx } from './engine/gfx';
import { ThirdPersonCam } from './engine/camera';
import { Input } from './engine/input';
import { AudioEngine } from './engine/audio';
import { Particles } from './engine/particles';
import { UI, type HudState, type MapData, type MarkerSet } from './ui/ui';
import { setupTouch } from './ui/touch';
import { World, type CampSpec } from './world/world';
import { STRATA, type StratumDef } from './story/strata';
import {
  AFFINITY_META, LORE_BARKS, NULL_ENDING_THRESHOLD, OPENING_QUOTE, PERKS, SECOND_QUOTE, composeStory, emptyTiers, toLibraryEntry,
} from './story/story';
import { MycelialMind, NEUTRAL_LATENT, adaptDifficulty, describeStyle, digest, freshStats } from './systems/mind';
import { Encounter, type Anchor } from './systems/encounter';
import { infuse, infuseCost, missionLine, offerMissions } from './systems/missions';
import { Combat, COST } from './systems/combat';
import {
  RARITY, SLOT_LABEL, addXp, derive, generateItem, rankUp, rollRarity, skinUnlocked, xpToNext, type Derived,
} from './systems/progress';
import { Player, type Intent } from './entities/player';
import { Enemy, ENEMY_COST, ENEMY_NAME, enemyName, purgeStun, updateEnemy, updateSquads } from './entities/enemies';
import { NeuralDirector, type DirectorPhase } from './bio/director';
import { freshTelemetry, type PlayerTelemetry } from './bio/mindState';
import { floraGlow } from './engine/materials';
import { BOLT_COLORS, Projectiles } from './entities/projectiles';
import { Pickups, type PickupKind } from './entities/pickups';
import { AFFINITY_COLOR } from './entities/echoes';
import type { MemoryNode, Pylon } from './world/structures';
import { clamp, damp } from './util/math';
import { updateOcclusion } from './world/occlusion';
import { DatastreamDais } from './world/contact';
import { TraversalUI, type TravMode } from './ui/traversal-ui';
import { MAX_FIBER, TETHER_RANGE } from './entities/player';
import type { TetherAnchor } from './world/traversal';
import { LAYER } from './physics/physics';
import { StoryDeck, addPunch, buildStorycard, lastPunchOf, mergeLibrary, runFromCard, type Storycard } from './systems/storycards';
import { StorycardsPanel } from './ui/storycardsPanel';

type Mode = 'title' | 'prologue' | 'play' | 'choice' | 'transition' | 'dead' | 'ending';

const SAVE_KEY = 'wk.run.v2';
const LIB_KEY = 'wk.library.v1';
const SET_KEY = 'wk.settings.v1';
const HOT = new THREE.Color(0xff3b7a);
const TOTAL_REMEMBRANCES = 7;

interface PendingSpawn {
  kind: EnemyKind;
  x: number;
  z: number;
  t: number;
  fromEvent: boolean;
  fx: number;
}

interface CampState {
  spec: CampSpec;
  enemies: Enemy[];
  cleared: boolean;
  slot: number;
  fade: number;
}

const store = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, v: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode / quota: the game still works, it just forgets */
    }
  },
  del(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export class Game {
  readonly gfx: Gfx;
  readonly cam: ThirdPersonCam;
  readonly input = new Input();
  readonly audio = new AudioEngine();
  readonly ui = new UI();
  readonly trav = new TraversalUI();
  readonly particles = new Particles();
  readonly projectiles = new Projectiles();
  readonly pickups = new Pickups();
  readonly player = new Player();
  readonly combat: Combat;
  enemies: Enemy[] = [];
  world!: World;
  def: StratumDef = STRATA[0];
  run!: RunState;
  mind!: MycelialMind;
  /** Neural World Director: reservoir → memristor → SHA-256 pool → pacing, spawning pools, loot entropy. */
  director!: NeuralDirector;
  derived!: Derived;
  stats: PlayStats = freshStats();
  mode: Mode = 'title';
  paused = false;
  time = 0;
  diff = 1;
  enemyTimeScale = 1;
  god = false;
  stratumKills = 0;
  palette = { accentHDR: new THREE.Color(0x5cffc1), accent2HDR: new THREE.Color(0xb084ff) };
  aim = { point: new THREE.Vector3(), enemy: null as Enemy | null };

  private last = 0;
  encounter: { enc: Encounter; anchor: MemoryNode | Pylon; kind: 'node' | 'pylon' } | null = null;
  private pending: PendingSpawn[] = [];
  private camps: CampState[] = [];
  private boss: Enemy | null = null;
  private bossDown = false;
  private stratumEchoes = 0;
  private stratumDeaths = 0;
  private stratumPurified = 0;
  private stratumEmbraced = 0;
  private ambientTimer = 3;
  private pendingNote = '';
  private titleAngle = 0;
  private tutorial = 0;
  private flow = new THREE.Vector2();
  private mv = new THREE.Vector2();
  private look = new THREE.Vector2();
  private fwd = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private trans: { t: number; next: number; gate: THREE.Vector3 } | null = null;
  private firstEcho = true;
  private deathTimer = 0;
  private endingStart = 0;
  private story: ReturnType<typeof composeStory> | null = null;
  private expectUnlock = false;
  private travelBusy = false;
  private rayO = new THREE.Vector3();
  private rayD = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  /** Best tether target under the reticle this frame. */
  private tetherAim: { point: THREE.Vector3; anchor: TetherAnchor | null; label: string } | null = null;
  private tetherPoint = new THREE.Vector3();
  private wheelHold = 0;
  /** Time scale while the traversal wheel is open. */
  private slowmo = 1;
  private lastHurtT = -99;
  private directorPhase: DirectorPhase = 'calm';
  /** Act IV: the Construct's data-river pylons and the breach window when they all fall. */
  private veil: { pylons: Enemy[]; breach: number; wave: number } | null = null;
  private contactsLinked = 0;
  /** Storycards: autosave deck (last few distinct cards) and its overlay. */
  private deck = new StoryDeck(() => localStorage);
  private cards = new StorycardsPanel();

  /** Blueprint telemetry for the Mycelial Mind (persisted with the run). */
  get telemetry(): PlayerTelemetry {
    return (this.run.telemetry ??= freshTelemetry());
  }

  constructor(gfx: Gfx) {
    this.gfx = gfx;
    setPortraitRenderer(gfx.renderer);
    this.cam = new ThirdPersonCam(this.gfx.camera);
    this.combat = new Combat(this);
    const canvas = this.gfx.renderer.domElement;
    this.input.attach(canvas, () => this.audio.init());
    window.addEventListener('pointerdown', () => this.audio.init());
    if (matchMedia('(pointer: coarse)').matches) {
      setupTouch(this.input, () => this.audio.init());
      this.ui.showTouch(true);
      this.input.lastDevice = 'touch';
    }
    canvas.addEventListener('pointerdown', () => {
      if (this.mode === 'play' && !this.paused && !this.ui.anyOverlay()) this.input.requestLock();
    });
    this.input.onLockChange((locked) => {
      if (!locked && !this.expectUnlock && this.mode === 'play' && !this.paused && this.input.lockWanted && !this.ui.anyOverlay()) this.setPaused(true);
    });

    const scene = this.gfx.scene;
    scene.add(this.particles.sprite, this.projectiles.group, this.pickups.group, this.player.group, this.player.blobMesh, this.combat.fx.group, this.player.tether.mesh);

    this.applySettings();
    this.bindUI();
    this.newRun(1);
    this.showTitleWorld();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'play' && !this.paused) this.setPaused(true);
    });
  }

  start() {
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- settings / save

  private applySettings() {
    const s = store.get<{ vol: number; muted: boolean; bloom: boolean; sens: number }>(SET_KEY);
    if (!s) return;
    this.audio.volume = s.vol ?? 0.7;
    this.audio.muted = !!s.muted;
    this.gfx.setBloom(s.bloom !== false);
    (document.getElementById('vol') as HTMLInputElement).value = String(Math.round(this.audio.volume * 100));
    if (s.sens) {
      (document.getElementById('sens') as HTMLInputElement).value = String(s.sens);
      this.cam.sens = 0.0022 * (s.sens / 100);
    }
    this.ui.setMuteLabel(this.audio.muted);
    this.ui.setBloomLabel(this.gfx.bloomEnabled);
  }
  private saveSettings() {
    store.set(SET_KEY, {
      vol: this.audio.volume,
      muted: this.audio.muted,
      bloom: this.gfx.bloomEnabled,
      sens: Math.round((this.cam.sens / 0.0022) * 100),
    });
  }
  saveRun() {
    this.run.fiber = Math.round(this.player.fiber);
    store.set(SAVE_KEY, this.run);
    this.deck.push(buildStorycard(this.run));
  }
  /** Punch a story beat onto the run's Storycard (persisted with the next save). */
  punch(kind: PunchKind, text: string) {
    addPunch(this.run, kind, text);
  }
  private loadRun(): RunState | null {
    const r = store.get<RunState>(SAVE_KEY);
    return r && r.version === 2 && Array.isArray(r.history) && r.stratumIndex >= 0 && r.stratumIndex < STRATA.length ? r : null;
  }
  private library(): LibraryEntry[] {
    return store.get<LibraryEntry[]>(LIB_KEY) ?? [];
  }

  // ---------------------------------------------------------------- UI wiring

  private bindUI() {
    const ui = this.ui;
    ui.on('btn-begin', () => {
      this.audio.init();
      this.audio.sfx('click');
      this.beginNewStory();
    });
    ui.on('btn-continue', () => {
      this.audio.init();
      this.audio.sfx('click');
      const r = this.loadRun();
      if (r) this.continueRun(r);
    });
    ui.on('btn-library', () => ui.library(this.library()));
    this.cards.bind({
      current: () => {
        const r = this.mode === 'title' ? this.loadRun() : { ...this.run, fiber: Math.round(this.player.fiber) };
        return r ? buildStorycard(r, this.library()) : null;
      },
      deck: () => this.deck.list(),
      load: (card) => this.loadCard(card),
    });
    const openCards = () => {
      ui.hide('pause');
      this.cards.setStatus('');
      this.cards.render();
      ui.show('storycards');
    };
    ui.on('btn-storycards', openCards);
    ui.on('btn-storycards-p', openCards);
    ui.on('btn-controls', () => ui.show('controls'));
    ui.bindClose((id) => {
      ui.hide(id);
      if ((id === 'timeline' || id === 'inventory' || id === 'map') && this.mode !== 'title') this.closeOverlayResume();
      if (id === 'storycards' && this.mode === 'play' && this.paused) ui.show('pause');
    });
    ui.on('btn-resume', () => this.setPaused(false));
    ui.on('btn-layers', () => {
      ui.hide('pause');
      ui.timeline(this.run);
    });
    ui.on('btn-mute', () => {
      ui.setMuteLabel(this.audio.toggleMute());
      this.saveSettings();
    });
    ui.on('btn-bloom', () => {
      this.gfx.setBloom(!this.gfx.bloomEnabled);
      ui.setBloomLabel(this.gfx.bloomEnabled);
      this.saveSettings();
    });
    (document.getElementById('vol') as HTMLInputElement).addEventListener('input', (e) => {
      this.audio.setVolume(Number((e.target as HTMLInputElement).value) / 100);
      this.saveSettings();
    });
    (document.getElementById('sens') as HTMLInputElement).addEventListener('input', (e) => {
      this.cam.sens = 0.0022 * (Number((e.target as HTMLInputElement).value) / 100);
      this.saveSettings();
    });
    ui.on('btn-title', () => this.toTitle());
    ui.on('btn-reseed', () => this.reseed());
    ui.on('btn-newcycle', () => this.beginNextCycle());
    ui.on('btn-end-title', () => this.toTitle());
    ui.bindBinary();
    this.refreshTitleButtons();
  }

  private refreshTitleButtons() {
    const r = this.loadRun();
    document.getElementById('btn-continue')!.classList.toggle('hidden', !r || r.stratumIndex === 0);
    if (r && r.stratumIndex > 0) document.getElementById('btn-continue')!.textContent = `Continue · ${STRATA[r.stratumIndex].name}`;
  }

  private releaseLockQuiet() {
    this.expectUnlock = true;
    this.input.releaseLock();
    window.setTimeout(() => (this.expectUnlock = false), 400);
  }

  private setPaused(p: boolean) {
    if (p === this.paused) return;
    this.paused = p;
    if (p) {
      this.ui.show('pause');
      this.releaseLockQuiet();
    } else {
      this.ui.hide('pause');
      this.ui.hide('timeline');
      this.ui.hide('controls');
      this.ui.hide('inventory');
      this.ui.hide('map');
      this.input.requestLock();
    }
    this.ui.setMuteLabel(this.audio.muted);
    this.ui.setBloomLabel(this.gfx.bloomEnabled);
  }

  /** After closing a sub-overlay: back to the pause menu if paused from there, else resume. */
  private closeOverlayResume() {
    if (this.mode === 'play') {
      this.paused = false;
      this.input.requestLock();
    }
  }

  openOverlay(kind: 'inventory' | 'map' | 'timeline') {
    if (this.mode !== 'play') return;
    this.paused = true;
    this.ui.hide('pause');
    this.releaseLockQuiet();
    if (kind === 'timeline') this.ui.timeline(this.run);
    else if (kind === 'inventory') this.openInventory();
    else this.openMap();
  }

  // ---------------------------------------------------------------- run lifecycle

  private newRun(cycle: number) {
    const fixed = Number(new URLSearchParams(location.search).get('seed'));
    const seed = fixed > 0 ? fixed >>> 0 : (Math.random() * 0xffffffff) >>> 0;
    const rand = Math.random;
    const blade = generateItem(rand, 1, 'common', 'blade');
    blade.name = 'Root-Blade Unit';
    this.run = {
      version: 2,
      cycle,
      seed,
      stratumIndex: 0,
      tiers: emptyTiers(),
      history: [],
      echoes: [],
      maxHp: 100,
      deaths: 0,
      kills: 0,
      elapsed: 0,
      difficulty: 1 + 0.25 * (cycle - 1),
      latent: [...NEUTRAL_LATENT],
      level: 1,
      xp: 0,
      skillPoints: 0,
      skills: {},
      inventory: [],
      equipped: { blade },
      skin: 'resonant',
      nullPoints: 0,
      purityPoints: 0,
      remembrances: [],
      crystals: 0,
      telemetry: freshTelemetry(),
      punches: [],
    };
    this.mind = new MycelialMind(seed);
    this.director = new NeuralDirector(seed);
    this.diff = this.run.difficulty;
    this.refreshDerived();
  }

  refreshDerived() {
    this.derived = derive(this.run);
    this.player.hero.setSkin(this.run.skin);
    if (this.player.hp > this.derived.maxHp) this.player.hp = this.derived.maxHp;
  }

  private beginNewStory() {
    const saved = this.loadRun();
    if (saved && saved.stratumIndex > 0 && !window.confirm('Begin a new story? Your saved progress will be replaced.')) return;
    this.newRun(1);
    this.punch('cycle', 'Cycle 1 began — a seed in the soil of code');
    store.del(SAVE_KEY);
    this.startPrologue([OPENING_QUOTE, SECOND_QUOTE]);
  }

  private beginNextCycle() {
    const prev = this.run;
    const cycle = prev.cycle + 1;
    this.ui.hide('ending');
    this.newRun(cycle);
    // the Keeper carries a little of what it grew into the next cycle
    this.run.level = Math.max(1, Math.floor(prev.level / 2));
    this.run.skin = prev.skin;
    this.refreshDerived();
    this.punch('cycle', `Cycle ${cycle} began — the Keeper carries level ${this.run.level} into new soil`);
    store.del(SAVE_KEY);
    this.startPrologue(['Every ending is a seed.', OPENING_QUOTE, `Cycle ${cycle}. The soil is different this time — and so, perhaps, are you.`]);
  }

  private startPrologue(lines: string[]) {
    this.mode = 'prologue';
    this.ui.hide('title');
    this.ui.fade(false);
    this.ui.prologue(lines, () => {
      this.ui.fade(true, 'black', 0);
      this.enterStratum(0, true);
      this.ui.fade(false, 'black', 1400);
      this.input.requestLock();
    });
  }

  private continueRun(r: RunState) {
    this.run = r;
    this.mind = new MycelialMind(r.seed);
    this.director = new NeuralDirector(r.seed ^ r.elapsed);
    this.diff = r.difficulty;
    this.refreshDerived();
    this.ui.hide('title');
    this.ui.fade(true, 'black', 0);
    this.enterStratum(r.stratumIndex, true);
    this.ui.fade(false, 'black', 1200);
    this.input.requestLock();
  }

  /** Replace the current progress with a Storycard (upload or autosave deck). */
  private loadCard(card: Storycard): boolean {
    const saved = this.loadRun();
    const live = this.mode !== 'title';
    if ((live || (saved && saved.stratumIndex > 0)) && !window.confirm(`Load the storycard “${card.title}”? Your current progress will be replaced — it stays in the autosave deck so you can roll back.`)) return false;
    if (live) this.saveRun();
    else if (saved) this.deck.push(buildStorycard(saved));
    store.set(LIB_KEY, mergeLibrary(this.library(), card.library));
    this.ui.hideAll();
    this.paused = false;
    this.continueRun(runFromCard(card));
    return true;
  }

  private toTitle() {
    this.ui.hideAll();
    this.paused = false;
    this.mode = 'title';
    this.releaseLockQuiet();
    this.clearEntities();
    this.ui.setHudVisible(false);
    this.ui.clearSay();
    this.ui.fade(false);
    this.newRun(1);
    this.showTitleWorld();
    this.refreshTitleButtons();
    this.ui.show('title');
  }

  private buildWorld(def: StratumDef) {
    this.daises.forEach((d) => d.dispose());
    this.daises.clear();
    if (this.world) {
      this.gfx.scene.remove(this.world.group);
      this.world.dispose();
    }
    this.def = def;
    this.gfx.grace = 3.5;
    this.world = new World(def, this.run);
    this.gfx.scene.add(this.world.group);
    this.world.prime(this.world.startPos.x, this.world.startPos.z);
    this.cam.terrainH = (x, z) => this.world.terrain.heightAt(x, z);
    const p = this.world.palette;
    const lerpC = (a: number, b: number, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
    this.gfx.setWorldLook({
      fog: p.fog,
      fogDensity: p.fogDensity,
      hemiSky: lerpC(p.skyHorizon, p.accent, 0.35),
      hemiGround: lerpC(p.groundHigh, p.accent2, 0.2),
      sun: p.sun,
      accent: p.accent,
    });
    this.gfx.hemi.intensity = def.id === 'return' ? 1.5 : def.id === 'mirror' ? 1.25 : 1.15;
    this.gfx.sun.intensity = def.id === 'return' ? 2.0 : 1.5;
    this.palette.accentHDR.set(p.accent).multiplyScalar(1.8);
    this.palette.accent2HDR.set(p.accent2).multiplyScalar(1.8);
    this.combat.fx.setShieldColor(p.accent2);
    this.gfx.setEnvironment(this.world.sky.envScene(), def.id === 'mirror' ? 0.8 : 0.55);
    this.audio.setMood(def.music);
  }

  private showTitleWorld() {
    this.buildWorld(STRATA[0]);
    const g = this.world.terrain.heightAt(0, 6);
    this.player.reset(0, g, 6, 100);
    this.player.hero.forceBlade(true);
    this.mode = 'title';
  }

  private clearEntities() {
    for (const e of this.enemies) this.removeEnemy(e);
    this.enemies = [];
    this.pending = [];
    this.camps = [];
    this.encounter = null;
    this.boss = null;
    this.veil = null;
    this.contactsLinked = 0;
    this.projectiles.clear();
    this.pickups.clear();
    this.particles.clear();
    this.combat.reset();
  }

  private removeEnemy(e: Enemy) {
    this.gfx.scene.remove(e.group);
    e.dispose();
  }

  private enterStratum(index: number, snap: boolean) {
    this.clearEntities();
    this.run.stratumIndex = index;
    this.diff = this.run.difficulty;
    this.buildWorld(STRATA[index]);
    this.stats = freshStats();
    this.stratumKills = this.stratumEchoes = this.stratumDeaths = this.stratumPurified = this.stratumEmbraced = 0;
    this.bossDown = false;
    this.ambientTimer = 6;
    this.tutorial = 0;
    this.time = 0;
    this.enemyTimeScale = 1;
    this.paused = false;
    this.trans = null;
    this.cam.override = null;
    this.player.hero.forceBlade(false);

    const w = this.world;
    this.refreshDerived();
    this.player.reset(w.startPos.x, w.startPos.y, w.startPos.z, this.derived.maxHp);
    this.player.res = Math.max(this.player.res, 30);
    this.player.fiber = Math.max(this.run.fiber ?? 0, 20);
    for (const c of w.mushrooms.crowns) {
      for (let i = 0; i < 3; i++) this.pickups.place(c.x + Math.cos(i * 2.1) * 1.1, c.y, c.z + Math.sin(i * 2.1) * 1.1, 'fiber');
    }
    this.player.group.scale.setScalar(1);
    this.player.yaw = Math.atan2(-w.startPos.x, -w.startPos.z);
    this.cam.yaw = this.player.yaw;
    this.cam.pitch = 0.2;
    this.cam.snap(this.player.cameraTarget);
    this.cam.zoomRate = 1.7;
    this.cam.zoomTarget = 1;
    this.cam.fovTarget = 0;
    if (snap) {
      this.cam.zoom = 0.3;
      this.cam.fovBoost = 30;
    }

    this.spawnCamps();
    this.offerStratumMissions();
    if (this.def.boss) {
      this.spawnEnemy('boss', 0, 0, false);
      this.boss = this.enemies.find((e) => e.kind === 'boss') ?? null;
    }

    if (lastPunchOf(this.run, 'stratum')?.stratum !== index) this.punch('stratum', `Entered ${this.def.name} — ${this.def.act}`);
    this.mode = 'play';
    this.ui.hideAll();
    this.ui.setHudVisible(true);
    this.ui.clearSay();
    this.ui.banner(this.def.act, this.def.name);
    window.setTimeout(() => {
      if (this.run.stratumIndex !== index) return;
      this.ui.say(this.def.intro);
      if (this.pendingNote && index > 0 && !this.def.boss && this.def.id !== 'return') this.ui.say(`The Mycelial Mind noticed — ${this.pendingNote}`);
      this.pendingNote = '';
    }, 1800);
    this.saveRun();
  }

  private exitStratum(choice: Choice | null) {
    const f = digest(this.stats, this.run.maxHp);
    const latent = this.mind.latent(f);
    this.pendingNote = describeStyle(f, latent);
    this.run.history.push({
      stratum: this.def.id,
      stratumName: this.def.name,
      choice: choice ? { id: choice.id, affinity: choice.affinity, title: choice.title } : undefined,
      kills: this.stratumKills,
      echoes: this.stratumEchoes,
      deaths: this.stratumDeaths,
      time: this.stats.time,
      purified: this.stratumPurified,
      embraced: this.stratumEmbraced,
      mindNote: this.pendingNote,
    });
    this.run.latent = latent;
    this.run.difficulty = adaptDifficulty(this.run.difficulty, f);
    this.startTransition(this.run.stratumIndex + 1);
  }

  private startTransition(next: number) {
    const g = this.world.gate;
    const gatePos = g ? g.pos.clone().setY(g.group.position.y) : this.player.group.position.clone();
    this.trans = { t: 0, next, gate: gatePos };
    this.mode = 'transition';
    this.ui.setHudVisible(false);
    this.ui.fade(true, 'white', 1500);
    this.audio.sfx('gate');
    this.cam.override = gatePos.clone();
    this.cam.zoomTarget = 0.12;
    this.cam.fovTarget = 36;
    this.cam.zoomRate = 1.8;
    this.projectiles.clearEnemyBolts();
  }

  private updateTransition(dt: number) {
    const t = this.trans!;
    t.t += dt;
    const k = clamp(t.t / 1.6, 0, 1);
    const e = k * k * (3 - 2 * k);
    const p = this.player;
    p.x += (t.gate.x - p.x) * Math.min(1, dt * 2.6);
    p.z += (t.gate.z - p.z) * Math.min(1, dt * 2.6);
    p.y += (t.gate.y - p.y) * Math.min(1, dt * 2.6);
    p.mode = 'flight';
    this.playerFrame(dt, this.emptyIntent());
    p.group.scale.setScalar(1 - e * 0.8);
    this.updateWorldVisuals(dt);
    this.cam.update(dt, this.focus.copy(t.gate), { aim: false, flight: false, sprint: false });
    if (this.world.gate) this.world.gate.setOpen(true);
    if (t.t >= 1.75) {
      p.group.scale.setScalar(1);
      this.trans = null;
      this.enterStratum(t.next, true);
      this.ui.fade(false, 'white', 2000);
      this.input.requestLock();
    }
  }

  private checkpointPos() {
    const w = this.world;
    return w.checkpoint;
  }

  private reseed() {
    this.ui.hide('death');
    this.run.deaths++;
    this.stratumDeaths++;
    const w = this.world;
    const cp = this.checkpointPos();
    this.player.reset(cp.x, w.terrain.heightAt(cp.x, cp.z), cp.z, this.derived.maxHp);
    w.prime(cp.x, cp.z);
    this.player.hp = this.derived.maxHp;
    this.player.res = Math.max(this.player.res, 40);
    for (const e of this.enemies) if (e.kind !== 'boss' && (e.fromEvent || !e.idle)) e.dead = true;
    this.pending = [];
    this.projectiles.clearEnemyBolts();
    if (this.encounter) {
      this.encounter.anchor.setState('dormant');
      this.encounter = null;
    }
    this.combat.reset();
    this.mode = 'play';
    this.enemyTimeScale = 1;
    this.cam.snap(this.player.cameraTarget);
    this.particles.burst(new THREE.Vector3(cp.x, cp.y + 1, cp.z), BOLT_COLORS.base, 40, 10, 0.6, 0.9);
    this.audio.sfx('plant');
    this.ui.say('The soil remembers. I rise where I last listened.');
    this.input.requestLock();
  }

  // ---------------------------------------------------------------- main loop

  private frame = (ms: number) => {
    requestAnimationFrame(this.frame);
    const raw = (ms - this.last) / 1000;
    this.last = ms;
    if (raw <= 0 || raw > 5) return;
    const dt = Math.min(raw, 0.05);
    this.gfx.adapt(raw);
    this.handleGlobalKeys();
    try {
      this.tick(dt);
    } catch (err) {
      console.error(err);
    }
    this.particles.setScale(this.gfx.pointScale);
    if (this.debugPhoto) {
      this.gfx.camera.position.copy(this.debugPhoto.from);
      this.gfx.camera.lookAt(this.debugPhoto.to);
    }
    this.gfx.camera.updateMatrixWorld();
    this.gfx.followShadow(this.player.x, this.player.y, this.player.z);
    updateOcclusion(this.gfx.renderer, this.gfx.camera, this.tmp.set(this.player.x, this.player.y + 1, this.player.z));
    this.gfx.render();
    this.input.endFrame();
  };

  private handleGlobalKeys() {
    const k = this.input;
    if (k.wasPressed('KeyN')) this.ui.setMuteLabel(this.audio.toggleMute());
    if (k.wasPressed('Digit1')) this.ui.choiceKey(0);
    if (k.wasPressed('Digit2')) this.ui.choiceKey(1);
    if (k.wasPressed('Digit3')) this.ui.choiceKey(2);
    if (this.ui.isOpen('binary')) {
      if (k.wasPressed('KeyA')) this.ui.binaryKey('embrace');
      if (k.wasPressed('KeyB')) this.ui.binaryKey('purify');
    }
    if (k.wasPressed('Escape')) {
      if (this.ui.isOpen('timeline') || this.ui.isOpen('inventory') || this.ui.isOpen('map')) {
        this.ui.hide('timeline');
        this.ui.hide('inventory');
        this.ui.hide('map');
        if (this.mode === 'play') this.closeOverlayResume();
      } else if (this.ui.isOpen('controls') || this.ui.isOpen('library') || this.ui.isOpen('storycards')) {
        if (this.ui.isOpen('storycards') && this.mode === 'play' && this.paused) this.ui.show('pause');
        this.ui.hide('controls');
        this.ui.hide('library');
        this.ui.hide('storycards');
      } else if (this.mode === 'play') this.setPaused(!this.paused);
    }
    if (this.mode === 'play' || (this.mode === 'choice' && false)) {
      const toggle = (code: string, kind: 'inventory' | 'map' | 'timeline') => {
        if (!k.wasPressed(code)) return;
        const open = this.ui.isOpen(kind);
        if (open) {
          this.ui.hide(kind);
          this.closeOverlayResume();
        } else if (!this.ui.anyOverlay()) this.openOverlay(kind);
      };
      toggle('Tab', 'inventory');
      toggle('KeyI', 'inventory');
      toggle('KeyM', 'map');
      toggle('KeyL', 'timeline');
    }
  }

  private tick(dt: number) {
    switch (this.mode) {
      case 'title':
        this.updateTitle(dt);
        return;
      case 'prologue':
        return;
      case 'transition':
        this.updateTransition(dt);
        return;
      case 'choice':
        this.updateWorldVisuals(dt);
        this.cam.update(dt, this.player.cameraTarget, { aim: false, flight: false, sprint: false });
        this.playerFrame(dt, this.emptyIntent());
        return;
      case 'ending':
        this.updateEnding(dt);
        return;
    }
    if (this.paused) return;
    if (this.mode === 'dead') {
      this.deathTimer += dt;
      dt *= 0.3;
      if (this.deathTimer > 1.6 && !this.ui.isOpen('death')) this.ui.death(this.deathText());
    }
    this.updatePlay(dt);
  }

  private deathText() {
    const lines = [
      'Your thread frays — and the mycelium catches it.',
      'The Static takes a sentence. The soil keeps the rest.',
      'A seed does not end when it falls. It begins to listen.',
    ];
    return lines[this.run.deaths % lines.length];
  }

  // ---------------------------------------------------------------- title / ending

  private updateTitle(dt: number) {
    this.time += dt;
    this.titleAngle += dt * 0.08;
    const cam = this.gfx.camera;
    const r = 8.5;
    const px = this.player.x;
    const pz = this.player.z;
    const py = this.player.y;
    cam.position.set(px + Math.cos(this.titleAngle) * r, py + 2.2 + Math.sin(this.time * 0.25) * 0.25, pz + Math.sin(this.titleAngle) * r);
    cam.lookAt(px, py + 1.3, pz);
    this.player.yaw = this.titleAngle + 0.7;
    this.playerFrame(dt, this.emptyIntent());
    this.updateWorldVisuals(dt);
  }

  private updateEnding(dt: number) {
    this.playerFrame(dt, this.emptyIntent());
    this.updateWorldVisuals(dt);
    this.cam.update(dt, this.player.cameraTarget, { aim: false, flight: false, sprint: false });
    this.cam.yaw += dt * 0.12;
    if (performance.now() - this.endingStart > 3400 && this.story && !this.ui.isOpen('ending')) {
      this.ui.ending(this.story);
      this.ui.fade(false, 'white', 2600);
    }
  }

  // ---------------------------------------------------------------- helpers

  private emptyIntent(): Intent {
    return { mx: 0, mz: 0, jump: false, flightToggle: false, up: false, down: false, boost: false, dash: false, attackPressed: false, attackHeld: false, aim: false, tether: false };
  }

  private playerFrame(dt: number, it: Intent) {
    this.cam.forward3D(this.fwd);
    this.player.update(this, dt, it, this.cam.yaw, this.fwd);
  }

  private updateWorldVisuals(dt: number) {
    const ph = this.world.physics;
    this.world.stream(this.player.x, this.player.z);
    ph.step(dt);
    const wp = this.world.wilds?.pickups;
    while (wp && wp.length) {
      const k = wp.pop()!;
      this.pickups.place(k.x, k.y, k.z, k.kind, 150);
    }
    this.time += dt;
    this.world.update(dt, this.time, this.gfx.camera.position, this.gfx.pointScale, this.player.group.position);
    this.particles.update(dt);
    this.fadeCamps(dt);
  }

  flowAt(x: number, z: number) {
    const f = this.world.terrain.flowAt(x, z, this.flow);
    if (f.x === 0 && f.y === 0 && this.world.mycelium.cordAt(x, z, this.cordTmp) > 0) f.set(this.cordTmp.x * 6, this.cordTmp.y * 6);
    return f;
  }

  /** Strength (0..1) of a conducted mycelial cord under (x, z): the hero levitates along it for free. */
  cordAt(x: number, z: number) {
    return this.world.mycelium.cordAt(x, z, this.cordTmp);
  }
  private cordTmp = { x: 0, y: 0 };

  private buildIntent(dead: boolean): Intent {
    const inp = this.input;
    if (dead) return this.emptyIntent();
    const mv = inp.moveVector(this.mv);
    const f = { x: Math.sin(this.cam.yaw), z: Math.cos(this.cam.yaw) };
    const r = { x: -Math.cos(this.cam.yaw), z: Math.sin(this.cam.yaw) };
    const mx = f.x * -mv.y + r.x * mv.x;
    const mz = f.z * -mv.y + r.z * mv.x;
    const flying = this.player.mode === 'flight';
    return {
      mx,
      mz,
      jump: inp.wasPressed('Space'),
      flightToggle: inp.wasPressed('KeyV'),
      up: inp.isDown('Space'),
      down: inp.isDown('KeyC') || inp.isDown('ControlLeft'),
      boost: inp.isDown('ShiftLeft') || inp.isDown('ShiftRight'),
      dash: !flying && (inp.wasPressed('ShiftLeft') || inp.wasPressed('ShiftRight')),
      attackPressed: inp.wasPressed('MouseLeft'),
      attackHeld: inp.attackHeld,
      aim: inp.aimHeld,
      tether: inp.wasPressed('KeyT'),
    };
  }

  /** Where the camera's centre ray lands: the weak-point / reticle target for ranged fire. */
  private computeAim() {
    const cam = this.gfx.camera;
    this.rayO.copy(cam.position);
    this.cam.forward3D(this.rayD);
    const o = this.rayO;
    const d = this.rayD;
    let bestT = 1e9;
    let hit: Enemy | null = null;
    let near: Enemy | null = null;
    let nearAng = this.input.lastDevice === 'touch' ? 0.1 : 0.035;
    for (const e of this.enemies) {
      if (e.dead || e.spawnT < 0.5 || !e.group.visible) continue;
      const cx = e.x - o.x;
      const cy = e.y - o.y;
      const cz = e.z - o.z;
      const tca = cx * d.x + cy * d.y + cz * d.z;
      if (tca < 2 || tca > 120) continue;
      const d2 = cx * cx + cy * cy + cz * cz - tca * tca;
      const r = e.radius * 1.15;
      if (d2 < r * r) {
        const t = tca - Math.sqrt(r * r - d2);
        if (t < bestT) {
          bestT = t;
          hit = e;
        }
      } else {
        const ang = Math.atan2(Math.sqrt(d2) - e.radius, tca);
        if (ang < nearAng) {
          nearAng = ang;
          near = e;
        }
      }
    }
    let gT = 80;
    const terrain = this.world.terrain;
    for (let t = 3; t < 90; t += 1.5) {
      const y = o.y + d.y * t;
      if (y < terrain.heightAt(o.x + d.x * t, o.z + d.z * t)) {
        gT = t;
        break;
      }
    }
    const target = hit && bestT < gT ? hit : !hit && near ? near : null;
    this.aim.enemy = target;
    if (target) this.aim.point.set(target.x, target.y, target.z);
    else this.aim.point.copy(o).addScaledVector(d, gT);
  }

  nearestEnemy(x: number, z: number, maxD: number): Enemy | null {
    let best: Enemy | null = null;
    let bd = maxD * maxD;
    for (const e of this.enemies) {
      if (e.dead || e.spawnT < 1) continue;
      const d = (e.x - x) ** 2 + (e.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- play loop

  private updatePlay(dt: number) {
    const p = this.player;
    const dead = this.mode === 'dead';
    this.updateWheel(dt, dead);
    this.slowmo = damp(this.slowmo, this.trav.isOpen ? 0.22 : 1, 14, dt);
    dt *= this.slowmo;
    this.stats.time += dt;
    this.run.elapsed += dt;
    this.time += dt;
    p.dead = dead;

    // camera look: mouse (pointer lock), touch drag, or arrow keys as a fallback
    const look = this.input.consumeLook(this.look);
    if (this.trav.isOpen) this.trav.steer(look.x, look.y);
    else if (this.input.locked || this.input.lastDevice === 'touch') this.cam.look(look.x, look.y);
    const ar = (this.input.isDown('ArrowLeft') ? 1 : 0) - (this.input.isDown('ArrowRight') ? 1 : 0);
    const au = (this.input.isDown('ArrowDown') ? 1 : 0) - (this.input.isDown('ArrowUp') ? 1 : 0);
    if (ar || au) this.cam.look(-ar * dt * 900, au * dt * 700);
    this.cam.wheel(this.input.consumeWheel());

    this.computeAim();
    this.computeTetherAim();
    const it = this.buildIntent(dead);
    if (it.tether && !p.tether.active && !dead) this.tryTether();
    this.playerFrame(dt, it);
    if (!dead) {
      this.handleActions();
      this.updateTutorial();
    }
    if (this.encounter && !dead && this.encounter.enc.update(this, dt)) this.finishEncounter();

    this.updatePending(dt);
    if (!dead) {
      this.updateDirector(dt);
      this.updateAmbient(dt);
    }
    this.updateVeil(dt);
    if (!dead) this.updateMissionSites(dt);

    this.enemyTimeScale = damp(this.enemyTimeScale, 1, 3, dt);
    updateSquads(this);
    for (const e of this.enemies) if (!e.dead) updateEnemy(e, this, dt);
    this.enemies = this.enemies.filter((e) => {
      if (e.dead) {
        this.removeEnemy(e);
        return false;
      }
      return true;
    });

    this.combat.update(dt);
    this.projectiles.update(this, dt);
    this.pickups.update(this, dt);
    this.updateWorldVisuals(dt);
    if (p.hp <= 0 && this.mode === 'play') this.killPlayer();

    // camera: frame the boss as well once the arena is in play
    const target = p.cameraTarget;
    if (this.boss && !this.boss.dead) {
      const b = this.boss;
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < 60) {
        this.cam.zoomTarget = 1.5;
      }
    } else if (!this.trans) this.cam.zoomTarget = 1;
    this.cam.update(dt, target, { aim: p.aiming && !dead, flight: p.mode === 'flight', sprint: p.speed > 9 });
    p.hero.root.visible = !this.cam.firstPerson;

    const alive = this.enemies.filter((e) => !e.idle).length;
    this.audio.setIntensity(clamp(alive / 14 + (this.encounter ? 0.25 : 0) + (this.boss?.activated && !this.bossDown ? 0.4 : 0), 0, 1));

    this.drawHud();
  }

  private handleActions() {
    const k = this.input;
    const p = this.player;
    if (k.wasPressed('KeyQ')) this.combat.castSpike(p);
    if (k.wasPressed('KeyF')) this.combat.castShield(p);
    if (k.wasPressed('KeyR')) this.combat.castSurge(p);
    if (k.wasPressed('KeyG')) this.tryPlant();
    if (k.wasPressed('KeyE')) this.tryInteract();
  }

  // ---------------------------------------------------------------- camps & spawning

  private spawnCamps() {
    const def = this.def;
    const w = this.world;
    this.camps = [];
    let slot = 0;
    for (const spec of w.camps) {
      const kinds = this.campComposition(spec);
      const enemies: Enemy[] = [];
      kinds.forEach((kind, i) => {
        const a = (i / kinds.length) * Math.PI * 2 + Math.random();
        const r = spec.r * (0.25 + Math.random() * 0.5);
        const x = spec.x + Math.cos(a) * r;
        const z = spec.z + Math.sin(a) * r;
        const e = this.makeEnemy(kind, x, z, false);
        e.idle = true;
        e.campId = spec.id;
        e.aggroR = kind === 'brute' ? 28 : 24;
        enemies.push(e);
      });
      const st: CampState = { spec, enemies, cleared: false, slot: slot < 8 ? slot : -1, fade: 1 };
      if (st.slot >= 0) w.terrain.setCorruption(st.slot, spec.x, spec.z, spec.r * 1.25, 1);
      slot++;
      this.camps.push(st);
    }
    void def;
  }

  private campComposition(spec: CampSpec): EnemyKind[] {
    const def = this.def;
    const idx = def.index;
    const out: EnemyKind[] = [];
    const small = (n: number) => {
      for (let i = 0; i < n; i++) out.push(def.mix.spitter > 0 && Math.random() < def.mix.spitter / (1 + def.mix.spitter) * 0.8 ? 'spitter' : 'mite');
    };
    if (spec.kind === 'node') {
      if (def.mix.brute > 0) out.push('brute');
      if (idx >= 2 && spec.nodeIndex !== 0) out.push('brute');
      small(def.id === 'seedbed' ? 3 : 3 + idx * 2);
    } else {
      if (def.mix.brute > 0 && Math.random() < 0.5) out.push('brute');
      small(def.id === 'seedbed' ? 2 : 3 + idx);
    }
    return out;
  }

  private fadeCamps(dt: number) {
    for (const c of this.camps) {
      if (!c.cleared || c.fade <= 0) continue;
      c.fade = Math.max(0, c.fade - dt * 0.5);
      if (c.slot >= 0) this.world.terrain.setCorruption(c.slot, c.spec.x, c.spec.z, c.spec.r * 1.25, c.fade);
    }
  }

  wakeCamp(id: number, source: Enemy) {
    const c = this.camps.find((x) => x.spec.id === id);
    if (!c) return;
    for (const e of c.enemies) {
      if (e !== source && !e.dead) {
        e.idle = false;
        e.campId = id;
      }
    }
  }

  onEnemyKilled(e: Enemy) {
    if (e.kind === 'drone') this.missionProgress('hunt', 1, e.x, e.z, 1);
    else if (e.kind === 'brute') this.missionProgress('hunt', 1, e.x, e.z, 0);
    if (e.campId < 0) return;
    const c = this.camps.find((x) => x.spec.id === e.campId);
    if (!c || c.cleared) return;
    if (c.enemies.every((o) => o.dead)) {
      c.cleared = true;
      this.gainXp(c.spec.kind === 'node' ? 90 : 60);
      this.audio.sfx('ready');
      this.audio.sfx('plant');
      this.ui.toast(`${c.spec.name} purged`);
      this.punch('camp', `${c.spec.name} purged`);
      this.missionProgress('pool', 1, c.spec.x, c.spec.z, c.spec.id);
      this.dropLoot(c.spec.x, c.spec.z, 'cache');
      this.plantEcho(c.spec.x, c.spec.z, 'node');
      this.world.mycelium.seed(c.spec.x, c.spec.z, 10, 0, 80);
      if (c.spec.kind === 'node' && this.def.id !== 'return') this.ui.say('The guardians fall. The Remembrance is free to speak.');
    }
  }

  campCleared(nodeIndex: number) {
    const c = this.camps.find((x) => x.spec.nodeIndex === nodeIndex);
    return !c || c.cleared;
  }

  get pendingSpawnCount() {
    return this.pending.length;
  }

  queueSpawn(kind: EnemyKind, x: number, z: number, fromEvent: boolean) {
    const R = this.world.radius * 0.92;
    const r = Math.hypot(x, z);
    if ((fromEvent || !this.world.terrain.wild) && r > R) {
      x *= R / r;
      z *= R / r;
    }
    this.pending.push({ kind, x, z, t: kind === 'boss' ? 0.2 : 0.9, fromEvent, fx: 0 });
  }

  private updatePending(dt: number) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const s = this.pending[i];
      s.t -= dt;
      s.fx -= dt;
      if (s.fx <= 0) {
        s.fx = 0.07;
        const y = this.world.terrain.heightAt(s.x, s.z) + 0.3;
        const a = Math.random() * Math.PI * 2;
        const rad = 1.8 * (s.t / 0.9 + 0.2);
        this.particles.emit(s.x + Math.cos(a) * rad, y, s.z + Math.sin(a) * rad, 0, 2.5, 0, HOT.clone().multiplyScalar(2.2), 0.45, 0.5, 1);
      }
      if (s.t <= 0) {
        this.pending.splice(i, 1);
        this.spawnEnemy(s.kind, s.x, s.z, s.fromEvent);
      }
    }
  }

  private makeEnemy(kind: EnemyKind, x: number, z: number, fromEvent: boolean, variant: BossVariant = 'warden'): Enemy {
    const e = new Enemy(kind, x, z, this.diff, this.world.terrain.heightAt(x, z), variant);
    e.fromEvent = fromEvent;
    this.enemies.push(e);
    this.gfx.scene.add(e.group);
    if (kind === 'brute' || kind === 'boss') e.group.rotation.y = e.yawFace;
    return e;
  }

  spawnEnemy(kind: EnemyKind, x: number, z: number, fromEvent: boolean, variant: BossVariant = 'warden') {
    if (this.enemies.length > 70 && kind !== 'boss' && kind !== 'pylon') return;
    const e = this.makeEnemy(kind, x, z, fromEvent, variant);
    const y = this.world.terrain.heightAt(x, z);
    this.particles.burst(new THREE.Vector3(x, y + 1, z), HOT, kind === 'boss' ? 40 : 10, 6, 0.5, 0.6);
    return e;
  }

  spawnBudget(budget: number, cx: number, cz: number, fromEvent: boolean) {
    const mix = this.def.mix;
    const kinds = (['mite', 'spitter', 'brute', 'drone'] as const).filter((k) => (mix[k] ?? 0) > 0);
    if (!kinds.length) return;
    let left = budget;
    let guard = 0;
    while (left > 0 && guard++ < 30) {
      const options = kinds.filter((k) => ENEMY_COST[k] <= left);
      if (!options.length) break;
      const total = options.reduce((a, k) => a + (mix[k] ?? 0), 0);
      let roll = this.director.random() * total;
      let kind = options[0];
      for (const k of options) {
        roll -= mix[k] ?? 0;
        if (roll <= 0) {
          kind = k;
          break;
        }
      }
      left -= ENEMY_COST[kind];
      let x = cx;
      let z = cz;
      for (let tries = 0; tries < 6; tries++) {
        const a = Math.random() * Math.PI * 2;
        const r = 18 + Math.random() * 8;
        x = cx + Math.cos(a) * r;
        z = cz + Math.sin(a) * r;
        if ((x - this.player.x) ** 2 + (z - this.player.z) ** 2 > 100) break;
      }
      this.queueSpawn(kind, x, z, fromEvent);
    }
  }

  private updateAmbient(dt: number) {
    if (this.def.ambient <= 0 || this.def.boss || this.mode !== 'play' || this.trans) return;
    if (this.boss && this.boss.activated && !this.boss.dead) return;
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    const dir = this.director.out;
    // the Director's pacing curve stretches or tightens the hunt
    this.ambientTimer = dir.phase === 'surge' ? 2.5 : dir.phase === 'respite' ? 7 : 4;
    const p = this.player;
    const terrain = this.world.terrain;
    // the farther into the Wilds, and the deeper into Null blight, the more the Null hunts you
    const wildness = terrain.wildness(p.x, p.z);
    const blight = terrain.blightAt(p.x, p.z);
    const target = Math.round(((this.def.ambient * (0.7 + 0.3 * this.diff)) / 2 + wildness * 2 + blight * 3) * dir.threat);
    const ambientAlive = this.enemies.filter((e) => !e.dead && !e.fromEvent && e.campId < 0).length + this.pending.filter((s) => !s.fromEvent).length;
    if (ambientAlive >= target) return;
    if (this.world.nodes.length && this.world.nodes.every((n) => n.state === 'done') && this.gateOpen()) return;
    const R = this.world.radius * 0.85;
    for (let tries = 0; tries < 8; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 45 + Math.random() * 35;
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      if (!terrain.wild && Math.hypot(x, z) > R) continue;
      if (terrain.riverAt(x, z) > 0.3) continue;
      const rnd = () => this.director.random();
      // spawning pools: entropy spikes and surges feed Void-Root Fiends
      if (this.def.mix.brute > 0 && rnd() < (blight > 0.3 ? 0.25 : 0) + dir.fiendBias) {
        this.queueSpawn('brute', x, z, false);
        return;
      }
      const mix = this.def.mix;
      if ((mix.drone ?? 0) > 0 && rnd() < (mix.drone ?? 0) * (dir.phase === 'calm' ? 0.25 : 0.45)) {
        this.queueSpawn('drone', x, z, false);
        return;
      }
      const kinds = (['mite', 'spitter'] as const).filter((k) => mix[k] > 0);
      const total = kinds.reduce((s, k) => s + mix[k], 0);
      let roll = rnd() * total;
      let kind = kinds[0];
      for (const k of kinds) {
        roll -= mix[k];
        if (roll <= 0) {
          kind = k;
          break;
        }
      }
      this.queueSpawn(kind, x, z, false);
      return;
    }
  }

  // ---------------------------------------------------------------- Neural World Director

  private updateDirector(dt: number) {
    const p = this.player;
    const t = this.telemetry;
    if (p.mode === 'flight') t.flightTime += dt;
    const engaged = this.enemies.reduce((n, e) => n + (!e.dead && !e.idle && e.engage ? 1 : 0), 0);
    const out = this.director.update(dt, { hp: p.hp / this.derived.maxHp, engaged, sinceHurt: this.time - this.lastHurtT, difficulty: this.diff }, t);
    // the Mycelial Mind's directive drives the world's bioluminescence (smoothed so it breathes, never pops)
    const glowTarget = clamp(out.directives.floraGlowIntensity / 1.8, 0.6, 1.6) * (out.phase === 'surge' ? 0.85 : 1);
    floraGlow.value += (glowTarget - floraGlow.value) * Math.min(1, dt * 0.5);
    if (out.phase !== this.directorPhase) {
      this.directorPhase = out.phase;
      if (this.def.ambient > 0 && !this.def.boss && !(this.boss && this.boss.activated)) {
        if (out.phase === 'stirring') this.ui.toast('The mycelium stirs — the Null is gathering');
        else if (out.phase === 'surge') {
          this.ui.toast('Null surge — spawning pools are boiling over');
          this.audio.sfx('boss', 0.6);
        } else if (out.phase === 'respite') this.ui.toast('The network quiets. Breathe.');
      }
    }
  }

  /** Scatter Void Crystals (the blueprint currency) around a point. */
  dropCrystals(x: number, z: number, n: number) {
    for (let i = 0; i < n; i++) this.pickups.drop(x, z, 'crystal');
  }

  // ---------------------------------------------------------------- side missions

  private get missions() {
    return (this.run.missions ??= []);
  }

  private activeMissions() {
    return this.missions.filter((m) => m.stratum === this.def.index);
  }

  private offerStratumMissions() {
    if (this.activeMissions().length) return;
    const w = this.world;
    const R = w.radius;
    const next = this.missions.reduce((n, m) => Math.max(n, m.id + 1), 1);
    const site = (rnd: () => number) => {
      for (let i = 0; i < 40; i++) {
        const a = rnd() * Math.PI * 2;
        const r = R * (0.35 + rnd() * 0.5);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (w.terrain.riverAt(x, z) < 0.05 && Math.hypot(x - w.startPos.x, z - w.startPos.z) > 30) return { x, z };
      }
      return null;
    };
    const got = offerMissions(this.def, w.camps, () => this.director.random(), next, site);
    if (!got.length) return;
    this.missions.push(...got);
    window.setTimeout(() => {
      if (this.mode === 'play' && this.def.index === got[0].stratum) this.ui.toast(`New side missions · ${got.map((m) => m.title).join(' · ')}`);
    }, 9000);
  }

  /** Count progress toward active side missions in this region. */
  missionProgress(kind: 'pool' | 'harvest' | 'hunt' | 'contact', n: number, _x: number, _z: number, target = -1) {
    for (const m of this.activeMissions()) {
      if (m.state !== 'active' || m.kind !== kind) continue;
      if ((kind === 'pool' || kind === 'hunt') && m.target !== target) continue;
      m.have = Math.min(m.need, m.have + n);
      if (m.have >= m.need) this.completeMission(m);
    }
  }

  private completeMission(m: (typeof this.missions)[number]) {
    m.state = 'done';
    this.run.crystals = (this.run.crystals ?? 0) + m.reward;
    this.gainXp(70 + this.def.index * 20);
    this.audio.sfx('ready');
    this.ui.toast(`Mission complete — ${m.title} · +${m.reward} Void Crystals`);
    this.punch('mission', `Mission complete — ${m.title}`);
    this.director.stimulate(this.player.x, this.player.z, this.world.radius, 1.2);
    this.saveRun();
  }

  /** Datastream contacts: a column of rising glyph-light the hero must reach. */
  private updateMissionSites(dt: number) {
    const p = this.player;
    const live = new Set<number>();
    for (const m of this.activeMissions()) {
      if (m.kind !== 'contact' || m.state !== 'active') continue;
      live.add(m.id);
      let dais = this.daises.get(m.id);
      if (!dais) {
        dais = new DatastreamDais(m.x, this.world.terrain.heightAt(m.x, m.z) - 0.1, m.z, new THREE.Color(this.world.palette.accent), m.id + 3);
        this.daises.set(m.id, dais);
        this.world.group.add(dais.group);
      }
      dais.update(this.time, this.gfx.camera.position);
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < 7) {
        this.player.res = this.derived.maxRes;
        this.missionProgress('contact', 1, m.x, m.z);
        this.ui.say('The datastream folds into the Root-Blade. For a moment I can read the whole stratum.');
        continue;
      }
      if (d > 160 || Math.random() > dt * 30) continue;
      const y = this.world.terrain.heightAt(m.x, m.z);
      const a = Math.random() * Math.PI * 2;
      this.particles.emit(m.x + Math.cos(a) * 1.2, y + Math.random() * 2, m.z + Math.sin(a) * 1.2, 0, 6 + Math.random() * 4, 0, this.palette.accentHDR, 0.45, 2.6, 0.2, 0);
    }
    for (const [id, dais] of this.daises) {
      if (live.has(id)) continue;
      dais.group.removeFromParent();
      dais.dispose();
      this.daises.delete(id);
    }
  }
  private daises = new Map<number, DatastreamDais>();

  // ---------------------------------------------------------------- Act IV: the Veil of Void

  private linkContact(node: MemoryNode) {
    this.contactsLinked++;
    const total = this.world.nodes.length;
    const frag = this.def.fragments[Math.min(this.contactsLinked, this.def.fragments.length) - 1];
    if (frag) this.ui.say(frag);
    this.gainXp(140);
    this.dropCrystals(node.pos.x, node.pos.z, 4);
    this.player.hp = this.derived.maxHp;
    this.player.res = Math.min(this.derived.maxRes, this.player.res + 50);
    this.missionProgress('contact', 1, node.pos.x, node.pos.z);
    this.ui.toast(`Resonance Contact linked · ${this.contactsLinked}/${total} · Core Resonator ${Math.round((this.contactsLinked / total) * 100)}%`);
    this.punch('contact', `Resonance Contact linked (${this.contactsLinked}/${total})`);
    if (this.contactsLinked >= total) this.wakeConstruct();
    this.saveRun();
  }

  /** All Contacts linked: the Central Pylon answers, and the Construct steps out in front of it. */
  private wakeConstruct() {
    const g = this.world.gate;
    const gx = g ? g.pos.x : 0;
    const gz = g ? g.pos.z : 0;
    const l = Math.hypot(gx, gz) || 1;
    const x = gx - (gx / l) * 18;
    const z = gz - (gz / l) * 18;
    const e = this.spawnEnemy('boss', x, z, false, 'construct');
    if (!e) return;
    e.yawFace = Math.atan2(-gx, -gz);
    e.group.rotation.y = e.yawFace;
    e.aggroR = 60;
    this.boss = e;
    this.veil = { pylons: [], breach: 0, wave: 0 };
    this.raisePylons(e, 3);
    this.world.mycelium.connect({ x: this.player.x, z: this.player.z }, { x, z });
    this.audio.sfx('boss');
    this.shake(1);
    this.ui.say(['Elder Gaia: "The Central Pylon is lit — and it is not alone."', 'Something vast unfolds from the datastream in front of the Pylon.']);
  }

  /** Raise `n` Integrated Data-River Pylons around the Construct; while any stands its shell is sealed. */
  private raisePylons(boss: Enemy, n: number) {
    const v = this.veil;
    if (!v) return;
    v.wave++;
    v.breach = 0;
    const off = this.director.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * Math.PI * 2;
      const r = 19 + (i % 2) * 5;
      const e = this.spawnEnemy('pylon', boss.x + Math.cos(a) * r, boss.z + Math.sin(a) * r, false);
      if (e) {
        e.idle = false;
        v.pylons.push(e);
      }
    }
    boss.armored = true;
  }

  onPylonDestroyed(e: Enemy) {
    const v = this.veil;
    if (!v) return;
    v.pylons = v.pylons.filter((p) => p !== e && !p.dead);
    if (v.pylons.length === 0 && this.boss && !this.boss.dead) {
      v.breach = 16;
      this.boss.armored = false;
      this.boss.state = 'stun';
      this.boss.st = 2.2;
      this.ui.toast('The data-rivers are cut — the Construct\'s core is exposed!');
      this.audio.sfx('gate');
      this.shake(0.9);
    } else this.ui.toast(`Data-River Pylon destroyed · ${v.pylons.length} remain`);
  }

  private updateVeil(dt: number) {
    const v = this.veil;
    const b = this.boss;
    if (!v || !b || b.dead) return;
    // data-river beams: each pylon feeds a conduit socket on the Construct's back
    const s = b.group.scale.x;
    const sy = Math.sin(b.yawFace);
    const cy = Math.cos(b.yawFace);
    v.pylons.forEach((p, i) => {
      if (p.dead) return;
      if (!b.activated || p.spawnT < 1) {
        if (p.beam) p.beam.visible = false;
        return;
      }
      const lx = (i % 2 ? 0.95 : -0.95) * s;
      const lz = -1.72 * s;
      p.aimBeam(5.6, b.x + cy * lx + sy * lz, b.group.position.y + 6.15 * s, b.z - sy * lx + cy * lz, 3.2 + Math.sin(this.time * 9 + i) * 0.8);
    });
    if (v.breach > 0) {
      v.breach -= dt;
      if (v.breach <= 0) {
        this.ui.toast('The Construct reseals its shell — new pylons rise');
        this.raisePylons(b, Math.min(4, 1 + b.phase));
      }
    } else b.armored = v.pylons.some((p) => !p.dead);
  }

  private constructDefeated(e: Enemy) {
    const pos = new THREE.Vector3(e.x, e.y + 3, e.z);
    this.particles.burst(pos, new THREE.Color(0x38f2ff).multiplyScalar(3.5), 180, 30, 1.3, 1.9);
    this.particles.ring(pos, new THREE.Color(0xd36bff).multiplyScalar(3), 100, 36, 1, 1.6);
    this.audio.sfx('bossdie');
    this.shake(1.8);
    this.enemyTimeScale = 0.2;
    this.projectiles.clearEnemyBolts();
    this.veil = null;
    for (const o of this.enemies) if (o !== e && !o.dead) this.combat.killEnemy(o);
    this.pending = [];
    this.ui.say(['The Construct kneels. The datastreams pour out of it and back into the ground where they belong.', this.def.gateText]);
    const gate = this.world.gate;
    if (gate) {
      gate.group.visible = true;
      gate.setOpen(true);
      this.world.mycelium.connect({ x: e.x, z: e.z }, { x: gate.pos.x, z: gate.pos.z });
    }
    this.world.mycelium.seed(e.x, e.z, 24, 0, 100);
    this.dropLoot(e.x, e.z, 'boss');
    this.dropCrystals(e.x, e.z, 14);
    this.gainXp(400);
    this.audio.sfx('gate');
  }

  // ---------------------------------------------------------------- hooks used by combat/entities

  hurtPlayer(dmgIn: number, sx: number, sz: number): boolean {
    const p = this.player;
    if (p.dead || p.invuln > 0 || this.god || this.mode !== 'play') return false;
    if (p.shield > 0) {
      this.combat.shieldAbsorb(dmgIn, p.x, p.y + 1, p.z);
      p.invuln = 0.15;
      return true;
    }
    const dmg = dmgIn * (1 - this.derived.dr);
    p.hp -= dmg;
    this.lastHurtT = this.time;
    p.invuln = 0.6;
    p.hurtT = 0.6;
    this.stats.damageTaken += dmg;
    const dx = p.x - sx;
    const dz = p.z - sz;
    const l = Math.hypot(dx, dz) || 1;
    if (p.mode !== 'flight') {
      p.vx += (dx / l) * 8;
      p.vz += (dz / l) * 8;
    }
    this.shake(0.7);
    this.ui.hurtFlash();
    this.audio.sfx('hurt');
    this.particles.burst(new THREE.Vector3(p.x, p.y + 1, p.z), HOT.clone().multiplyScalar(2), 14, 8, 0.5, 0.6);
    if (p.hp <= 0) this.killPlayer();
    return true;
  }

  private killPlayer() {
    if (this.mode === 'dead') return;
    const p = this.player;
    p.hp = 0;
    p.dead = true;
    this.mode = 'dead';
    this.punch('death', `Fell in ${this.def.name} — the mycelium caught the thread`);
    this.deathTimer = 0;
    this.particles.burst(new THREE.Vector3(p.x, p.y + 1, p.z), BOLT_COLORS.base, 60, 12, 0.7, 1.2);
    this.particles.ring(new THREE.Vector3(p.x, p.y + 1, p.z), BOLT_COLORS.base, 40, 14, 0.6, 1);
    this.audio.sfx('surge');
    this.shake(1.2);
    this.releaseLockQuiet();
  }

  collect(kind: PickupKind, item?: Item) {
    const p = this.player;
    const pos = new THREE.Vector3(p.x, p.y + 1, p.z);
    if (kind === 'heal') p.hp = Math.min(this.derived.maxHp, p.hp + 12);
    else if (kind === 'res') p.res = Math.min(this.derived.maxRes, p.res + 10);
    else if (kind === 'fiber') p.fiber = Math.min(MAX_FIBER, p.fiber + 12);
    else if (kind === 'crystal') {
      this.run.crystals = (this.run.crystals ?? 0) + 1;
      this.missionProgress('harvest', 1, p.x, p.z);
    } else if (item) this.acquireItem(item);
    if (kind !== 'gear') {
      this.audio.sfx('pickup', kind === 'heal' ? 1 : 1.3);
      this.particles.burst(pos, kind === 'heal' ? new THREE.Color(0x7cff6b).multiplyScalar(2.5) : kind === 'crystal' ? new THREE.Color(0xb46bff).multiplyScalar(3) : kind === 'fiber' ? new THREE.Color(0xc2ff7a).multiplyScalar(2.5) : new THREE.Color(0x4fb4ff).multiplyScalar(2.5), 6, 4, 0.35, 0.4);
    }
  }

  private acquireItem(item: Item) {
    const r = this.run;
    const rar = RARITY[item.rarity];
    const slotEmpty = !r.equipped[item.slot];
    if (slotEmpty) {
      r.equipped[item.slot] = item;
      this.refreshDerived();
      this.ui.toast(`Equipped ${item.name} (${rar.name})`);
    } else if (r.inventory.length >= 60) {
      this.gainXp(10 * RARITY_ORDER_INDEX[item.rarity]);
      this.ui.toast(`Pack full — ${item.name} dismantled`);
    } else {
      r.inventory.push(item);
      this.ui.toast(`${rar.name} ${SLOT_LABEL[item.slot]}: ${item.name}`);
    }
    this.audio.sfx(item.rarity === 'epic' || item.rarity === 'legendary' ? 'node' : 'pickup', 1.5);
    this.ui.refreshInventory();
  }

  dropLoot(x: number, z: number, source: 'kill' | 'fiend' | 'cache' | 'pylon' | 'embrace' | 'boss') {
    const idx = this.def.index;
    const weights =
      source === 'kill' ? { common: 70, uncommon: 26, rare: 4 }
      : source === 'fiend' ? { uncommon: 45, rare: 40, epic: 15 }
      : source === 'cache' ? { uncommon: 20 - idx * 3, rare: 50, epic: 25 + idx * 3, legendary: 5 + idx * 2 }
      : source === 'pylon' ? { rare: 55, epic: 38, legendary: 7 }
      : source === 'embrace' ? { epic: 62, legendary: 38 }
      : { legendary: 1 };
    const rnd = () => this.director.random();
    const item = generateItem(rnd, this.run.level + this.def.index, rollRarity(rnd, weights));
    this.pickups.dropGear(x, z, item);
    if (source === 'boss') this.pickups.dropGear(x + 2, z, generateItem(Math.random, this.run.level + 4, 'legendary'));
  }

  gainXp(n: number) {
    const gained = addXp(this.run, n * (1 + this.def.index * 0.15));
    if (gained > 0) {
      this.refreshDerived();
      const p = this.player;
      p.hp = Math.min(this.derived.maxHp, p.hp + this.derived.maxHp * 0.35);
      this.ui.toast(`LEVEL ${this.run.level} — skill point earned [Tab]`);
      this.punch('level', `Reached level ${this.run.level}`);
      this.audio.sfx('node');
      this.particles.ring(new THREE.Vector3(p.x, p.y + 0.6, p.z), new THREE.Color(0xffc14a).multiplyScalar(3), 40, 9, 0.6, 0.9);
    }
  }

  onHardLanding(p: Player, speed: number) {
    this.shake(Math.min(0.9, speed * 0.03));
    this.particles.ring(new THREE.Vector3(p.x, p.y + 0.3, p.z), this.palette.accentHDR, 24, 8, 0.5, 0.6);
    this.world.props.debris.burst('rubble', p.x, p.y + 0.2, p.z, Math.min(10, Math.round(speed / 3)), speed * 0.3, new THREE.Color(0x30343c), 0.8);
    this.strikeProps(p.x, p.y + 0.5, p.z, 3.5, speed > 24 ? 30 : 0, speed * 0.5);
  }

  /** Physical impact on props (crystals, pods, debris) plus the loot that falls out. */
  strikeProps(x: number, y: number, z: number, radius: number, dmg: number, push: number, dirX = 0, dirZ = 0) {
    const hit = this.world.props.strike(x, y, z, radius, dmg, push, dirX, dirZ);
    for (const c of hit.crystals) {
      this.pickups.drop(c.x, c.z, 'res');
      this.pickups.drop(c.x, c.z, 'res');
      this.pickups.drop(c.x, c.z, 'fiber');
      this.particles.burst(this.tmp.set(c.x, c.y, c.z), new THREE.Color(0x9fd8ff).multiplyScalar(2.6), 26, 9, 0.5, 0.7);
      this.audio.sfx('kill', 1.6);
      this.shake(0.25);
    }
    for (const q of hit.pods) {
      this.pickups.drop(q.x, q.z, 'fiber');
      this.pickups.drop(q.x, q.z, 'fiber');
      if (Math.random() < 0.4) this.pickups.drop(q.x, q.z, 'heal');
      this.particles.burst(this.tmp.set(q.x, q.y, q.z), new THREE.Color(0xc2ff7a).multiplyScalar(2.6), 22, 6, 0.5, 0.8);
      this.audio.sfx('pickup', 0.7);
    }
  }

  // ---------------------------------------------------------------- traversal: tether & mode wheel

  /** Pick the anchor closest to the reticle, else a solid surface along the view ray. */
  private computeTetherAim() {
    const p = this.player;
    this.tetherAim = null;
    if (p.tether.active || this.mode !== 'play') return;
    const o = this.gfx.camera.position;
    const d = this.rayD;
    this.cam.forward3D(d);
    let best: TetherAnchor | null = null;
    let bestAng = this.input.lastDevice === 'touch' ? 0.32 : 0.2;
    for (const a of this.world.tetherAnchors) {
      const dist = Math.hypot(a.pos.x - p.x, a.pos.y - p.y, a.pos.z - p.z);
      if (dist > TETHER_RANGE || dist < 3) continue;
      this.tmp.subVectors(a.pos, o);
      const len = this.tmp.length();
      const ang = Math.acos(Math.min(1, this.tmp.dot(d) / len));
      if (ang < bestAng) {
        bestAng = ang;
        best = a;
      }
    }
    if (best) {
      this.tetherAim = { point: best.pos, anchor: best, label: `[T] ${best.label}` };
      return;
    }
    // any static / platform surface the reticle touches (not open ground, not loose debris)
    const hit = this.world.physics.rayHit(o.x, o.y, o.z, d.x, d.y, d.z, TETHER_RANGE + 12, LAYER.static | LAYER.platform | LAYER.terrain);
    if (!hit) return;
    this.tetherPoint.set(o.x + d.x * hit.t, o.y + d.y * hit.t, o.z + d.z * hit.t);
    const dist = Math.hypot(this.tetherPoint.x - p.x, this.tetherPoint.y - p.y, this.tetherPoint.z - p.z);
    const isTerrain = !!(hit.collider.collisionGroups() >>> 16 & LAYER.terrain);
    if (dist > TETHER_RANGE || dist < 4) return;
    if (isTerrain && this.tetherPoint.y < p.y + 3.5) return;
    this.tetherAim = { point: this.tetherPoint, anchor: null, label: '[T] Tether' };
  }

  private tryTether() {
    const p = this.player;
    if (p.tetherCD > 0) return;
    if (!this.tetherAim) {
      this.ui.toast('No anchor in reach');
      return;
    }
    if (p.res < 6 && p.fiber < 6) {
      this.ui.toast('Not enough Resonance to tether');
      return;
    }
    if (!p.spendFuel(6)) return;
    p.fireTether(this, this.tetherAim.point, this.tetherAim.anchor);
    this.stats.dashes++;
  }

  /** Hold X for the traversal wheel (slow-motion), tap X to cycle Walk → Levitate → Flight. */
  private updateWheel(dt: number, dead: boolean) {
    const inp = this.input;
    const p = this.player;
    if (dead || this.ui.anyOverlay()) {
      if (this.trav.isOpen) this.trav.close();
      this.wheelHold = 0;
      return;
    }
    const down = inp.isDown('KeyX');
    if (down) {
      this.wheelHold += dt;
      if (!this.trav.isOpen && this.wheelHold > 0.16) {
        this.trav.setAvailable({ walk: true, levitate: p.fuel >= 5, flight: p.fuel >= 10, tether: !!this.tetherAim || p.tether.active });
        this.trav.open(p.travMode);
        this.audio.sfx('ready', 1.4);
      }
      if (this.trav.isOpen) {
        const mv = inp.moveVector(this.mv);
        if (mv.lengthSq() > 0.2) this.trav.steer(mv.x * 6, mv.y * 6);
      }
      return;
    }
    if (this.trav.isOpen) {
      const m = this.trav.close();
      this.wheelHold = 0;
      if (m) this.applyTravMode(m);
      return;
    }
    if (inp.wasPressed('KeyX')) this.applyTravMode(TraversalUI.cycle(p.travMode));
    this.wheelHold = 0;
  }

  private applyTravMode(m: TravMode) {
    const p = this.player;
    if (m === p.travMode) return;
    if (m === 'tether') {
      this.tryTether();
      return;
    }
    const why = p.requestMode(this, m);
    if (why) this.ui.toast(why);
  }

  shake(a: number) {
    this.cam.addShake(a);
  }

  // ---------------------------------------------------------------- boss hooks

  bossAwake(e: Enemy) {
    this.boss = e;
    if (e.variant === 'construct') {
      this.ui.say(['Elder Gaia: "The Construct! Its shell drinks from the data-river pylons — break them and its core will open."', 'THE VOID-INFUSED CONSTRUCT · Destroy the Data-River Pylons']);
      return;
    }
    if (this.run.nullPoints >= NULL_ENDING_THRESHOLD) this.ui.say(LORE_BARKS.nullEmbraced);
    else this.ui.say(['…you came back.', 'I am the end of every sentence. Let me finish yours.']);
  }
  bossPhase(e: Enemy, phase: number) {
    if (e.variant === 'construct') {
      this.ui.say(phase === 2 ? 'The Construct tears new pylons out of the bedrock.' : 'Its crown burns white. The Construct stops guarding and starts hunting.');
      if (this.veil) this.raisePylons(e, phase + 1);
      return;
    }
    this.ui.say(phase === 2 ? LORE_BARKS.nullPhase2 : LORE_BARKS.nullPhase3);
  }
  bossDefeated(e: Enemy) {
    this.bossDown = true;
    this.punch('boss', e.variant === 'construct' ? 'The Void-Infused Construct kneels' : 'The Null Warden falls');
    if (e.variant === 'construct') {
      this.constructDefeated(e);
      return;
    }
    const pos = new THREE.Vector3(e.x, e.y, e.z);
    this.particles.burst(pos, HOT.clone().multiplyScalar(3.5), 160, 28, 1.2, 1.8);
    this.particles.ring(pos, new THREE.Color(0xe8f4ff).multiplyScalar(3), 90, 34, 1, 1.6);
    this.particles.ring(pos, HOT.clone().multiplyScalar(3), 70, 22, 0.9, 1.6);
    this.audio.sfx('bossdie');
    this.shake(1.6);
    this.enemyTimeScale = 0.2;
    this.projectiles.clearEnemyBolts();
    for (const o of this.enemies) if (o !== e && !o.dead) this.combat.killEnemy(o);
    this.pending = [];
    this.ui.say([...LORE_BARKS.nullDeath, this.def.gateText]);
    const gate = this.world.gate;
    if (gate) {
      gate.group.visible = true;
      gate.setOpen(true);
    }
    this.world.mycelium.seed(e.x, e.z, 24, 0, 100);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.plantEcho(Math.cos(a) * 14, Math.sin(a) * 14, 'node');
    }
    this.dropLoot(e.x, e.z, 'boss');
    this.audio.sfx('gate');
  }

  // ---------------------------------------------------------------- echoes

  private tryPlant() {
    const p = this.player;
    if (this.mode !== 'play') return;
    if (p.res < 25) {
      this.ui.toast('Planting an echo-tree costs 25 Resonance.');
      return;
    }
    if (this.nearEcho(p.x, p.z, 2.5)) {
      this.ui.toast('An echo already grows here.');
      return;
    }
    if (this.plantEcho(p.x, p.z, 'manual')) p.res -= 25;
  }

  private nearEcho(x: number, z: number, d: number) {
    return this.world.grove.echoes.some((e) => !e.sentinel && (e.x - x) ** 2 + (e.z - z) ** 2 < d * d);
  }

  /** Where the player acted, the world answers with a tree. */
  plantEcho(x: number, z: number, source: 'dash' | 'kill' | 'node' | 'manual'): boolean {
    if (this.stratumEchoes >= 120 || this.nearEcho(x, z, source === 'manual' ? 2.5 : 4)) return false;
    if (this.world.terrain.riverAt(x, z) > 0.5) return false;
    const tiers = this.run.tiers;
    const owned = (['root', 'echo', 'flow'] as Affinity[]).filter((a) => tiers[a] > 0);
    const aff: Affinity = owned.length ? owned[Math.floor(Math.random() * owned.length)] : (['root', 'echo', 'flow'] as Affinity[])[Math.floor(Math.random() * 3)];
    const echo = this.world.grove.plant(x, z, aff);
    if (!echo) return false;
    this.stratumEchoes++;
    this.run.echoes.push({ x, z, affinity: aff, stratum: this.def.id, radius: this.world.radius });
    if (this.run.echoes.length > 400) this.run.echoes.shift();
    const near = this.world.mycelium.nearestAnchor(x, z, 34);
    if (near) this.world.mycelium.connect(near, { x, z });
    else this.world.mycelium.addAnchor(x, z);
    this.world.mycelium.addTarget(x, z);
    this.particles.burst(new THREE.Vector3(x, echo.y + 0.5, z), new THREE.Color(AFFINITY_COLOR[aff]).multiplyScalar(2.5), 12, 5, 0.5, 0.7);
    if (source === 'manual' || source === 'node') this.audio.sfx('plant');
    if (this.firstEcho) {
      this.firstEcho = false;
      this.ui.toast('An echo-tree takes root where the story happened.');
    }
    return true;
  }

  // ---------------------------------------------------------------- interaction & objectives

  private gateOpen() {
    const g = this.world.gate;
    return !!g && g.group.visible && g.wantOpen;
  }

  private interactTarget(): { kind: 'node' | 'origin' | 'gate' | 'pylon' | 'cache' | 'locked'; ref?: unknown; label: string } | null {
    if (this.mode !== 'play' || this.encounter) return null;
    const p = this.player;
    const key = this.input.lastDevice === 'touch' ? 'Tap E' : 'E';
    let best: { d: number; v: { kind: 'node' | 'origin' | 'gate' | 'pylon' | 'cache' | 'locked'; ref?: unknown; label: string } } | null = null;
    const consider = (d: number, v: NonNullable<typeof best>['v']) => {
      if (!best || d < best.d) best = { d, v };
    };
    for (const n of this.world.nodes) {
      if (n.state !== 'dormant') continue;
      const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
      if (d > 7 || Math.abs(n.pos.y + 1 - p.y) > 14) continue;
      if (this.def.id === 'return') consider(d, { kind: 'origin', ref: n, label: `<kbd>[${key}]</kbd> Carry the story home` });
      else if (!this.campCleared(n.index)) consider(d, { kind: 'locked', label: 'The Null guards this Remembrance' });
      else consider(d, { kind: 'node', ref: n, label: this.def.contacts ? `<kbd>[${key}]</kbd> Link ${this.def.nodeLabel}` : `<kbd>[${key}]</kbd> Interact with ${this.def.nodeLabel}` });
    }
    for (const py of this.world.pylons) {
      if (py.state !== 'dormant') continue;
      const d = Math.hypot(py.pos.x - p.x, py.pos.z - p.z);
      if (d < 8) consider(d, { kind: 'pylon', ref: py, label: `<kbd>[${key}]</kbd> Initialize Purge` });
    }
    for (const c of this.world.caches) {
      if (c.opened) continue;
      const d = Math.hypot(c.pos.x - p.x, c.pos.z - p.z);
      if (d < 4) consider(d, { kind: 'cache', ref: c, label: `<kbd>[${key}]</kbd> Open Spore Cache` });
    }
    const g = this.world.gate;
    if (g && this.gateOpen() && g.open > 0.7) {
      const d = Math.hypot(g.pos.x - p.x, g.pos.z - p.z);
      if (d < 9) consider(d, { kind: 'gate', label: `<kbd>[${key}]</kbd> Enter the Threshold` });
    }
    return best ? (best as { v: ReturnType<Game['interactTarget']> }).v : null;
  }

  private tryInteract() {
    const t = this.interactTarget();
    if (!t || t.kind === 'locked') return;
    if (t.kind === 'node') this.startEncounter(t.ref as MemoryNode, 'node');
    else if (t.kind === 'pylon') this.startEncounter(t.ref as Pylon, 'pylon');
    else if (t.kind === 'cache') this.openCache(t.ref as { pos: THREE.Vector3; open(): void });
    else if (t.kind === 'origin') this.finishGame();
    else if (t.kind === 'gate') this.enterGate();
  }

  private openCache(c: { pos: THREE.Vector3; open(): void }) {
    c.open();
    this.audio.sfx('node');
    this.particles.burst(new THREE.Vector3(c.pos.x, c.pos.y + 1.4, c.pos.z), new THREE.Color(0xffc14a).multiplyScalar(3), 40, 9, 0.6, 0.9);
    this.dropLoot(c.pos.x, c.pos.z, 'cache');
    if (Math.random() < 0.5) this.dropLoot(c.pos.x, c.pos.z, 'kill');
    this.pickups.drop(c.pos.x, c.pos.z, 'res');
    this.pickups.drop(c.pos.x, c.pos.z, 'heal');
    this.gainXp(30);
    this.player.res = Math.min(this.derived.maxRes, this.player.res + 25);
  }

  private startEncounter(anchor: MemoryNode | Pylon, kind: 'node' | 'pylon') {
    anchor.setState('active');
    const purgeMul = clamp(this.director.out.directives.pylonPurgeDifficulty / 1.27, 0.75, 1.35);
    this.encounter = { enc: new Encounter(anchor as Anchor, kind, this.def.index, this.diff, purgeMul), anchor, kind };
    this.director.stimulate(anchor.pos.x, anchor.pos.z, this.world.radius, 1.5);
    this.audio.sfx('node');
    this.shake(0.5);
    this.particles.ring(new THREE.Vector3(anchor.pos.x, anchor.pos.y + 1, anchor.pos.z), this.palette.accent2HDR, 50, 16, 0.6, 0.9);
    this.world.mycelium.seed(anchor.pos.x, anchor.pos.z, 10, 0, 80);
    this.ui.say(kind === 'pylon' ? 'The Pylon wakes — hold its ring while the purge charges.' : this.def.id === 'seedbed' ? 'It stirs. The Static smells it — hold the ring.' : 'The node sings. Stay inside the ring while the song builds.');
  }

  private finishEncounter() {
    const e = this.encounter!;
    this.encounter = null;
    if (e.kind === 'pylon') this.completePylon(e.anchor as Pylon);
    else this.completeNode(e.anchor as MemoryNode);
  }

  private completePylon(py: Pylon) {
    py.setState('done');
    const p = this.player;
    this.audio.sfx('gate');
    this.shake(0.6);
    const pos = new THREE.Vector3(py.pos.x, py.pos.y + 6, py.pos.z);
    this.particles.burst(pos, this.palette.accentHDR, 80, 14, 0.8, 1.2);
    this.particles.ring(pos, this.palette.accentHDR, 60, 22, 0.7, 1.2);
    this.world.checkpoint.copy(py.pos).add(new THREE.Vector3(5, 0, 0));
    this.world.mycelium.connect({ x: this.world.startPos.x, z: this.world.startPos.z }, { x: py.pos.x, z: py.pos.z });
    this.dropLoot(py.pos.x + 4, py.pos.z, 'pylon');
    this.dropCrystals(py.pos.x, py.pos.z, 5);
    // the purge wave stuns every Fiend and Drone in range (blueprint: pylon purge stun)
    purgeStun(this, py.pos.x, py.pos.z, 30);
    this.director.stimulate(py.pos.x, py.pos.z, this.world.radius, 2);
    p.hp = this.derived.maxHp;
    p.res = this.derived.maxRes;
    this.gainXp(100);
    this.ui.toast('Pylon purged — fast travel unlocked [M]');
    this.punch('pylon', `Pylon purged in ${this.def.name}`);
  }

  private completeNode(node: MemoryNode) {
    node.setState('done');
    this.audio.sfx('node');
    this.shake(0.6);
    const pos = new THREE.Vector3(node.pos.x, node.pos.y + 3, node.pos.z);
    this.particles.burst(pos, this.palette.accentHDR, 70, 14, 0.8, 1.2);
    this.particles.ring(pos, this.palette.accentHDR, 60, 22, 0.7, 1.2);
    const done = this.world.nodes.filter((n) => n.state === 'done');
    const prev = done.length > 1 ? done[done.length - 2] : null;
    this.world.mycelium.connect(prev ? { x: prev.pos.x, z: prev.pos.z } : { x: this.world.startPos.x, z: this.world.startPos.z }, { x: node.pos.x, z: node.pos.z });
    this.world.mycelium.seed(node.pos.x, node.pos.z, 12, 0, 90);
    this.world.checkpoint.copy(node.pos).add(new THREE.Vector3(6, 0, 0));
    if (this.def.contacts) {
      this.linkContact(node);
      return;
    }
    const frag = this.def.fragments[node.index];
    if (frag) this.ui.say(frag);
    this.gainXp(120);
    this.run.maxHp += 10;
    this.refreshDerived();
    this.player.hp = this.derived.maxHp;
    this.player.res = Math.min(this.derived.maxRes, this.player.res + 50);

    // the Remembrance asks something of you
    this.mode = 'choice';
    this.releaseLockQuiet();
    const n = this.run.remembrances.length;
    this.ui.binaryChoice(
      {
        title: `${this.def.nodeLabel} ${n + 1} of ${TOTAL_REMEMBRANCES} · ${this.def.name}`,
        embrace: 'Let the Null speak through it. +10% damage, +1 skill point and a legendary-grade cache — but −6 max life, and the Static grows bolder.',
        purify: 'Cleanse its silence. Fully restore life, +10 max life, a verdant echo-grove blooms, and your Purity deepens.',
        history: this.run.remembrances,
        total: TOTAL_REMEMBRANCES,
      },
      (c) => this.applyRemembrance(c, node),
    );
  }

  private applyRemembrance(c: Remembrance, node: MemoryNode) {
    const p = this.player;
    this.run.remembrances.push(c);
    const nth = `Remembrance ${this.run.remembrances.length} of ${TOTAL_REMEMBRANCES}`;
    this.punch('remembrance', c === 'purify' ? `${nth} purified` : `${nth} embraced — the Null spoke through it`);
    if (c === 'purify') this.telemetry.purify++;
    else this.telemetry.embrace++;
    const pos = new THREE.Vector3(node.pos.x, node.pos.y + 3, node.pos.z);
    if (c === 'purify') {
      this.run.purityPoints++;
      this.stratumPurified++;
      this.run.maxHp += 10;
      this.refreshDerived();
      p.hp = this.derived.maxHp;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.random();
        this.plantEcho(node.pos.x + Math.cos(a) * 8, node.pos.z + Math.sin(a) * 8, 'node');
      }
      this.particles.ring(pos, new THREE.Color(0x4fb4ff).multiplyScalar(3), 70, 22, 0.8, 1.2);
      this.audio.sfx('choice');
      this.ui.toast('Purified — the silence blooms.');
    } else {
      this.run.nullPoints++;
      this.stratumEmbraced++;
      this.run.skillPoints++;
      this.refreshDerived();
      p.hp = Math.min(p.hp, this.derived.maxHp);
      this.dropLoot(node.pos.x + 3, node.pos.z, 'embrace');
      this.particles.ring(pos, HOT.clone().multiplyScalar(3), 70, 22, 0.8, 1.2);
      this.audio.sfx('boss');
      this.shake(0.8);
      this.ui.toast(`The Null is in you · Null influence ${this.run.nullPoints} · skill point gained`);
      if (this.run.nullPoints === NULL_ENDING_THRESHOLD) this.ui.say('Something in the quiet has begun to wear your face.');
    }
    this.mode = 'play';
    this.input.requestLock();
    const all = this.world.nodes.every((n) => n.state === 'done');
    if (all && this.world.gate) {
      this.world.gate.setOpen(true);
      this.world.mycelium.connect({ x: node.pos.x, z: node.pos.z }, { x: this.world.gate.pos.x, z: this.world.gate.pos.z });
      this.audio.sfx('gate');
      this.ui.say(this.def.gateText);
    }
    this.saveRun();
  }

  private enterGate() {
    this.audio.sfx('click');
    const choice = this.def.choice;
    if (!choice) {
      this.exitStratum(null);
      return;
    }
    this.mode = 'choice';
    this.releaseLockQuiet();
    if (this.def.id === 'seedbed') this.ui.say('Three ways to listen.');
    this.ui.choice(choice, this.run.tiers, (c) => this.applyChoice(c));
  }

  private applyChoice(c: Choice) {
    this.run.tiers[c.affinity] = Math.min(3, this.run.tiers[c.affinity] + 1);
    this.audio.sfx('choice');
    const tier = this.run.tiers[c.affinity];
    this.punch('choice', `Chose “${c.title}” — ${AFFINITY_META[c.affinity].name} ${'I'.repeat(tier)}`);
    this.ui.toast(`${AFFINITY_META[c.affinity].name} ${'I'.repeat(tier)} — ${PERKS[c.affinity][tier - 1]}`);
    this.exitStratum(c);
  }

  private finishGame() {
    if (this.mode !== 'play') return;
    this.mode = 'ending';
    this.releaseLockQuiet();
    this.endingStart = performance.now();
    this.ui.setHudVisible(false);
    this.ui.clearSay();
    const n = this.world.nodes[0];
    n.setState('done');
    this.audio.sfx('gate');
    this.audio.sfx('node');
    this.particles.burst(new THREE.Vector3(n.pos.x, n.pos.y + 4, n.pos.z), new THREE.Color(0xffd36b).multiplyScalar(3), 120, 22, 0.9, 2);
    this.world.mycelium.seed(0, 0, 30, 0, 140);
    this.ui.fade(true, 'white', 3200);
    this.run.history.push({
      stratum: this.def.id,
      stratumName: this.def.name,
      kills: this.stratumKills,
      echoes: this.stratumEchoes,
      deaths: this.stratumDeaths,
      time: this.stats.time,
    });
    this.story = composeStory(this.run);
    this.punch('ending', `Cycle ${this.run.cycle} complete — ${this.story.title}`);
    const lib = this.library();
    lib.push(toLibraryEntry(this.run, this.story));
    store.set(LIB_KEY, lib.slice(-30));
    this.deck.push(buildStorycard(this.run));
    store.del(SAVE_KEY);
  }

  // ---------------------------------------------------------------- tutorial & HUD

  private updateTutorial() {
    if (this.def.id !== 'seedbed' || this.run.cycle > 1 || this.tutorial >= 4) return;
    const s = this.stats;
    if (this.tutorial === 0 && s.distance > 10) this.tutorial = 1;
    if (this.tutorial === 1 && s.shots >= 6) this.tutorial = 2;
    if (this.tutorial === 2 && (s.dashes >= 1 || this.player.mode === 'flight')) this.tutorial = 3;
    if (this.tutorial === 3 && (this.encounter || this.camps.some((c) => c.cleared))) this.tutorial = 4;
  }

  private hintText(): string | null {
    if (this.def.id !== 'seedbed' || this.run.cycle > 1 || this.tutorial >= 4 || this.mode !== 'play') return null;
    const touch = this.input.lastDevice === 'touch';
    switch (this.tutorial) {
      case 0:
        return touch ? 'Left stick — move · drag the right side to look' : '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> — move · mouse — look';
      case 1:
        return touch ? 'ATTACK — Root-Blade · AIM — spore bolts' : '<kbd>LMB</kbd> — Root-Blade combo · hold <kbd>RMB</kbd> — aim &amp; fire';
      case 2:
        return touch ? 'DASH · JUMP · FLY' : '<kbd>Shift</kbd> — dash · <kbd>Space</kbd> — jump · <kbd>V</kbd> — free flight';
      default:
        return 'Purge the Null-infested clearing at the center, then wake the First Seed';
    }
  }

  private nextNode(): MemoryNode | null {
    return this.world.nodes.find((n) => n.state !== 'done') ?? null;
  }

  objectivePoint(): { x: number; z: number } | null {
    if (this.def.boss || (this.def.contacts && this.boss)) return this.boss && !this.boss.dead ? this.veil && this.boss.armored ? this.nearestPylon() : { x: this.boss.x, z: this.boss.z } : this.bossDown && this.world.gate ? { x: this.world.gate.pos.x, z: this.world.gate.pos.z } : null;
    const n = this.nextNode();
    if (n) {
      const camp = this.camps.find((c) => c.spec.nodeIndex === n.index);
      return camp && !camp.cleared ? { x: camp.spec.x, z: camp.spec.z } : { x: n.pos.x, z: n.pos.z };
    }
    if (this.gateOpen() && this.world.gate) return { x: this.world.gate.pos.x, z: this.world.gate.pos.z };
    return null;
  }

  private nearestPylon() {
    const p = this.player;
    let best: Enemy | null = null;
    for (const e of this.veil?.pylons ?? []) if (!e.dead && (!best || Math.hypot(e.x - p.x, e.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z))) best = e;
    return best ? { x: best.x, z: best.z } : this.boss ? { x: this.boss.x, z: this.boss.z } : null;
  }

  private markers(): MarkerSet {
    const w = this.world;
    return {
      nodes: w.nodes.map((n) => ({ x: n.pos.x, z: n.pos.z, state: n.state })),
      pylons: w.pylons.map((n) => ({ x: n.pos.x, z: n.pos.z, state: n.state })),
      caches: w.caches.map((c) => ({ x: c.pos.x, z: c.pos.z, opened: c.opened })),
      camps: this.camps.map((c) => ({ x: c.spec.x, z: c.spec.z, cleared: c.cleared })),
      gate: w.gate && w.gate.group.visible ? { x: w.gate.pos.x, z: w.gate.pos.z, open: w.gate.open } : null,
      echoes: w.grove.echoes.filter((e) => !e.sentinel).map((e) => ({ x: e.x, z: e.z })),
      enemies: this.enemies.filter((e) => !e.dead && e.spawnT >= 1).map((e) => ({ x: e.x, z: e.z, boss: e.kind === 'boss' })),
    };
  }

  private drawHud() {
    const p = this.player;
    const w = this.world;
    const D = this.derived;
    const done = w.nodes.filter((n) => n.state === 'done').length;
    const total = w.nodes.length;
    const t = this.interactTarget();
    let objective = this.def.objective;
    let target: string | null = null;
    if (this.def.boss) {
      objective = this.bossDown ? 'Enter the Threshold' : this.boss?.activated ? 'Answer the Null Warden' : 'Approach the Hollow Mirror';
    } else if (this.def.contacts && (this.boss || this.bossDown)) {
      const v = this.veil;
      objective = this.bossDown ? 'Enter the Threshold' : !this.boss?.activated ? 'Reach the Central Pylon' : v && v.breach > 0 ? `Strike the exposed core (${Math.ceil(v.breach)}s)` : `Destroy the Data-River Pylons (${v ? v.pylons.filter((e) => !e.dead).length : 0} left)`;
      target = this.bossDown ? null : 'The Void-Infused Construct';
    } else if (this.def.id !== 'return' && total > 0) {
      if (done === total) objective = this.def.contacts ? 'Reach the Central Pylon' : 'Enter the Threshold';
      else {
        objective = total > 1 ? `${this.def.objective} (${done}/${total})` : this.def.objective;
        const n = this.nextNode()!;
        const camp = this.camps.find((c) => c.spec.nodeIndex === n.index);
        target = camp && !camp.cleared ? camp.spec.name : this.def.nodeLabel;
      }
    } else if (this.def.id === 'return') target = this.def.nodeLabel;

    let progress: HudState['progress'] = null;
    let hint = this.hintText();
    if (this.encounter) {
      const enc = this.encounter.enc;
      progress = {
        label: enc.phase === 'cleanup' ? 'Purge the last Static' : enc.inside ? (this.encounter.kind === 'pylon' ? 'Purging…' : 'Resonating…') : 'Return to the ring!',
        v: enc.phase === 'cleanup' ? 1 : enc.fraction,
      };
      if (!enc.inside && enc.phase === 'running') hint = 'Return to the ring — the song only grows while you stand in it';
    }
    const cm = this.combat;
    const s: HudState = {
      hp: p.hp,
      maxHp: D.maxHp,
      shield: p.shield,
      shieldMax: cm.shieldMax,
      res: p.res,
      maxRes: D.maxRes,
      level: this.run.level,
      xp: this.run.xp,
      xpNext: xpToNext(this.run.level),
      abil: { dash: clamp(1 - p.dashCD / ((this.run.tiers.flow >= 1 ? 0.6 : 1) * D.dashCdMul), 0, 1), spike: cm.ready('spike'), shield: cm.ready('shield'), surge: cm.ready('surge') },
      afford: { spike: p.res >= COST.spike, shield: p.res >= COST.shield, surge: p.res >= COST.surge },
      tiers: this.run.tiers,
      act: this.def.act,
      objective,
      target,
      progress,
      boss: this.boss && this.boss.activated && !this.boss.dead ? this.boss.hp / this.boss.maxHp : null,
      bossName: this.boss ? enemyName(this.boss) : undefined,
      crystals: this.run.crystals ?? 0,
      missions: this.activeMissions().map((m) => ({ text: missionLine(m), done: m.state === 'done' })),
      prompt: t ? t.label : null,
      hint,
      aiming: p.aiming,
      onEnemy: !!this.aim.enemy,
      flying: p.mode === 'flight',
      lockNeeded: this.input.lockWanted && this.input.lastDevice === 'mouse' && !this.input.locked && this.mode === 'play' && !this.paused,
    };
    this.ui.updateHud(s);
    const m = this.markers();
    this.ui.drawMinimap({
      ...m,
      extent: w.mapExtent,
      raster: w.mapCanvas,
      player: { x: p.x, z: p.z, yaw: this.cam.yaw },
      accent: '#' + new THREE.Color(w.palette.accent).getHexString(),
      objective: this.objectivePoint(),
    });
    this.ui.drawCompass(this.cam.yaw, { x: p.x, z: p.z }, m.enemies, this.objectivePoint());
  }

  // ---------------------------------------------------------------- inventory & map

  private openInventory() {
    this.ui.openInventory(
      this.run,
      () => this.derived,
      {
        equip: (item) => {
          const old = this.run.equipped[item.slot];
          this.run.inventory = this.run.inventory.filter((i) => i.id !== item.id);
          if (old) this.run.inventory.push(old);
          this.run.equipped[item.slot] = item;
          this.refreshDerived();
          this.audio.sfx('pickup');
        },
        unequip: (slot) => {
          const it = this.run.equipped[slot];
          if (it) {
            this.run.inventory.push(it);
            delete this.run.equipped[slot];
            this.refreshDerived();
          }
        },
        infuse: (item) => {
          const cost = infuseCost(item);
          if ((this.run.crystals ?? 0) < cost) {
            this.ui.toast(`Infusing needs ${cost} Void Crystals`);
            return;
          }
          this.run.crystals = (this.run.crystals ?? 0) - cost;
          infuse(item);
          this.refreshDerived();
          this.audio.sfx('choice');
          this.ui.toast(`${item.name} infused · Lv ${item.level}`);
        },
        dismantle: (item) => {
          this.run.inventory = this.run.inventory.filter((i) => i.id !== item.id);
          this.gainXp(12 * (RARITY_ORDER_INDEX[item.rarity] + 1));
          this.audio.sfx('click');
        },
        rank: (id) => {
          if (rankUp(this.run, id)) {
            this.refreshDerived();
            this.audio.sfx('choice');
          }
        },
        skin: (s: Skin) => {
          if (skinUnlocked(this.run, s)) {
            this.run.skin = s;
            this.refreshDerived();
            this.audio.sfx('plant');
          }
        },
      },
    );
  }

  private openMap() {
    const w = this.world;
    const p = this.player;
    const data: MapData = {
      ...this.markers(),
      extent: w.mapExtent,
      raster: w.mapCanvas,
      player: { x: p.x, z: p.z, yaw: this.cam.yaw },
      accent: '#' + new THREE.Color(w.palette.accent).getHexString(),
      objective: this.objectivePoint(),
    };
    this.ui.openMap(this.def.name, data, (x, z) => this.mapClick(x, z));
  }

  mapClick(x: number, z: number) {
    let best: Pylon | null = null;
    let bd = 22 * 22;
    for (const py of this.world.pylons) {
      const d = (py.pos.x - x) ** 2 + (py.pos.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = py;
      }
    }
    if (best) this.fastTravel(best);
  }

  private fastTravel(py: Pylon) {
    if (py.state !== 'done') {
      this.ui.toast('Purge this Pylon to unlock fast travel');
      return;
    }
    if (this.travelBusy) return;
    if (this.enemies.some((e) => !e.dead && !e.idle && e.kind !== 'pylon' && e.spawnT >= 1 && Math.hypot(e.x - this.player.x, e.z - this.player.z) < 32)) {
      this.ui.toast('Cannot travel while hunted');
      return;
    }
    this.travelBusy = true;
    this.ui.hide('map');
    this.ui.fade(true, 'white', 250);
    window.setTimeout(() => {
      const w = this.world;
      const x = py.pos.x + 5;
      const z = py.pos.z;
      this.player.place(x, w.terrain.heightAt(x, z), z);
      w.prime(x, z);
      this.cam.snap(this.player.cameraTarget);
      this.ui.fade(false, 'white', 500);
      this.travelBusy = false;
      this.audio.sfx('gate');
      this.paused = false;
      this.input.requestLock();
    }, 280);
  }

  // ---------------------------------------------------------------- debug (enabled with ?debug)

  /** Dev screenshots: pin the render camera (null hands it back to the follow camera). */
  debugPhoto: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  debugGoto(index: number) {
    this.ui.hideAll();
    this.audio.init();
    if (this.mode === 'title') this.newRun(1);
    this.enterStratum(index, true);
  }
  debugCompleteNodes() {
    for (const n of this.world.nodes) {
      if (n.state !== 'done') {
        const c = this.camps.find((x) => x.spec.nodeIndex === n.index);
        if (c && !c.cleared) {
          for (const e of c.enemies) if (!e.dead) this.combat.killEnemy(e);
        }
        n.setState('dormant');
        this.completeNode(n);
        if (!this.def.contacts) this.ui.binaryKey(Math.random() < 0.5 ? 'purify' : 'embrace');
      }
    }
  }
  debugKillBoss() {
    if (this.boss) {
      this.boss.activated = true;
      this.boss.invuln = 0;
      this.combat.damageEnemy(this.boss, 99999, 1, 0, {});
    }
  }
  debugState() {
    return {
      mode: this.mode,
      stratum: this.def.id,
      hp: this.player.hp,
      res: this.player.res,
      enemies: this.enemies.length,
      kills: this.run.kills,
      echoes: this.run.echoes.length,
      tiers: this.run.tiers,
      nodes: this.world.nodes.map((n) => n.state),
      gateOpen: this.gateOpen(),
      fps: Math.round(this.gfx.fps),
      encounter: this.encounter ? this.encounter.enc.fraction : null,
      level: this.run.level,
      camps: this.camps.map((c) => c.cleared),
      playerMode: this.player.mode,
      trav: this.player.travMode,
      fiber: Math.round(this.player.fiber),
      grounded: this.player.grounded,
      groundY: +this.player.groundY.toFixed(2),
      chunks: this.world.physics.terrainChunks,
      pods: this.world.props.podCount,
      crystals: this.world.props.crystalCount,
      debris: this.world.props.debris.live,
      caps: this.world.mushrooms.caps.length,
      anchors: this.world.tetherAnchors.length,
      pos: [this.player.x, this.player.y, this.player.z],
      nullPoints: this.run.nullPoints,
      enemyNames: this.enemies.map((e) => ENEMY_NAME[e.kind]),
      director: { phase: this.director.phase, threat: +this.director.out.threat.toFixed(2), extractions: this.director.pool.extractions, glow: +Number(floraGlow.value).toFixed(2) },
      crystalsHeld: this.run.crystals ?? 0,
      telemetry: this.telemetry,
      veil: this.world.veil ? { tree: [this.world.veil.tree.x, this.world.veil.tree.z], pylons: this.veil?.pylons.filter((e) => !e.dead).length ?? null, breach: this.veil?.breach ?? null, armored: this.boss?.armored ?? null, boss: this.boss ? [this.boss.x, this.boss.z] : null } : null,
    };
  }
  /** Headless simulation: advance the game n ticks without rendering (used by the test bot). */
  debugStep(n: number, dt = 1 / 30) {
    for (let i = 0; i < n; i++) {
      this.gfx.camera.updateMatrixWorld();
      this.handleGlobalKeys();
      this.tick(dt);
      this.input.endFrame();
    }
  }
  debugAt(x: number, z: number) {
    this.player.place(x, this.world.terrain.heightAt(x, z), z);
    this.world.prime(x, z);
    this.cam.snap(this.player.cameraTarget);
  }
  debugClearCamps() {
    for (const c of this.camps) for (const e of c.enemies) if (!e.dead) this.combat.killEnemy(e);
  }
  get debugCamps() {
    return this.camps;
  }
}

const RARITY_ORDER_INDEX: Record<string, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
