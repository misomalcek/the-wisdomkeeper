// The hero in game from a pinned camera, HUD hidden: node scripts/shot-hero.mjs [out.png] [stratum] [dist] [height] [look] [angle] [seed]
import { launch } from './harness.mjs';
const [out = 'shots/hero-game.png', stratum = '3', dist = '3.2', height = '1.2', look = '0.9', angle = '2.6', seed = '7'] = process.argv.slice(2);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:5199/?debug&nolock&scale=1&noadapt&seed=${seed}`);
await page.waitForTimeout(2500);
await page.evaluate((s) => { const g = window.__wk; g.debugGoto(s); g.god = true; }, +stratum);
await page.waitForTimeout(5000);
await page.evaluate(([d, h, l, a]) => {
  const g = window.__wk;
  const p = g.player;
  const V = g.gfx.camera.position.constructor;
  const yaw = p.yaw + a;
  g.debugPhoto = { from: new V(p.x + Math.sin(yaw) * d, p.y + h, p.z + Math.cos(yaw) * d), to: new V(p.x, p.y + l, p.z) };
}, [+dist, +height, +look, +angle]);
await page.addStyleTag({ content: '#hud, #reticle, #prompt, #hint, #lockhint { visibility: hidden !important; }' });
await page.evaluate(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
for (let i = 0; i < 40; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => window.__frames) >= 6) break; }
await page.screenshot({ path: out, timeout: 120000 });
console.log(logs.filter((l) => !/WebGPU is not available/.test(l)).join('\n') || 'no console errors');
await browser.close();
