// Visit the Wilds: node scripts/shot-wild.mjs <stratum> <x> <z> <name> [yaw] [pitch]
import { serve, launch } from './harness.mjs';
import path from 'node:path';
const server = await serve(path.resolve('dist'));
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
const [idx, x, z, name, yaw, pitch] = process.argv.slice(2);
await page.goto('http://127.0.0.1:4173/?debug&nolock&noadapt&scale=' + (process.env.SCALE || '1'));
await page.waitForTimeout(1500);
await page.evaluate((i) => { const g = window.__wk; g.debugGoto(Number(i)); g.god = true; }, idx);
await page.waitForTimeout(3000);
const t0 = Date.now();
const inPage = await page.evaluate(([x, z, yaw, pitch]) => {
  const g = window.__wk;
  const w = g.world;
  // x = "biome:N" jumps into biome N (0 meadow, 1 forest, 2 crystal, 3 blight)
  if (String(x).startsWith('biome:')) {
    const p = w.debugFindBiome(Number(String(x).slice(6)));
    if (p) { x = p.x; z = p.z; }
  }
  const a = performance.now();
  w.ground.prime(Number(x), Number(z));
  const b = performance.now();
  w.wilds?.prime(Number(x), Number(z));
  const c = performance.now();
  g.debugAt(Number(x), Number(z));
  const d = performance.now();
  if (yaw) g.cam.yaw = Number(yaw);
  if (pitch) g.cam.pitch = Number(pitch);
  g.cam.zoom = g.cam.zoomTarget = 1;
  g.cam.snap(g.player.cameraTarget);
  return { ground: b - a, wilds: c - b, all: d - c };
}, [x, z, yaw, pitch]);
console.log('prime ms', Date.now() - t0, JSON.stringify(inPage));
await page.waitForTimeout(4000);
await page.evaluate(() => document.querySelectorAll('.story, #story, .narration').forEach((e) => e.remove()));
await page.screenshot({ path: `shots/${name}.png` });
console.log(JSON.stringify(await page.evaluate(() => { const w = window.__wk.world; const i = window.__wk.gfx.renderer.info; return { chunks: w.ground.count, wild: w.wilds?.count, built: w.wilds?.built, calls: i.render.drawCalls, tris: i.render.triangles, fps: window.__wk.gfx.fps }; })));
console.log(logs.join('\n') || 'no console errors');
await browser.close(); server.close();
