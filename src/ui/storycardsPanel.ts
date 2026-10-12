/**
 * The Storycards overlay: current card summary, latest punches, downloads, upload (picker + drag-and-drop)
 * and the autosave deck. Every card-derived string is written with textContent — cards are untrusted input.
 */
import type { Punch } from '../types';
import { STRATA } from '../story/strata';
import { fmtTime } from '../util/math';
import {
  MAX_CARD_BYTES, StorycardError, parseStorycard, storycardFilename, storycardToJSON, storycardToMarkdown, type DeckEntry, type Storycard,
} from '../systems/storycards';

export interface StorycardsHandlers {
  /** The card for the story in progress (null when there is none). */
  current(): Storycard | null;
  deck(): DeckEntry[];
  /** Replace the current progress with this (already validated) card. Returns false when the player declined. */
  load(card: Storycard, source: 'upload' | 'deck'): boolean;
}

const $ = (id: string) => document.getElementById(id)!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const PUNCH_GLYPH: Record<Punch['kind'], string> = {
  cycle: '✺', stratum: '◇', camp: '✕', pylon: '⟟', remembrance: '❖', contact: '⌁', choice: '❦', mission: '✓', boss: '☗', level: '▲', death: '✝', ending: '∞', note: '·', land: '❋',
};

function when(iso: string | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export class StorycardsPanel {
  private root = $('storycards');
  private status = $('sc-status');
  private file = $('sc-file') as HTMLInputElement;
  private h!: StorycardsHandlers;
  private card: Storycard | null = null;

  bind(h: StorycardsHandlers) {
    this.h = h;
    $('sc-dl-json').addEventListener('click', () => this.download('json'));
    $('sc-dl-md').addEventListener('click', () => this.download('md'));
    $('sc-upload').addEventListener('click', () => this.file.click());
    this.file.addEventListener('change', () => {
      const f = this.file.files?.[0];
      this.file.value = '';
      if (f) void this.upload(f);
    });
    const panel = this.root.querySelector('.panel') as HTMLElement;
    let depth = 0;
    this.root.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      panel.classList.add('drop');
    });
    this.root.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) panel.classList.remove('drop');
    });
    this.root.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      panel.classList.remove('drop');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.upload(f);
    });
  }

  /** Re-render from the handlers (call when opening the overlay). */
  render() {
    this.card = this.h.current();
    this.renderCurrent();
    this.renderDeck();
    (document.getElementById('sc-dl-json') as HTMLButtonElement).disabled = !this.card;
    (document.getElementById('sc-dl-md') as HTMLButtonElement).disabled = !this.card;
  }

  setStatus(msg: string, kind: 'ok' | 'error' | '' = '') {
    this.status.textContent = msg;
    this.status.className = `sc-status ${kind}`;
  }

  private renderCurrent() {
    const box = $('sc-current');
    box.replaceChildren();
    const c = this.card;
    if (!c) {
      box.append(el('p', 'empty', 'No story in progress. Begin one, or upload a storycard to carry a story over from another device.'));
      return;
    }
    const r = c.run;
    box.append(el('div', 'eyebrow', STRATA[r.stratumIndex].act), el('h3', 'sc-title', c.title));
    const stats = el('dl', 'sc-stats');
    const purified = r.remembrances.filter((x) => x === 'purify').length;
    const add = (k: string, v: string | number) => {
      const d = el('div');
      d.append(el('dt', '', k), el('dd', '', String(v)));
      stats.append(d);
    };
    add('Static purified', r.kills);
    add('Reseeded', `${r.deaths}×`);
    add('Echo-trees', r.echoes.length);
    add('Remembrances', `${purified} purified · ${r.remembrances.length - purified} embraced`);
    add('Void Crystals', r.crystals ?? 0);
    add('Time', fmtTime(r.elapsed));
    box.append(stats);
    const list = el('ol', 'sc-punches');
    const latest = c.punches.slice(-8).reverse();
    for (const p of latest) {
      const li = el('li');
      li.append(el('i', `k-${p.kind}`, PUNCH_GLYPH[p.kind]), el('span', '', p.text), el('small', '', [STRATA[p.stratum].name, `Lv ${p.level}`, when(p.at)].filter(Boolean).join(' · ')));
      list.append(li);
    }
    if (latest.length) {
      box.append(el('h4', '', `Latest punches · ${c.punches.length} on the card`), list);
    }
  }

  private renderDeck() {
    const box = $('sc-deck');
    box.replaceChildren();
    const deck = this.h.deck();
    if (!deck.length) {
      box.append(el('p', 'empty', 'Autosaves appear here as you play — the last five are kept so you can roll back.'));
      return;
    }
    deck.forEach((e, i) => {
      const row = el('div', 'sc-row');
      const info = el('div', 'sc-row-info');
      const last = e.card.punches[e.card.punches.length - 1];
      info.append(el('b', '', e.card.title), el('small', '', [when(e.card.savedAt), last?.text].filter(Boolean).join(' · ')));
      const btn = el('button', '', i === 0 ? 'Restore latest' : 'Restore');
      btn.addEventListener('click', () => {
        if (this.h.load(e.card, 'deck')) this.setStatus('Restored from the autosave deck.', 'ok');
      });
      row.append(info, btn);
      box.append(row);
    });
  }

  private download(ext: 'json' | 'md') {
    // re-punch right before saving so the file holds the very latest state
    this.render();
    const c = this.card;
    if (!c) return;
    const text = ext === 'json' ? storycardToJSON(c) : storycardToMarkdown(c);
    const blob = new Blob([text], { type: ext === 'json' ? 'application/json' : 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = storycardFilename(c, ext, new Date());
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.setStatus(`Saved ${a.download}`, 'ok');
  }

  private async upload(f: File) {
    if (f.size > MAX_CARD_BYTES) {
      this.setStatus(`That file is too large to be a storycard (limit ${MAX_CARD_BYTES / 1024 / 1024} MB).`, 'error');
      return;
    }
    let card: Storycard;
    try {
      card = parseStorycard(await f.text());
    } catch (e) {
      this.setStatus(e instanceof StorycardError ? e.message : 'That file could not be read as a storycard.', 'error');
      return;
    }
    if (this.h.load(card, 'upload')) this.setStatus(`Loaded “${card.title}”.`, 'ok');
    else this.setStatus('Upload cancelled — your current story is unchanged.');
  }
}
