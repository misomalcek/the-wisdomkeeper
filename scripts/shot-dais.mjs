// Datastream Contact (side-mission dais) in game, HUD hidden: node scripts/shot-dais.mjs [out.png] [dist] [height] [angle] [seed]
import { launch } from './harness.mjs';
const [out = 'shots/dais.png', dist = '9', height = '3', angle = '0.8', seed = '7'] = process.argv.slice(2);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:5199/?debug&nolock&scale=1&noadapt&seed=${seed}`);
await page.waitForTimeout(2500);
await page.evaluate(() => { const g = window.__wk; g.debugGoto(3); g.god = true; });
await page.waitForTimeout(4000);
await page.evaluate(([d, h, a]) => {
  const g = window.__wk;
  const s = g.world.startPos;
  const x = s.x + 14, z = s.z + 10;
  g.missions.push({ id: 999, kind: 'contact', title: 'Echo in the Fog', brief: '', stratum: g.def.index, x, z, need: 1, have: 0, reward: 1, target: -1, state: 'active' });
  const V = s.constructor;
  const y = g.world.terrain.heightAt(x, z);
  g.debugAt(x + Math.sin(a) * (d + 12), z + Math.cos(a) * (d + 12));
  g.debugPhoto = { from: new V(x + Math.sin(a) * d, y + h, z + Math.cos(a) * d), to: new V(x, y + 3.2, z) };
}, [+dist, +height, +angle]);
await page.addStyleTag({ content: '#hud, #reticle, #prompt, #hint, #lockhint { visibility: hidden !important; }' });
await page.evaluate(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
for (let i = 0; i < 40; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => window.__frames) >= 6) break; }
await page.screenshot({ path: out, timeout: 120000 });
console.log(logs.filter((l) => !/WebGPU is not available/.test(l)).join('\n') || 'no console errors');
await browser.close();
