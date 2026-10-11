// The second brood in game (dev server on :5199): node scripts/shot-brood.mjs [out.png] [stratum] [elite]
// Spawns a Lattice Stalker, Spore Bloater, Fractal Prism (sheltering a Fiend) and Root Lasher in front of the hero.
import { launch } from './harness.mjs';
const [out = 'shots/brood.png', idx = '2', elite = ''] = process.argv.slice(2);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
await page.goto('http://127.0.0.1:5199/?debug&nolock&scale=1&noadapt&seed=7');
await page.waitForTimeout(2500);
await page.evaluate((i) => { const g = window.__wk; g.debugGoto(Number(i)); g.god = true; }, idx);
await page.waitForTimeout(5000);
const info = await page.evaluate((elite) => {
  const g = window.__wk;
  const p = g.player;
  g.enemies.forEach((e) => (e.dead = true));
  g.def.elite = elite ? 1 : 0;
  const mk = (k, dx, dz) => g.spawnEnemy(k, p.x + dx, p.z + dz, true);
  const list = [mk('stalker', -5, 12), mk('bloater', 3, 10), mk('brute', 7, 17), mk('prism', 4, 22), mk('lasher', -9, 18)];
  for (const e of list) { e.idle = false; e.spawnT = 1; e.group.scale.setScalar(1); }
  g.enemyTimeScale = 0;
  const V = g.gfx.camera.position.constructor;
  const t = g.world.terrain;
  g.debugPhoto = { from: new V(p.x + 2, t.heightAt(p.x, p.z) + 6.5, p.z - 4), to: new V(p.x, t.heightAt(p.x, p.z + 15) + 2.2, p.z + 15) };
  return list.map((e) => e.kind + (e.elite ? '*' : ''));
}, elite);
console.log(info.join(' '));
await page.addStyleTag({ content: '#hud, #reticle, #prompt, #hint, #lockhint, .toast, #toast, #say, .say { visibility: hidden !important; }' });
await page.evaluate(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
for (let i = 0; i < 40; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => window.__frames) >= 10) break; }
await page.screenshot({ path: out, timeout: 120000 });
console.log(logs.filter((l) => !/WebGPU is not available/.test(l)).join('\n') || 'no console errors');
await browser.close();
