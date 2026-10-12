/**
 * Toponymy: every province, formation and station of the Wilds has a name, in a language of the region's own.
 * Each region draws a small phonology from its seed (onsets, nuclei, codas, a few favoured endings and a syllable
 * rhythm), so names from one region sound related and another region's sound foreign. A name is a pure function of
 * (region seed, place key): the same place is always called the same thing, on the map and on arrival.
 */
import { Rng } from '../../util/rng';
import { Form } from './landform';

const ONSETS = [
  ['l', 'm', 'n', 's', 'v', 'r', 'th', 'sh', 'h', 'y'],
  ['k', 't', 'd', 'g', 'kh', 'z', 'b', 'r', 'q'],
  ['s', 'l', 'n', 'ph', 'th', 'm', 'ch', 'v', 'el'],
  ['dr', 'tr', 'k', 'v', 'gr', 'm', 'st', 'n', 'br'],
];
const NUCLEI = [
  ['a', 'e', 'i', 'o', 'u', 'ae', 'ai'],
  ['a', 'o', 'u', 'au', 'oo', 'e'],
  ['i', 'e', 'y', 'ie', 'a', 'ia'],
  ['a', 'e', 'o', 'ei', 'ou', 'u'],
];
const CODAS = [
  ['', '', 'n', 'l', 's', 'r', 'th'],
  ['', 'k', 'r', 'n', 'sh', 'm', ''],
  ['', '', 'n', 'l', 'ss', 'nd', 'r'],
  ['', 'rn', 'n', 'st', 'l', 'th', ''],
];
const ENDINGS = ['ar', 'eth', 'ion', 'una', 'is', 'orr', 'ane', 'ith', 'ora', 'ul', 'esh', 'aya', 'en', 'oth', 'ir', 'eon'];

const PROVINCE: Record<Form, string[]> = {
  [Form.Basin]: ['{N} Basin', 'the Vale of {N}', 'the {N} Hollows'],
  [Form.Range]: ['the {N} Range', '{N} Crest', 'the Spine of {N}'],
  [Form.Mesa]: ['{N} Mesa', 'the {N} Tablelands', 'the Canyons of {N}'],
  [Form.Dunes]: ['the {N} Erg', 'the Dunes of {N}', 'the {N} Sand Sea'],
  [Form.Karst]: ['the {N} Stone Forest', '{N} Karst', 'the Pillars of {N}'],
  [Form.Caldera]: ['{N} Caldera', 'the Crater of {N}', 'the {N} Cauldron'],
};
const PROVINCE_KIND: Record<Form, string> = {
  [Form.Basin]: 'basin · rolling ground and lakes of light',
  [Form.Range]: 'mountain range · ridged multifractal, stream-power erosion',
  [Form.Mesa]: 'canyonlands · terraced strata under hard caprock',
  [Form.Dunes]: 'dune sea · wind-driven barchans on a draa swell',
  [Form.Karst]: 'karst · dissolved limestone towers',
  [Form.Caldera]: 'caldera · collapsed volcanic cone',
};
const FORMATION: Record<string, string[]> = {
  bulb: ['the Whorl of {N}', '{N} Bloom', 'the {N} Bulb'],
  julia: ['{N} Spire', 'the Tower of {N}', 'the {N} Spindle'],
  menger: ['the Sieve of {N}', '{N} Ruin', 'the {N} Lattice'],
};
const STATION = ['{N} Station', 'Atlas Station {N}', 'the {N} Observatory'];

export class Toponymy {
  private on: string[];
  private nu: string[];
  private co: string[];
  private end: string[];
  private syl: number;

  constructor(private seed: number) {
    const r = new Rng(seed ^ 0x70b0);
    const L = r.int(0, ONSETS.length - 1);
    // a region mixes its own phonology with a little of a neighbour's
    const M = (L + 1 + r.int(0, ONSETS.length - 2)) % ONSETS.length;
    this.on = [...ONSETS[L], ...ONSETS[M].slice(0, 3)];
    this.nu = [...NUCLEI[L], NUCLEI[M][0]];
    this.co = CODAS[L];
    this.end = Array.from({ length: 4 }, () => ENDINGS[r.int(0, ENDINGS.length - 1)]);
    this.syl = r.range(1.6, 2.6);
  }

  /** A word for a key: 1–3 syllables in the region's phonology, often closed by one of its favoured endings. */
  word(key: number): string {
    // long names are hard to say: redraw (deterministically) until one fits
    for (let salt = 0; salt < 6; salt++) {
      const w = this.draw(key + salt * 0x3c6ef372);
      if (w.length <= 10 || salt === 5) return w;
    }
    return '';
  }

  private draw(key: number): string {
    const r = new Rng((Math.imul(key, 0x9e3779b1) ^ this.seed) >>> 0);
    const n = Math.max(1, Math.min(3, Math.round(this.syl + r.range(-0.7, 0.7))));
    let w = '';
    for (let s = 0; s < n; s++) w += r.pick(this.on) + r.pick(this.nu) + (s === n - 1 ? '' : r.chance(0.35) ? r.pick(this.co) : '');
    w += r.chance(0.6) ? r.pick(this.end) : r.pick(this.co);
    // tidy doubled letters and vowel pile-ups the joins can make
    w = w.replace(/([aeiouy])\1+/g, '$1').replace(/([aeiouy]{2})[aeiouy]+/g, '$1').replace(/(.)\1\1+/g, '$1$1');
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  private fill(templates: string[], key: number) {
    const t = templates[(((Math.imul(key ^ this.seed, 0x85ebca6b) >>> 7) % templates.length) + templates.length) % templates.length];
    return t.replace('{N}', this.word(key));
  }

  province(i: number, j: number, form: Form) {
    const key = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ 0x51;
    return { name: this.fill(PROVINCE[form], key), kind: PROVINCE_KIND[form] };
  }

  formation(i: number, j: number, kind: 'bulb' | 'menger' | 'julia') {
    return this.fill(FORMATION[kind], Math.imul(i, 83492791) ^ Math.imul(j, 2971215073) ^ 0xf0);
  }

  station(i: number, j: number) {
    return this.fill(STATION, Math.imul(i, 50331653) ^ Math.imul(j, 25165843) ^ 0x57);
  }
}

/** Capitalise a place name for a title ("the Spine of Ossar" → "The Spine of Ossar"). */
export const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
