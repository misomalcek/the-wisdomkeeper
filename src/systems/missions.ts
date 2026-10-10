import type { Item, Mission, MissionKind } from '../types';
import type { StratumDef } from '../story/strata';
import type { CampSpec } from '../world/world';

/**
 * Side missions offered by the Neural World Director. Each region rolls up to three from its own entropy pool, so
 * two runs of the same region rarely ask the same things: purge a Void-Root spawning pool, harvest Void Crystals,
 * hunt the Null's machines, or make contact with a stray datastream.
 */
export interface MissionSite {
  x: number;
  z: number;
}

const TITLES: Record<MissionKind, string[]> = {
  pool: ['Boil-Off at the Spawning Pool', 'Cauterise the Root Pool', 'Silence the Breeding Ground'],
  harvest: ['Crystal Tithe', 'Harvest the Void Bloom', 'Shards for the Resonator'],
  hunt: ['Optic Blindness', 'Ground the Sentries', 'Break the Stalk-Line'],
  contact: ['A Datastream Calling', 'Echo in the Fog', 'Lost Packet'],
};

export function offerMissions(def: StratumDef, camps: CampSpec[], rnd: () => number, nextId: number, contactSite: (rnd: () => number) => MissionSite | null): Mission[] {
  if (def.boss || def.ambient <= 0) return [];
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const out: Mission[] = [];
  const idx = def.index;
  const roam = camps.filter((c) => c.kind === 'roam');
  const kinds: MissionKind[] = ['harvest', 'contact'];
  if (roam.length) kinds.push('pool');
  if ((def.mix.drone ?? 0) > 0 || def.mix.brute > 0) kinds.push('hunt');
  // shuffle, then take up to three
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  for (const kind of kinds.slice(0, 3)) {
    const base = { id: nextId++, kind, title: pick(TITLES[kind]), stratum: idx, have: 0, state: 'active' as const };
    if (kind === 'pool') {
      const c = pick(roam);
      out.push({ ...base, brief: `Purge the ${c.name} festering in the Wilds.`, x: c.x, z: c.z, need: 1, reward: 6 + idx * 2, target: c.id });
    } else if (kind === 'harvest') {
      const need = 8 + idx * 3;
      out.push({ ...base, brief: `Gather ${need} Void Crystals from pylons and fallen Null.`, x: NaN, z: NaN, need, reward: 4 + idx, target: -1 });
    } else if (kind === 'hunt') {
      const drones = (def.mix.drone ?? 0) > 0 && rnd() < 0.6;
      const need = drones ? 3 + idx : 2 + Math.floor(idx / 2);
      out.push({ ...base, title: drones ? base.title : 'Break the Stalk-Line', brief: drones ? `Destroy ${need} Null-Sentry Drones.` : `Fell ${need} Void-Root Fiends.`, x: NaN, z: NaN, need, reward: 6 + idx * 2, target: drones ? 1 : 0 });
    } else {
      const s = contactSite(rnd);
      if (!s) continue;
      out.push({ ...base, brief: 'A stray datastream is broadcasting from the fog. Reach it before it fades.', x: s.x, z: s.z, need: 1, reward: 5 + idx, target: -1 });
    }
  }
  return out;
}

export const missionLine = (m: Mission) => (m.state === 'done' ? `✓ ${m.title}` : m.need > 1 ? `${m.title} · ${m.have}/${m.need}` : m.title);

/** Crystal cost of infusing an item one level higher. */
export const infuseCost = (it: Item) => 6 + it.level * 2;

/** Infuse an item: +1 level, every stat +12%. */
export function infuse(it: Item) {
  it.level++;
  for (const k of Object.keys(it.stats) as (keyof Item['stats'])[]) it.stats[k] = +((it.stats[k] ?? 0) * 1.12).toFixed(4);
}
