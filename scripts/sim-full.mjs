// Bot plays the whole game headlessly and reports per-stratum stats.
import { newSession } from './bot.mjs';
const skill = Number(process.argv[2] ?? 0.7);
const maxMin = Number(process.argv[3] ?? 40);
const { page, logs, close } = await newSession();
const res = await page.evaluate(({ skill, maxMin }) => {
  const g = window.__wk;
  g.debugGoto(0); g.debugStep(60);
  const report = []; let lastIdx = 0, t0 = 0, ended = false, lastDmg = 0, deathsSeen = 0;
  const t00 = performance.now();
  for (let t = 0; t < 30 * 60 * maxMin && !ended; t++) {
    const simT = t / 30;
    if (g.mode === 'play') window.__bot.think({ skill });
    if (g.mode === 'play') lastDmg = Math.max(lastDmg, g.stats.damageTaken);
    g.debugStep(1);
    if (g.mode === 'choice') {
      if (g.ui.isOpen('binary')) g.ui.binaryKey(Math.random() < 0.7 ? 'purify' : 'embrace');
      else g.ui.choiceKey(Math.floor(Math.random() * 3));
    }
    if (g.mode === 'dead') { g.debugStep(60); g.reseed(); deathsSeen++; }
    if (g.mode === 'ending') ended = true;
    // spend skill points like a player would
    if (g.run.skillPoints > 0 && t % 30 === 0) { const ids = ['deep_root','spore_mastery','resonant_memory','echo_strike','tidal_step','current_rider','verdant_mend']; for (const id of ids) { import_rank(g, id); } }
    const idx = g.run.stratumIndex;
    if (g.mode !== 'transition' && idx !== lastIdx) {
      report.push({ stratum: ['seedbed','river','canopy','mirror','return'][lastIdx], clearSec: +(simT - t0).toFixed(0), deaths: g.run.deaths - deathsSeen, dmg: Math.round(lastDmg), kills: g.run.history.at(-1)?.kills, lvl: g.run.level, null: g.run.nullPoints, items: g.run.inventory.length, bot: { ...window.__bot.stats } });
      lastIdx = idx; t0 = simT; lastDmg = 0;
    }
    if (t % (30 * 30) === 0 && t > 0 && g.mode === 'play' && simT - t0 > 600) { report.push({ stuckAt: g.debugState() }); break; }
  }
  return { report, simMin: +(g.run.elapsed / 60).toFixed(1), wallSec: +((performance.now() - t00) / 1000).toFixed(1), ended, mode: g.mode, state: g.debugState(), run: { level: g.run.level, kills: g.run.kills, deaths: g.run.deaths, null: g.run.nullPoints, purity: g.run.purityPoints, echoes: g.run.echoes.length, equipped: Object.values(g.run.equipped).map(i => i.rarity) } };
  function import_rank(g, id) { const s = g.run.skills; const SK = { deep_root: 1, spore_mastery: 2, resonant_memory: 3, echo_strike: 2, tidal_step: 3, current_rider: 2, verdant_mend: 2 }; const req = { spore_mastery: 'deep_root', echo_strike: 'resonant_memory', current_rider: 'tidal_step', verdant_mend: 'spore_mastery' }; if ((s[id] ?? 0) >= SK[id]) return; if (req[id] && (s[req[id]] ?? 0) < SK[req[id]]) return; if (g.run.skillPoints > 0) { s[id] = (s[id] ?? 0) + 1; g.run.skillPoints--; g.refreshDerived(); } }
}, { skill, maxMin });
console.log(JSON.stringify(res, null, 1));
console.log(logs.join('\n') || 'no console errors');
await close();
