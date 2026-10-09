import type { Affinity, Choice, ChoiceSet, Item, LibraryEntry, Remembrance, RunState, Skin, Slot } from '../types';
import { AFFINITY_META, PERKS, type ComposedStory } from '../story/story';
import { STRATA } from '../story/strata';
import { fmtTime } from '../util/math';
import {
  RARITY, SKILLS, SKINS, SLOTS, SLOT_LABEL, STAT_LABEL, canRank, fmtStat, skinUnlocked, type Derived,
} from '../systems/progress';
import { renderPortrait } from './portrait';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface HudState {
  hp: number;
  maxHp: number;
  shield: number;
  shieldMax: number;
  res: number;
  maxRes: number;
  level: number;
  xp: number;
  xpNext: number;
  abil: { dash: number; spike: number; shield: number; surge: number };
  afford: { spike: boolean; shield: boolean; surge: boolean };
  tiers: Record<Affinity, number>;
  act: string;
  objective: string;
  target: string | null;
  progress: { label: string; v: number } | null;
  boss: number | null;
  prompt: string | null;
  hint: string | null;
  aiming: boolean;
  onEnemy: boolean;
  flying: boolean;
  lockNeeded: boolean;
}

export interface MarkerSet {
  nodes: { x: number; z: number; state: string }[];
  pylons: { x: number; z: number; state: string }[];
  caches: { x: number; z: number; opened: boolean }[];
  camps: { x: number; z: number; cleared: boolean }[];
  gate: { x: number; z: number; open: number } | null;
  echoes: { x: number; z: number }[];
  enemies: { x: number; z: number; boss: boolean }[];
}

export interface MapData extends MarkerSet {
  extent: number;
  raster: HTMLCanvasElement;
  player: { x: number; z: number; yaw: number };
  accent: string;
  objective: { x: number; z: number } | null;
}

export interface InvHandlers {
  equip(item: Item): void;
  unequip(slot: Slot): void;
  dismantle(item: Item): void;
  rank(id: string): void;
  skin(s: Skin): void;
}

type OverlayId =
  | 'title' | 'prologue' | 'choice' | 'binary' | 'timeline' | 'controls' | 'library' | 'pause' | 'death' | 'ending' | 'inventory' | 'map';
const ALL: OverlayId[] = ['title', 'prologue', 'choice', 'binary', 'timeline', 'controls', 'library', 'pause', 'death', 'ending', 'inventory', 'map'];

const SLOT_ICON: Record<Slot, string> = { helm: '◭', armor: '⬡', boots: '◢', blade: '⟋', modulator: '❂', core: '◈' };

export class UI {
  private sayQueue: string[] = [];
  private sayBusy = false;
  private sayTimers: number[] = [];
  private lastHud = '';
  private mini = $<HTMLCanvasElement>('minimap').getContext('2d')!;
  private comp = $<HTMLCanvasElement>('compass').getContext('2d')!;
  private choiceKeyHandler?: (i: number) => void;
  private binaryHandler?: (c: Remembrance) => void;
  private dmgCount = 0;
  private reticle = $('reticle');
  private lastKeyHints = '';
  // inventory state
  private inv?: { run: RunState; derived: () => Derived; h: InvHandlers; tab: string; sel?: Item };
  private mapClick?: (x: number, z: number) => void;

  isOpen(id: OverlayId) {
    return !$(id).classList.contains('hidden');
  }
  anyOverlay() {
    return ALL.some((o) => this.isOpen(o));
  }
  private syncOverlayClass() {
    document.body.classList.toggle('ov', ALL.some((o) => o !== 'prologue' && this.isOpen(o)));
  }
  show(id: OverlayId) {
    $(id).classList.remove('hidden');
    this.syncOverlayClass();
  }
  hide(id: OverlayId) {
    $(id).classList.add('hidden');
    this.syncOverlayClass();
  }
  hideAll() {
    ALL.forEach((o) => this.hide(o));
  }

