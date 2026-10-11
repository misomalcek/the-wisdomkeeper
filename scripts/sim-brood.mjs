// Behaviour check for the second brood (dev server on :5199): spawns each kind near the hero, lets them act for a
// while with the hero in god mode, and reports every state each one passed through plus hits landed on the hero.
import { launch } from './harness.mjs';
const { browser, page, logs } = await launch({ width: 640, height: 360 });
await page.goto('http://127.0.0.1:5199/?debug&nolock&scale=0.5&noadapt&seed=7');
await page.waitForTimeout(2500);
await page.evaluate(() => { const g = window.__wk; g.debugGoto(0); g.god = true; });
await page.waitForTimeout(5000);
await page.evaluate(() => {
  const g = window.__wk;
  const p = g.player;
  g.enemies.forEach((e) => (e.dead = true));
  window.__track = [];
  const kinds = ['stalker', 'bloater', 'prism', 'lasher', 'mite'];
  kinds.forEach((k, i) => {
    const a = (i / kinds.length) * Math.PI * 2;
    const e = g.spawnEnemy(k, p.x + Math.cos(a) * 9, p.z + Math.sin(a) * 9, true);
    e.idle = false;
    window.__track.push({ e, states: new Set(), kind: k });
  });
  window.__hurts = 0;
  const orig = g.hurtPlayer.bind(g);
  g.hurtPlayer = (d, x, z) => { window.__hurts++; return orig(d, x, z); };
  const seen = window.__track;
  for (let i = 0; i < 30 * 30; i++) {
    g.debugStep(1);
    seen.forEach((t) => t.states.add(t.e.dead ? 'dead' : t.e.state));
  }
});
console.log(await page.evaluate(() => JSON.stringify({
  hurts: window.__hurts,
  kinds: window.__track.map((t) => `${t.kind}: ${[...t.states].join('>')}`),
  time: +window.__wk.time.toFixed(1),
  hp: Math.round(window.__wk.player.hp),
}, null, 1)));
console.log(logs.filter((l) => !/WebGPU is not available/.test(l)).join('\n') || 'no console errors');
await browser.close();
