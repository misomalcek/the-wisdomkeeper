import { newSession } from './bot.mjs';
const { page, logs, close } = await newSession();
const r = await page.evaluate(async () => {
  const g = window.__wk; g.audio.init();
  await new Promise((r) => setTimeout(r, 400));
  const names = ['shoot','echo','hit','kill','hurt','dash','pickup','node','surge','choice','click','gate','boss','plant','spit','ready','bossdie','warn'];
  const errs = [];
  for (const n of names) { try { g.audio.sfx(n); g.audio.sfx(n, 0.6); } catch (e) { errs.push(n + ': ' + e.message); } await new Promise((r) => setTimeout(r, 120)); }
  for (const mood of [0,1,2,3,4]) { try { g.debugGoto(mood); g.audio.setIntensity(mood / 4); } catch (e) { errs.push('mood ' + mood + ': ' + e.message); } await new Promise((r) => setTimeout(r, 700)); }
  g.audio.toggleMute(); g.audio.toggleMute(); g.audio.setVolume(0.3);
  const ctx = g.audio.ctx;
  return { errs, state: ctx ? ctx.state : 'none', time: ctx ? +ctx.currentTime.toFixed(2) : 0 };
});
console.log(JSON.stringify(r));
console.log(logs.join('\n') || 'no console errors');
await close();
