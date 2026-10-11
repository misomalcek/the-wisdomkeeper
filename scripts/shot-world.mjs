// In-game world views with a pinned camera, HUD hidden (dev server on :5199):
//   node scripts/shot-world.mjs <stratum> <out.png> <x> <z> <height> <lookX> <lookY> <lookZ> [seed]
// Camera at (x, ground+height, z), looking at (lookX, ground+lookY, lookZ).
import { launch } from './harness.mjs';
const [idx = '0', out = 'shots/world.png', x = '0', z = '0', h = '2', lx = '10', ly = '0', lz = '10', seed = '7'] = process.argv.slice(2);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:5199/?debug&nolock&scale=1&noadapt&seed=${seed}${process.env.Q ? `&quality=${process.env.Q}` : ''}`);
await page.waitForTimeout(2500);
await page.evaluate((i) => { const g = window.__wk; g.debugGoto(Number(i)); g.god = true; }, idx);
await page.waitForTimeout(5000);
await page.evaluate(([x, z, h, lx, ly, lz]) => {
  const g = window.__wk;
  const t = g.world.terrain;
  const V = g.gfx.camera.position.constructor;
  g.debugAt(x - (lx - x) * 0.3, z - (lz - z) * 0.3);
  g.debugPhoto = { from: new V(x, t.heightAt(x, z) + h, z), to: new V(lx, t.heightAt(lx, lz) + ly, lz) };
}, [+x, +z, +h, +lx, +ly, +lz]);
await page.addStyleTag({ content: '#hud, #reticle, #prompt, #hint, #lockhint, .toast, #toast, #say, .say { visibility: hidden !important; }' });
await page.evaluate(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
for (let i = 0; i < 40; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => window.__frames) >= 8) break; }
await page.screenshot({ path: out, timeout: 120000 });
console.log(logs.filter((l) => !/WebGPU is not available/.test(l)).join('\n') || 'no console errors');
await browser.close();
