import { serve, launch } from './harness.mjs';
import path from 'node:path';
const server = await serve(path.resolve('dist'));
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
const wait = (ms) => page.waitForTimeout(ms);
const shot = (n) => page.screenshot({ path: `shots/${n}.png` });
await page.goto('http://127.0.0.1:4173/?debug&nolock&scale=0.8&noadapt');
await wait(1200);
const hide = () => page.evaluate(() => { document.getElementById('banner').style.display = 'none'; window.__wk.ui.clearSay(); });
// river levitation
await page.evaluate(() => { const g = window.__wk; g.debugGoto(1); g.god = true; });
await wait(2500); await hide();
await page.evaluate(() => {
  const g = window.__wk; const t = g.world.terrain;
  // find a river point near the centre line
  let best = null; for (let z = -40; z < 40; z += 2) for (let x = -40; x < 40; x += 1) { if (t.riverAt(x, z) > 0.9) { best = [x, z]; break; } if (best) break; }
  g.debugAt(best[0], best[1]); g.cam.yaw = 0.4; g.cam.pitch = 0.2; g.debugStep(30);
  g.input.touchMove.set(0, -0.6); g.debugStep(20); g.input.touchMove.set(0, 0);
});
await wait(2500);
await shot('u-river');
console.log('river mode', JSON.stringify(await page.evaluate(() => window.__wk.debugState().playerMode)));
// boss arena
await page.evaluate(() => { const g = window.__wk; g.debugGoto(3); g.god = true; });
await wait(2500); await hide();
await page.evaluate(() => { const g = window.__wk; g.debugAt(0, 28); g.cam.yaw = Math.PI; g.cam.pitch = 0.12; g.debugStep(120); });
await wait(2500);
await shot('u-boss');
// binary choice
await page.evaluate(() => { const g = window.__wk; g.debugGoto(0); });
await wait(1500);
await page.evaluate(() => { const g = window.__wk; g.run.remembrances.push('purify','embrace'); g.run.level = 6; g.run.skillPoints = 3; const n = g.world.nodes[0]; g.debugClearCamps(); n.setState('dormant'); g.completeNode(n); });
await wait(1500);
await shot('u-binary');
await page.evaluate(() => window.__wk.ui.binaryKey('embrace'));
await wait(600);
// give loot
await page.evaluate(() => {
  const g = window.__wk;
  for (let i = 0; i < 10; i++) g.dropLoot(g.player.x, g.player.z, i % 3 ? 'cache' : 'embrace');
  g.debugStep(40);
});
await page.evaluate(() => { const g = window.__wk; g.run.skills.deep_root = 1; g.run.skills.resonant_memory = 2; g.run.skills.tidal_step = 1; g.run.purityPoints = 3; g.openOverlay('inventory'); });
await wait(1500);
await shot('u-inv-gear');
await page.click('[data-tab="skills"]'); await wait(500); await shot('u-inv-skills');
await page.click('[data-tab="stats"]'); await wait(400); await shot('u-inv-stats');
await page.click('[data-tab="skins"]'); await wait(800); await shot('u-inv-skins');
await page.keyboard.press('Escape'); await wait(300);
await page.evaluate(() => window.__wk.openOverlay('map'));
await wait(800); await shot('u-map');
console.log(logs.join('\n') || 'no console errors');
await browser.close(); server.close();
