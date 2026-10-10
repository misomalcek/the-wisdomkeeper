// Act IV Resonance Contact close-up in game, HUD hidden: node scripts/shot-contact.mjs [state] [out.png] [dist] [height] [angle] [seed]
import { launch } from './harness.mjs';
const [state = 'active', out = 'shots/contact.png', dist = '12', height = '4', angle = '0.6', seed = '7'] = process.argv.slice(2);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:5199/?debug&nolock&scale=1&noadapt&seed=${seed}`);
await page.waitForTimeout(2500);
await page.evaluate(() => { const g = window.__wk; g.debugGoto(3); g.god = true; });
await page.waitForTimeout(4000);
await page.evaluate(([s, d, h, a]) => {
  const g = window.__wk;
  const n = g.world.nodes[0];
  n.setState(s);
  const V = n.pos.constructor;
  const from = new V(n.pos.x + Math.sin(a) * d, n.pos.y + h, n.pos.z + Math.cos(a) * d);
  g.debugAt(n.pos.x + Math.sin(a) * (d + 3), n.pos.z + Math.cos(a) * (d + 3));
  g.debugPhoto = { from, to: new V(n.pos.x, n.pos.y + 2, n.pos.z) };
}, [state, +dist, +height, +angle]);
await page.addStyleTag({ content: '#hud, #reticle, #prompt, #hint, #lockhint, .toast, #toast, #say, .say { visibility: hidden !important; }' });
await page.evaluate(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
for (let i = 0; i < 40; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => window.__frames) >= 6) break; }
console.log('frames', await page.evaluate(() => window.__frames));
console.log(await page.evaluate(() => { const g = window.__wk; const n = g.world.nodes[0]; return JSON.stringify({ ko: g.world.wilds?.keepOut.length, wild: g.world.terrain.wildness(n.pos.x, n.pos.z), R: g.world.terrain.radius, n: n.pos.toArray().map(Math.round), th: Math.round(g.world.terrain.heightAt(n.pos.x, n.pos.z)), cam: g.gfx.camera.position.toArray().map(Math.round) }); }));
await page.screenshot({ path: out, timeout: 120000 });
console.log(logs.filter((l) => !/WebGPU is not available/.test(l)).join('\n') || 'no console errors');
await browser.close();
