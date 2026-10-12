// Fixed-seed flight benchmark (P1-H). Flies the hero in a straight line through the Wilds at boosted-flight speed
// (40 m/s, advanced per frame so slow software rendering does not change the work per metre) and reports frame and
// streaming costs from the in-game profiler.
//   node scripts/bench-route.mjs [quality=low] [pf=] [frames=900] [out.json]      (RENDER=1 to draw frames too)
// Headless Chromium only has SwiftShader (software GL), so by default the route skips rendering: frame times then
// measure the main thread alone (simulation + streaming), which is what P1 changes. Sections ground / wilds /
// physics are the streaming costs.
import { serve, launch } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const [Q = 'low', PF = '', FRAMES = '900', OUT] = process.argv.slice(2);
const RENDER = process.env.RENDER === '1';
const server = await serve(path.resolve('dist'));
const { browser, page, logs } = await launch({ width: 640, height: 360 });
const url = `http://127.0.0.1:4173/?debug&nolock&noadapt&perf&seed=424242&quality=${Q}${PF ? `&pf=${PF}` : ''}`;
await page.goto(url);
await page.waitForTimeout(1500);
await page.evaluate(() => { const g = window.__wk; g.debugGoto(0); g.god = true; });
await page.waitForTimeout(3000);
const res = await page.evaluate(async ([frames, RENDER]) => {
  const g = window.__wk;
  const w = g.world;
  const R = w.radius;
  let x = R * 2.2, z = -R * 1.2;
  const dir = [0.8, 0.6];
  g.debugAt(x, z);
  await new Promise((r) => setTimeout(r, 1500));
  // the in-game profiler lives on the module; reach it through the debug handle
  const perf = g.debugPerf;
  g.debugNoRender = !RENDER;
  perf.reset();
  const t0 = performance.now();
  await new Promise((done) => {
    let f = 0;
    const step = () => {
      x += dir[0] * 0.667;
      z += dir[1] * 0.667;
      g.player.place(x, w.terrain.heightAt(x, z) + 12, z);
      if (++f >= frames) return done();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const rep = perf.report();
  return { ...rep, seconds: (performance.now() - t0) / 1000, metres: frames * 0.667, chunksBuilt: w.ground.built, wildBuilt: w.wilds?.built, flags: g.debugFlags() };
}, [Number(FRAMES), RENDER]);
const report = { quality: Q, pf: PF || 'all', ...res, errors: logs };
console.log(JSON.stringify(report, null, 1));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
await browser.close();
server.close();