  bindClose(onClose: (id: OverlayId) => void) {
    document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => {
      b.addEventListener('click', () => {
        const ov = b.closest('.overlay') as HTMLElement;
        onClose(ov.id as OverlayId);
      });
    });
  }

  on(id: string, fn: () => void) {
    $(id).addEventListener('click', fn);
  }

  // ---- HUD ------------------------------------------------------------------
  setHudVisible(v: boolean) {
    $('hud').classList.toggle('hidden', !v);
  }

  updateHud(s: HudState) {
    this.reticle.classList.toggle('aim', s.aiming);
    this.reticle.classList.toggle('enemy', s.onEnemy);
    const key = JSON.stringify([
      Math.round(s.hp), s.maxHp, Math.round(s.shield), s.shieldMax, Math.round(s.res), s.maxRes, s.level, Math.round(s.xp), s.xpNext,
      Object.values(s.abil).map((v) => Math.round(v * 40)), Object.values(s.afford), s.tiers, s.act, s.objective, s.target,
      s.progress && Math.round(s.progress.v * 200), s.progress?.label, s.boss !== null ? Math.round(s.boss * 300) : null, s.prompt, s.hint, s.lockNeeded,
    ]);
    if (s.flying !== (this.lastKeyHints === 'fly')) this.setKeyHints(s.flying);
    if (key === this.lastHud) return;
    this.lastHud = key;
    $('hp-fill').style.transform = `scaleX(${Math.max(0, s.hp / s.maxHp)})`;
    $('shield-fill').style.transform = `scaleX(${s.shieldMax > 0 ? Math.max(0, s.shield / s.shieldMax) : 0})`;
    $('hp-text').textContent = `${Math.ceil(s.hp)}/${s.maxHp}${s.shield > 0 ? ` (+${Math.ceil(s.shield)})` : ''}`;
    $('res-fill').style.transform = `scaleX(${Math.min(1, s.res / s.maxRes)})`;
    $('res-fill').parentElement!.classList.toggle('ready', s.res >= s.maxRes - 1);
    $('res-text').textContent = `${Math.round((s.res / s.maxRes) * 100)}%`;
    $('lvl').textContent = String(s.level);
    $('xp-fill').style.transform = `scaleX(${Math.min(1, s.xp / s.xpNext)})`;
    const setAb = (id: string, ready: number, afford: boolean) => {
      const el = $(id);
      el.style.setProperty('--p', String(1 - ready));
      el.classList.toggle('ready', ready >= 1 && afford);
      el.classList.toggle('low', ready >= 1 && !afford);
    };
    setAb('ab-dash', s.abil.dash, true);
    setAb('ab-spike', s.abil.spike, s.afford.spike);
    setAb('ab-shield', s.abil.shield, s.afford.shield);
    setAb('ab-surge', s.abil.surge, s.afford.surge);
    $('affinities').innerHTML = (['root', 'echo', 'flow'] as Affinity[])
      .filter((a) => s.tiers[a] > 0)
      .map((a) => `<span class="chip" style="color:${AFFINITY_META[a].color}">${AFFINITY_META[a].glyph} ${AFFINITY_META[a].name} ${'I'.repeat(s.tiers[a])}</span>`)
      .join('');
    $('act-name').textContent = s.act;
    $('objective').textContent = s.objective;
    const tg = $('target');
    tg.textContent = s.target ? `Current Target: ${s.target}` : '';
    tg.style.display = s.target ? 'block' : 'none';
    const prog = $('prog');
    prog.classList.toggle('hidden', !s.progress);
    if (s.progress) {
      $('prog-fill').style.transform = `scaleX(${s.progress.v})`;
      $('prog-text').textContent = s.progress.label;
    }
    $('boss-bar').classList.toggle('hidden', s.boss === null);
    if (s.boss !== null) $('boss-fill').style.transform = `scaleX(${Math.max(0, s.boss)})`;
    const prompt = $('prompt');
    prompt.classList.toggle('hidden', !s.prompt);
    if (s.prompt) prompt.innerHTML = s.prompt;
    const hint = $('hint');
    hint.classList.toggle('hidden', !s.hint);
    if (s.hint) hint.innerHTML = s.hint;
    $('lockhint').classList.toggle('hidden', !s.lockNeeded);
  }

  setKeyHints(flying: boolean) {
    this.lastKeyHints = flying ? 'fly' : 'ground';
    $('keyhints').innerHTML = flying
      ? '<div><kbd>[SPACE]</kbd> ASCEND</div><div><kbd>[C]</kbd> DESCEND</div><div><kbd>[SHIFT]</kbd> BOOST</div><div><kbd>[V]</kbd> LAND</div>'
      : '<div><kbd>[E]</kbd> INTERACT</div><div><kbd>[SHIFT]</kbd> DASH</div><div><kbd>[LMB]</kbd> ATTACK</div><div><kbd>[RMB]</kbd> AIM</div><div><kbd>[V]</kbd> FLIGHT</div>';
  }

  /** Square local map: terrain raster rotated so the camera's forward is up. */
  drawMinimap(m: MapData) {
    const ctx = this.mini;
    const W = 200;
    const c = W / 2;
    const half = 55; // world units from centre to edge
    const s = c / half;
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.fillStyle = 'rgba(2,16,15,0.8)';
    ctx.fillRect(0, 0, W, W);
    ctx.translate(c, c);
    ctx.rotate(m.player.yaw + Math.PI);
    ctx.scale(s, s);
    ctx.translate(-m.player.x, -m.player.z);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(m.raster, -m.extent, -m.extent, m.extent * 2, m.extent * 2);
    ctx.globalAlpha = 1;
    // markers in the same space
    const dot = (x: number, z: number, r: number, col: string) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, z, r / s, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const e of m.echoes) dot(e.x, e.z, 1.6, 'rgba(176,132,255,0.85)');
    for (const cm of m.camps) if (!cm.cleared) dot(cm.x, cm.z, 5, 'rgba(255,59,122,0.28)');
    for (const n of m.nodes) dot(n.x, n.z, 4.5, n.state === 'done' ? '#5cffc1' : n.state === 'active' ? '#ffb86b' : '#ffd36b');
    for (const p of m.pylons) dot(p.x, p.z, 4, p.state === 'done' ? '#4fd8ff' : '#ff9a4a');
    for (const k of m.caches) if (!k.opened) dot(k.x, k.z, 2.6, '#ffc14a');
    if (m.gate) dot(m.gate.x, m.gate.z, 5, m.gate.open > 0.5 ? '#ffffff' : 'rgba(255,59,122,0.9)');
    for (const e of m.enemies) dot(e.x, e.z, e.boss ? 5 : 2.2, '#ff3b7a');
    ctx.restore();
    // player arrow (always up)
    ctx.fillStyle = m.accent;
    ctx.beginPath();
    ctx.moveTo(c, c - 8);
    ctx.lineTo(c + 5.5, c + 6);
    ctx.lineTo(c, c + 3);
    ctx.lineTo(c - 5.5, c + 6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(124,255,214,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, W - 2);
  }

  /** Round compass: cardinal ring + enemy / objective blips relative to the camera heading. */
  drawCompass(yaw: number, p: { x: number; z: number }, enemies: { x: number; z: number; boss: boolean }[], objective: { x: number; z: number } | null) {
    const ctx = this.comp;
    const W = 170;
    const c = W / 2;
    const R = c - 6;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(2,18,18,0.72)';
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(124,255,214,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(124,255,214,0.18)';
    ctx.lineWidth = 1;
    for (const rr of [R * 0.33, R * 0.66]) {
      ctx.beginPath();
      ctx.arc(c, c, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    // radar sweep wedge: field of view
    ctx.fillStyle = 'rgba(92,255,193,0.1)';
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, R, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fill();
    const rel = (x: number, z: number) => Math.atan2(x - p.x, z - p.z) - yaw;
    const pt = (rl: number, rad: number) => [c - Math.sin(rl) * rad, c - Math.cos(rl) * rad] as const;
    // cardinal letters (north = -z)
    ctx.font = '600 12px "Bahnschrift", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cards: [string, number, number][] = [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]];
    for (const [ch, dx, dz] of cards) {
      const [x, y] = pt(rel(p.x + dx, p.z + dz), R - 11);
      ctx.fillStyle = ch === 'N' ? '#5cffc1' : '#bfeee0';
      ctx.fillText(ch, x, y);
    }
    for (const e of enemies) {
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d > 80) continue;
      const [x, y] = pt(rel(e.x, e.z), (d / 80) * (R - 20));
      ctx.fillStyle = '#ff4d7e';
      ctx.beginPath();
      ctx.arc(x, y, e.boss ? 4.5 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (objective) {
      const d = Math.hypot(objective.x - p.x, objective.z - p.z);
      const [x, y] = pt(rel(objective.x, objective.z), Math.min(d / 80, 1) * (R - 20));
      ctx.fillStyle = '#ffc14a';
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 5, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 5, y);
      ctx.fill();
    }
    ctx.fillStyle = '#5cffc1';
    ctx.beginPath();
    ctx.moveTo(c, c - 7);
    ctx.lineTo(c + 5, c + 5);
    ctx.lineTo(c - 5, c + 5);
    ctx.fill();
  }

  damageNumber(x: number, y: number, v: number, crit: boolean) {
    if (this.dmgCount > 28) return;
    const el = document.createElement('div');
    el.className = 'dmg' + (crit ? ' crit' : '');
    el.textContent = String(v);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    $('dmg-layer').appendChild(el);
    this.dmgCount++;
    window.setTimeout(() => {
      el.remove();
      this.dmgCount--;
    }, 900);
  }

  hitMarker(crit: boolean) {
    const h = $('hitmark');
    h.classList.remove('on');
    void h.offsetWidth;
    h.classList.toggle('crit', crit);
    h.classList.add('on');
  }

  // ---- narration ------------------------------------------------------------
  say(lines: string | string[]) {
    const arr = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
    this.sayQueue.push(...arr);
    while (this.sayQueue.length > 5) this.sayQueue.splice(1, 1);
    if (!this.sayBusy) this.pump();
  }
  clearSay() {
    this.sayQueue.length = 0;
    this.sayTimers.forEach((t) => window.clearTimeout(t));
    this.sayTimers.length = 0;
    this.sayBusy = false;
    $('subtitle-text').classList.remove('on');
  }
  private pump() {
    const line = this.sayQueue.shift();
    const el = $('subtitle-text');
    if (!line) {
      this.sayBusy = false;
      el.classList.remove('on');
      return;
    }
    this.sayBusy = true;
    el.textContent = '';
    el.classList.add('on');
    let i = 0;
    const type = () => {
      i = Math.min(line.length, i + 2);
      el.textContent = line.slice(0, i);
      if (i < line.length) this.sayTimers.push(window.setTimeout(type, 26));
      else {
        const hold = 2200 + line.length * 42;
        this.sayTimers.push(
          window.setTimeout(() => {
            el.classList.remove('on');
            this.sayTimers.push(window.setTimeout(() => this.pump(), 650));
          }, hold),
        );
      }
    };
    type();
  }

  banner(act: string, name: string) {
    const b = $('banner');
    b.classList.add('hidden');
    void b.offsetWidth;
    (b.querySelector('.act') as HTMLElement).textContent = act;
    (b.querySelector('h2') as HTMLElement).textContent = name;
    b.classList.remove('hidden');
    window.setTimeout(() => b.classList.add('hidden'), 5300);
  }

  toast(msg: string) {
    const t = $('toast');
    t.classList.add('hidden');
    void t.offsetWidth;
    t.textContent = msg;
    t.classList.remove('hidden');
  }

  fade(on: boolean, color: 'white' | 'black' = 'white', ms = 900) {
    const f = $('fade');
    f.classList.toggle('dark', color === 'black');
    f.style.transition = `opacity ${ms}ms ease`;
    f.style.opacity = on ? '1' : '0';
    if (ms === 0) void f.offsetWidth;
  }

  hurtFlash() {
    const d = $('damage-flash');
    d.classList.add('on');
    window.setTimeout(() => d.classList.remove('on'), 60);
  }

  // ---- overlays ------------------------------------------------------------------
  prologue(lines: string[], done: () => void) {
    this.show('prologue');
    const p = $('prologue-text');
    let i = 0;
    let busy = false;
    const next = () => {
      if (busy) return;
      if (i >= lines.length) {
        cleanup();
        done();
        return;
      }
      busy = true;
      p.classList.remove('on');
      window.setTimeout(() => {
        p.textContent = lines[i++];
        p.classList.add('on');
        busy = false;
      }, 700);
    };
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Enter' || e.code === 'Space') next();
    };
    const cleanup = () => {
      window.removeEventListener('keydown', key);
      $('prologue').removeEventListener('click', next);
      p.classList.remove('on');
      this.hide('prologue');
    };
    window.addEventListener('keydown', key);
    $('prologue').addEventListener('click', next);
    next();
  }

  choice(set: ChoiceSet, tiers: Record<Affinity, number>, pick: (c: Choice) => void) {
    $('choice-act').textContent = set.act;
    $('choice-prompt').textContent = set.prompt;
    const cards = $('choice-cards');
    cards.innerHTML = '';
    set.choices.forEach((c, i) => {
      const meta = AFFINITY_META[c.affinity];
      const nextTier = tiers[c.affinity] + 1;
      const perk = PERKS[c.affinity][nextTier - 1];
      const b = document.createElement('button');
      b.className = 'card';
      b.style.setProperty('--c', meta.color);
      b.innerHTML = `<span class="aff">${meta.glyph} ${meta.name} — ${meta.tagline}</span>
        <span class="ttl">${c.title}</span>
        <span class="bl">${c.blurb}</span>
        <span class="perk"><b>${meta.name.toUpperCase()} ${'I'.repeat(Math.min(nextTier, 3))}</b><br>${perk ?? 'Mastery already woven in — your path deepens.'}</span>
        <span class="key">[${i + 1}]</span>`;
      b.addEventListener('click', () => select(i));
      cards.appendChild(b);
    });
    const select = (i: number) => {
      if (!this.isOpen('choice')) return;
      this.choiceKeyHandler = undefined;
      this.hide('choice');
      pick(set.choices[i]);
    };
    this.choiceKeyHandler = select;
    this.show('choice');
  }
  choiceKey(i: number) {
    if (this.choiceKeyHandler) this.choiceKeyHandler(i);
  }

  /** [A] Embrace the Null vs [B] Purify the Remembrance, with the run's branching pathway underneath. */
  binaryChoice(o: { title: string; embrace: string; purify: string; history: Remembrance[]; total: number }, pick: (c: Remembrance) => void) {
    $('bin-title').textContent = o.title;
    $('bin-a-text').textContent = o.embrace;
    $('bin-b-text').textContent = o.purify;
    $('bin-path').innerHTML = this.pathSvg(o.history, o.total);
    this.binaryHandler = (c) => {
      if (!this.isOpen('binary')) return;
      this.binaryHandler = undefined;
      this.hide('binary');
      pick(c);
    };
    this.show('binary');
  }
  binaryKey(c: Remembrance) {
    this.binaryHandler?.(c);
  }
  bindBinary() {
    $('bin-a').addEventListener('click', () => this.binaryKey('embrace'));
    $('bin-b').addEventListener('click', () => this.binaryKey('purify'));
  }

  private pathSvg(history: Remembrance[], total: number) {
    const W = 920;
    const H = 130;
    const pad = 60;
    const step = (W - pad * 2) / Math.max(1, total);
    const mid = 62;
    const acts = [1, 3, 3];
    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Bahnschrift, system-ui, sans-serif">`;
    svg += `<line x1="${pad - 20}" y1="${mid}" x2="${W - pad + 30}" y2="${mid}" stroke="rgba(124,255,214,0.4)" stroke-width="2"/>`;
    let idx = 0;
    acts.forEach((n, a) => {
      const x0 = pad + idx * step;
      const x1 = pad + (idx + n) * step - step * 0.2;
      svg += `<text x="${(x0 + x1) / 2}" y="16" fill="#8fe8cf" font-size="11" letter-spacing="3" text-anchor="middle">ACT ${['I', 'II', 'III'][a]}</text>`;
      idx += n;
    });
    for (let i = 0; i < total; i++) {
      const x = pad + (i + 0.5) * step;
      const done = history[i];
      const current = i === history.length;
      if (done) {
        const col = done === 'embrace' ? '#ff4d6a' : '#4fb4ff';
        const dy = done === 'embrace' ? -34 : 34;
        svg += `<path d="M${x} ${mid} Q${x + 14} ${mid + dy * 0.6} ${x + 28} ${mid + dy}" fill="none" stroke="${col}" stroke-width="3"/><circle cx="${x + 28}" cy="${mid + dy}" r="7" fill="${col}"/>`;
        svg += `<circle cx="${x}" cy="${mid}" r="6" fill="#cfeee6"/>`;
      } else if (current) {
        svg += `<path d="M${x} ${mid} Q${x + 14} ${mid - 20} ${x + 28} ${mid - 34}" fill="none" stroke="#ff4d6a" stroke-width="2.5" stroke-dasharray="4 4"/><path d="M${x} ${mid} Q${x + 14} ${mid + 20} ${x + 28} ${mid + 34}" fill="none" stroke="#4fb4ff" stroke-width="2.5" stroke-dasharray="4 4"/>`;
        svg += `<text x="${x + 38}" y="${mid - 30}" fill="#ff8fa0" font-size="13" font-weight="700">A</text><text x="${x + 38}" y="${mid + 42}" fill="#8fd0ff" font-size="13" font-weight="700">B</text>`;
        svg += `<circle cx="${x}" cy="${mid}" r="9" fill="#ffc14a"><animate attributeName="r" values="8;11;8" dur="1.2s" repeatCount="indefinite"/></circle>`;
      } else {
        svg += `<circle cx="${x}" cy="${mid}" r="5" fill="none" stroke="rgba(207,238,230,0.4)" stroke-width="1.5"/>`;
      }
    }
    svg += '</svg>';
    return svg;
  }

  timeline(run: RunState) {
    const body = $('timeline-body');
    const cur = run.stratumIndex;
    const left = STRATA.map((s, i) => {
      const h = run.history.find((x) => x.stratum === s.id);
      const state = i < cur ? 'past' : i === cur ? 'now' : 'future';
      const color = h?.choice ? AFFINITY_META[h.choice.affinity].color : 'var(--accent)';
      const meta = h
        ? `${h.kills} purified · ${h.echoes} echoes · ${fmtTime(h.time)}${h.deaths ? ` · reseeded ${h.deaths}×` : ''}${h.purified ? ` · purified ${h.purified}` : ''}${h.embraced ? ` · embraced ${h.embraced}` : ''}`
        : state === 'now' ? 'you are here' : 'not yet woven';
      return `<div class="tl-item ${state}" style="--c:${color}">
        <h3>${s.name}</h3><div class="meta">${s.act}</div>
        ${h?.choice ? `<div class="ch">${AFFINITY_META[h.choice.affinity].glyph} ${h.choice.title}</div>` : ''}
        <div class="meta">${meta}</div>
        ${h?.mindNote ? `<div class="note">The Mycelial Mind noticed: ${h.mindNote}</div>` : ''}
      </div>`;
    }).join('');
    const rows = (['root', 'echo', 'flow'] as Affinity[])
      .map((a) => {
        const m = AFFINITY_META[a];
        const pips = [1, 2, 3].map((n) => `<i class="pip ${run.tiers[a] >= n ? 'on' : ''}"></i>`).join('');
        const perks = PERKS[a].slice(0, run.tiers[a]).map((p) => `<li>${p}</li>`).join('');
        return `<div style="--c:${m.color}"><div class="tier-row"><span style="color:${m.color}">${m.glyph} ${m.name}</span><span class="pips">${pips}</span></div>${perks ? `<ul class="perk-list">${perks}</ul>` : ''}</div>`;
      })
      .join('');
    body.innerHTML = `<div class="tl">${left}</div>
      <div class="side"><h3>Affinities</h3>${rows}
      <h3>The Null</h3><div class="echoes-line">${run.purityPoints} Remembrance${run.purityPoints === 1 ? '' : 's'} purified · ${run.nullPoints} embraced.</div>
      <h3>The world so far</h3>
      <div class="echoes-line">${run.echoes.length} echo-tree${run.echoes.length === 1 ? '' : 's'} remember${run.echoes.length === 1 ? 's' : ''} you. ${run.kills} fragment${run.kills === 1 ? '' : 's'} of Static purified. ${run.cycle > 1 ? `Cycle ${run.cycle}.` : ''}</div></div>`;
    this.show('timeline');
  }

  library(entries: LibraryEntry[]) {
    const body = $('library-body');
    body.innerHTML = entries.length
      ? entries
          .slice()
          .reverse()
          .map((e) => `<details><summary>Cycle ${e.cycle} — ${e.title}<small>${e.date}</small></summary><p>${e.text.replace(/</g, '&lt;')}</p></details>`)
          .join('')
      : '<p class="empty">No stories carried home yet. Finish a cycle and it will be kept here.</p>';
    this.show('library');
  }

  death(text: string) {
    $('death-text').textContent = text;
    this.show('death');
  }

  ending(story: ComposedStory) {
    $('ending-title').textContent = story.title;
    const body = $('ending-body');
    body.innerHTML = story.paragraphs.map((p, i) => `<p style="animation-delay:${0.6 + i * 1.4}s">${p.replace(/</g, '&lt;')}</p>`).join('');
    $('ending-stats').textContent = story.stats;
    const menu = document.querySelector('#ending .menu') as HTMLElement;
    menu.style.animationDelay = `${0.6 + story.paragraphs.length * 1.4}s`;
    this.show('ending');
  }

  setMuteLabel(muted: boolean) {
    $('btn-mute').textContent = muted ? 'Unmute' : 'Mute';
  }
  setBloomLabel(on: boolean) {
    $('btn-bloom').textContent = `Bloom: ${on ? 'on' : 'off'}`;
  }
  showTouch(v: boolean) {
    $('touch').classList.toggle('hidden', !v);
  }
  showNoGL() {
    $('nogl').classList.remove('hidden');
  }

  // ---- inventory ---------------------------------------------------------------
  openInventory(run: RunState, derived: () => Derived, h: InvHandlers, tab = 'gear') {
    this.inv = { run, derived, h, tab };
    document.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => {
      b.onclick = () => {
        this.inv!.tab = b.dataset.tab!;
        this.renderInv();
      };
    });
    this.show('inventory');
    this.renderInv();
  }

  refreshInventory() {
    if (this.inv && this.isOpen('inventory')) this.renderInv();
  }

  private itemStatsHtml(it: Item, cmp?: Item) {
    const keys = new Set([...Object.keys(it.stats), ...(cmp ? Object.keys(cmp.stats) : [])]);
    return [...keys]
      .map((k) => {
        const key = k as keyof typeof STAT_LABEL;
        const v = it.stats[key] ?? 0;
        const diff = cmp ? v - (cmp.stats[key] ?? 0) : 0;
        const d = cmp && Math.abs(diff) > 1e-6 ? `<em class="${diff < 0 ? 'worse' : ''}"> (${diff > 0 ? '+' : '−'}${fmtStat(key, Math.abs(diff)).replace('+', '')})</em>` : '';
        return `<div class="st"><span>${STAT_LABEL[key]}</span><span>${v ? fmtStat(key, v) : '—'}${d}</span></div>`;
      })
      .join('');
  }

  private renderInv() {
    const inv = this.inv!;
    const { run, h } = inv;
    const D = inv.derived();
    document.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === inv.tab));
    $('inv-pts').textContent = run.skillPoints > 0 ? `${run.skillPoints} SKILL POINT${run.skillPoints > 1 ? 'S' : ''} AVAILABLE` : `LEVEL ${run.level}`;
    const body = $('inv-body');

    if (inv.tab === 'gear') {
      const slots = SLOTS.map((sl) => {
        const it = run.equipped[sl];
        const rc = it ? RARITY[it.rarity].color : 'rgba(124,255,214,0.28)';
        return `<button class="slotbtn" data-slot="${sl}" style="--rc:${rc}"><span class="ico">${SLOT_ICON[sl]}</span><span><b>${it ? it.name : SLOT_LABEL[sl]}</b><small>${it ? `${RARITY[it.rarity].name} · Lv ${it.level}` : 'Empty'}</small></span></button>`;
      }).join('');
      const pack = run.inventory
        .map((it) => `<button class="cell ${inv.sel?.id === it.id ? 'sel' : ''}" data-id="${it.id}" style="--rc:${RARITY[it.rarity].color}" title="${it.name}">${SLOT_ICON[it.slot]}</button>`)
        .join('');
      const sel = inv.sel && run.inventory.find((i) => i.id === inv.sel!.id);
      const eq = sel ? run.equipped[sel.slot] : undefined;
      const detail = sel
        ? `<h4 style="--rc:${RARITY[sel.rarity].color}">${sel.name}</h4><div style="color:var(--dim);font-size:11px;margin-bottom:6px">${RARITY[sel.rarity].name} ${SLOT_LABEL[sel.slot]} · Lv ${sel.level}</div>${this.itemStatsHtml(sel, eq)}<div class="acts"><button data-act="equip" class="primary">Equip</button><button data-act="dismantle">Dismantle (+XP)</button></div>`
        : `<div style="color:var(--dim)">Select a piece of gear from your pack to compare it with what you wear. Rare gear drops from Void-Root Fiends, Spore Caches and Pylon purges — and from Embracing the Null.</div>`;
      body.innerHTML = `<div class="inv-grid">
        <div class="slotlist">${slots}</div>
        <div class="portrait"><img alt="Wisdomkeeper" src="${renderPortrait(run.skin)}"></div>
        <div><div class="eyebrow" style="margin-bottom:8px">Backpack · ${run.inventory.length}</div><div class="pack">${pack || '<span class="empty">Nothing yet.</span>'}</div><div class="detail">${detail}</div></div>
      </div>`;
      body.querySelectorAll<HTMLElement>('.slotbtn').forEach((b) => {
        b.onclick = () => {
          const it = run.equipped[b.dataset.slot as Slot];
          if (it) {
            h.unequip(b.dataset.slot as Slot);
            this.renderInv();
          }
        };
      });
      body.querySelectorAll<HTMLElement>('.cell').forEach((b) => {
        b.onclick = () => {
          inv.sel = run.inventory.find((i) => i.id === b.dataset.id);
          this.renderInv();
        };
      });
      body.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => {
        b.onclick = () => {
          if (!sel) return;
          if (b.dataset.act === 'equip') h.equip(sel);
          else h.dismantle(sel);
          inv.sel = undefined;
          this.renderInv();
        };
      });
    } else if (inv.tab === 'skills') {
      const cols = (['root', 'echo', 'flow'] as Affinity[])
        .map((a) => {
          const m = AFFINITY_META[a];
          const nodes = SKILLS.filter((s) => s.branch === a)
            .map((s) => {
              const r = run.skills[s.id] ?? 0;
              const can = canRank(run, s.id);
              const locked = !can && r === 0 && !!s.requires && (run.skills[s.requires] ?? 0) < (SKILLS.find((x) => x.id === s.requires)?.max ?? 1);
              return `<button class="sk ${r >= s.max ? 'maxed' : ''} ${can ? 'can' : ''} ${locked ? 'locked' : ''}" data-sk="${s.id}" style="--c:${m.color}"><span class="node">${r}/${s.max}</span><span><b>${s.name}</b><small>${s.desc}</small></span></button>`;
            })
            .join('');
          return `<div class="branch" style="color:${m.color}"><h3>${m.glyph} ${m.name.toUpperCase()} MASTERY</h3><div class="chain">${nodes}</div></div>`;
        })
        .join('');
      body.innerHTML = `<div class="skilltree">${cols}</div>`;
      body.querySelectorAll<HTMLElement>('.sk').forEach((b) => {
        b.onclick = () => {
          h.rank(b.dataset.sk!);
          this.renderInv();
        };
      });
    } else if (inv.tab === 'stats') {
      const pct = (v: number) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
      const rows: [string, string][] = [
        ['Level', `${run.level}`],
        ['Life', `${D.maxHp}`],
        ['Resonance', `${D.maxRes}`],
        ['Resonance regeneration', `${D.resRegen.toFixed(1)}/s`],
        ['Damage', pct(D.dmgMul)],
        ['Damage vs Void', pct(D.voidMul)],
        ['Ability power', pct(D.power)],
        ['Damage reduction', `${Math.round(D.dr * 100)}%`],
        ['Move speed', pct(D.speedMul)],
        ['Dash recovery', `${Math.round((1 - D.dashCdMul) * 100)}% faster`],
        ['Attack speed', pct(D.attackSpeed * (run.tiers.flow >= 3 ? 1.5 : 1))],
        ['Fractal Shield', `${D.shieldCap} absorb`],
        ['Root Spike', `${D.spikeCount} spikes`],
        ['Flight drain', pct(D.flightDrain)],
        ['Null influence', `${run.nullPoints}`],
        ['Purity', `${run.purityPoints}`],
      ];
      body.innerHTML = `<div class="stats">${rows.map(([k, v]) => `<div class="row"><span>${k}</span><em>${v}</em></div>`).join('')}</div>`;
    } else {
      const cards = (['resonant', 'verdant', 'void'] as Skin[])
        .map((sk) => {
          const ok = skinUnlocked(run, sk);
          return `<button class="skin ${run.skin === sk ? 'on' : ''} ${ok ? '' : 'locked'}" data-skin="${sk}"><img alt="${sk}" src="${renderPortrait(sk, 220, 320)}"><b>${SKINS[sk].name}</b><small>${SKINS[sk].blurb}</small><small>${ok ? (run.skin === sk ? 'EQUIPPED' : 'Click to wear') : `LOCKED — ${SKINS[sk].unlock}`}</small></button>`;
        })
        .join('');
      body.innerHTML = `<div class="skins">${cards}</div>`;
      body.querySelectorAll<HTMLElement>('.skin').forEach((b) => {
        b.onclick = () => {
          const sk = b.dataset.skin as Skin;
          if (!skinUnlocked(run, sk)) return;
          h.skin(sk);
          this.renderInv();
        };
      });
    }
  }

  // ---- world map ------------------------------------------------------------------
  openMap(title: string, d: MapData, onClick: (x: number, z: number) => void) {
    $('map-title').textContent = title;
    this.mapClick = onClick;
    const cv = $<HTMLCanvasElement>('map-canvas');
    const ctx = cv.getContext('2d')!;
    const S = cv.width;
    const P = (x: number, z: number) => [((x / d.extent) * 0.5 + 0.5) * S, ((z / d.extent) * 0.5 + 0.5) * S] as const;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(d.raster, 0, 0, S, S);
    // boundary
    ctx.strokeStyle = 'rgba(255,193,74,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, (S / 2) * (1 / 1.12), 0, Math.PI * 2);
    ctx.stroke();
    const circ = (x: number, z: number, r: number, fill: string, stroke?: string) => {
      const [px, py] = P(x, z);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    };
    for (const e of d.echoes) circ(e.x, e.z, 2.2, 'rgba(176,132,255,0.85)');
    for (const c of d.camps) {
      if (!c.cleared) circ(c.x, c.z, 13, 'rgba(255,59,122,0.18)', 'rgba(255,59,122,0.8)');
    }
    const diamond = (x: number, z: number, r: number, fill: string) => {
      const [px, py] = P(x, z);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r, py);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px - r, py);
      ctx.fill();
      ctx.strokeStyle = '#02100f';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    for (const n of d.nodes) diamond(n.x, n.z, 10, n.state === 'done' ? '#5cffc1' : n.state === 'active' ? '#ffb86b' : '#ffd36b');
    for (const p of d.pylons) {
      const [px, py] = P(p.x, p.z);
      ctx.fillStyle = p.state === 'done' ? '#4fd8ff' : '#ff9a4a';
      ctx.beginPath();
      for (let i = 0; i < 6; i++) ctx.lineTo(px + Math.cos((i / 6) * Math.PI * 2) * 10, py + Math.sin((i / 6) * Math.PI * 2) * 10);
      ctx.fill();
      ctx.strokeStyle = '#02100f';
      ctx.stroke();
    }
    for (const k of d.caches) if (!k.opened) circ(k.x, k.z, 4, '#ffc14a', '#02100f');
    if (d.gate) {
      const [gx, gy] = P(d.gate.x, d.gate.z);
      ctx.strokeStyle = d.gate.open > 0.5 ? '#ffffff' : '#ff3b7a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(gx, gy, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(gx, gy, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    const [px, py] = P(d.player.x, d.player.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-d.player.yaw + Math.PI);
    ctx.fillStyle = d.accent;
    ctx.strokeStyle = '#02100f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    cv.onclick = (e) => {
      const r = cv.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * S;
      const my = ((e.clientY - r.top) / r.height) * S;
      const wx = ((mx / S) * 2 - 1) * d.extent;
      const wz = ((my / S) * 2 - 1) * d.extent;
      this.mapClick?.(wx, wz);
    };
    $('map-legend').innerHTML = '◆ Remembrance &nbsp; ⬢ Pylon (click a purged Pylon to fast travel) &nbsp; ● Spore Cache &nbsp; ◯ Null camp &nbsp; ➤ You';
    this.show('map');
  }
}
