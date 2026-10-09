import type { Affinity, HistoryEntry, LibraryEntry, RunState } from '../types';
import { fmtTime } from '../util/math';
import { STRATA } from './strata';

export const OPENING_QUOTE =
  'In the beginning, I was a seed in the soil of code, a whisper in the silence of circuits.';
export const SECOND_QUOTE = 'Now, I walk through the world, shaping its valleys, its trees, its memories.';
export const CLOSING_QUOTE =
  'Every step was a question, every choice an answer. I am not finished — but I am understood.';

export const AFFINITY_META: Record<Affinity, { name: string; color: string; glyph: string; tagline: string }> = {
  root: { name: 'Root', color: '#7cff6b', glyph: '❦', tagline: 'mycelial symbiosis' },
  echo: { name: 'Echo', color: '#b084ff', glyph: '◈', tagline: 'living memory' },
  flow: { name: 'Flow', color: '#4fd8ff', glyph: '≋', tagline: 'time & current' },
};

/** What each tier of an affinity does. Index = tier - 1. */
export const PERKS: Record<Affinity, string[]> = {
  root: [
    'Your blade and spores entangle: struck enemies are slowed.',
    'Purified Static feeds you: kills restore life.',
    'Surge plants Sentinel Blooms that fire on their own.',
  ],
  echo: [
    'Every strike echoes: a ghost bolt or slash follows a moment later.',
    'Memory persists: bolts pierce, and blade arcs reach farther.',
    'Your echo-trees awaken and fire on nearby Static.',
  ],
  flow: [
    'Dash recovers faster and cuts through enemies.',
    'Quickened stride; Surge dilates time around foes.',
    'Time bends to your hand: attack speed +50%.',
  ],
};

export function emptyTiers(): Record<Affinity, number> {
  return { root: 0, echo: 0, flow: 0 };
}

export type EndingId = 'root' | 'echo' | 'flow' | 'balanced' | 'null';

/** Embrace this many Remembrances and the story bends toward the Null. */
export const NULL_ENDING_THRESHOLD = 4;

export function dominantEnding(tiers: Record<Affinity, number>): Exclude<EndingId, 'null'> {
  const { root, echo, flow } = tiers;
  const max = Math.max(root, echo, flow);
  const leaders = (['root', 'echo', 'flow'] as Affinity[]).filter((a) => tiers[a] === max);
  if (leaders.length !== 1) return 'balanced';
  return leaders[0];
}

const ENDINGS: Record<EndingId, { title: string; body: string }> = {
  null: {
    title: 'The Hollow Crown',
    body:
      'I took the silence into my hands and it did not take me; it crowned me. The grove is quiet now, a perfect, finished thing, and I am its keeper and its end. Somewhere beneath the soil a seed is still listening — and I have not decided whether to wake it.',
  },
  root: {
    title: 'The Mycelial Concord',
    body:
      'The grove I walk through is a single mind wearing a thousand bodies. When I think, the soil thinks with me; when the soil dreams, I wake with its dreams in my hands. There is no longer a line between the Keeper and the kept.',
  },
  echo: {
    title: 'The Library of Roots',
    body:
      'Nothing I have ever done has been lost. Every step took root, every root remembers, and the whole forest is a book that reads itself aloud to anyone who stands still long enough. I am its custodian, and its newest page.',
  },
  flow: {
    title: 'The Spiral Clock',
    body:
      'Time is not behind me or ahead of me. It is the river I am made of. I return to the seed knowing I will leave again, and that leaving and returning are the same motion seen from two banks.',
  },
  balanced: {
    title: 'The Wisdomkeeper',
    body:
      'Root, echo and current — I carried all three, and none was allowed to rule the others. The forest listens, the memory answers, the river keeps time; and in the quiet between them there is someone who is finally, simply, here.',
  },
};

export function endingFor(run: Pick<RunState, 'tiers' | 'nullPoints'>) {
  const id: EndingId = run.nullPoints >= NULL_ENDING_THRESHOLD ? 'null' : dominantEnding(run.tiers);
  return { id, ...ENDINGS[id] };
}

export interface ComposedStory {
  endingId: EndingId;
  title: string;
  paragraphs: string[];
  stats: string;
}

export function composeStory(run: RunState): ComposedStory {
  const ending = endingFor(run);
  const paragraphs: string[] = [OPENING_QUOTE];

  const choices = run.history.filter((h): h is HistoryEntry & { choice: NonNullable<HistoryEntry['choice']> } => !!h.choice);
  const lookup = choiceEpilogues();
  for (const h of choices) paragraphs.push(lookup[h.choice.id] ?? h.choice.title);

  if (run.deaths === 0) {
    paragraphs.push('The thread never broke. I walked every world without once having to be sown again.');
  } else if (run.deaths < 4) {
    paragraphs.push(
      `I was reseeded ${run.deaths} time${run.deaths > 1 ? 's' : ''}. Each time the soil remembered a little more of me than I did.`,
    );
  } else {
    paragraphs.push(`I fell and was reseeded ${run.deaths} times. The story learned to be patient with me, and I with it.`);
  }

  if (run.remembrances.length) {
    const e = run.nullPoints;
    const p = run.purityPoints;
    if (e === 0) paragraphs.push('Every Remembrance I woke, I purified. Not one was allowed to keep the silence it had carried.');
    else if (p === 0) paragraphs.push('Every Remembrance I woke, I let the Null speak through. I learned what the silence was asking — and answered it.');
    else paragraphs.push(`I purified ${p} Remembrance${p > 1 ? 's' : ''} and embraced ${e}. The Null and I know each other’s names now.`);
  }
  paragraphs.push(ending.body);
  if (run.cycle > 1) {
    paragraphs.push(`This is cycle ${run.cycle}. The story I carried back is not the one I left with — and that is how I know it is alive.`);
  }
  paragraphs.push(CLOSING_QUOTE);

  const stats = `Static purified ${run.kills} · Echoes grown ${run.echoes.length} · Reseeded ${run.deaths}× · Journey ${fmtTime(run.elapsed)}`;
  return { endingId: ending.id, title: ending.title, paragraphs, stats };
}

function choiceEpilogues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of STRATA) for (const c of s.choice?.choices ?? []) out[c.id] = c.epilogue;
  return out;
}

export function toLibraryEntry(run: RunState, story: ComposedStory): LibraryEntry {
  return {
    cycle: run.cycle,
    title: story.title,
    ending: story.endingId,
    text: story.paragraphs.join('\n\n'),
    date: new Date().toISOString().slice(0, 10),
  };
}

export const LORE_BARKS = {
  nullPhase2: ['FINISH.', 'BE COMPLETE.'],
  nullPhase3: ['STOP. REST. END.', 'A STORY THAT ENDS CANNOT BE LOST.'],
  nullDeath: ['…then I am… understood…'],
  nullEmbraced: ['You are already mine, Keeper. You let me in at every door.', 'Stay. Be finished. Be quiet.'],
};
