// Procedural QA shots: node scripts/shot-proc.mjs <stratum> <isle|biome:N|x,z> <name> [yaw] [pitch] [zoom]
// env: Q quality tier, PF flag spec (?pf=), SEED, PULSE=1 fires purification rings around the hero before the shot
import { serve, launch } from './harness.mjs';
import path from 'node:path';
const server = await serve(path.resolve('dist'));
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
const [idx, where, name, yaw, pitch, zoom] = process.argv.slice(2);
const q = [`seed=${process.env.SEED || 424242}`];
if (process.env.Q) q.push(`quality=${process.env.Q}`);
if (process.env.PF !== undefined) q.push(`pf=${process.env.PF}`);
await page.goto(`http://127.0.0.1:4173/?debug&nolock&noadapt&scale=1&${q.join('&')}`);
await page.waitForTimeout(1500);
await page.evaluate((i) => { const g = window.__wk; g.debugGoto(Number(i)); g.god = true; }, idx);
await page.waitForTimeout(Number(process.env.SETTLE || 6000));
const info = await page.evaluate(([where, yaw, pitch, zoom]) => {
  const g = window.__wk;
  const w = g.world;
  let x = 0, z = 0, note = '';
  if (where === 'isle') {
    // nearest Orbit Isle to the origin; stand on its rim looking in over the lake
    const isles = w.terrain.wild?.isles;
    let best = null;
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      const s = isles?.isleAt(i, j);
      if (s && (!best || Math.hypot(s.x, s.z) < Math.hypot(best.x, best.z))) best = s;
    }
    if (!best) return { error: 'no isle' };
    const o = { sd: 0, mask: 0, isle: null };
    // walk in from outside along the line to the centre until we reach the boundary
    const dx = -best.x / Math.hypot(best.x, best.z), dz = -best.z / Math.hypot(best.x, best.z);
    for (let r = best.R * 1.2; r > 0; r -= 2) {
      x = best.x - dx * r; z = best.z - dz * r;
      isles.sample(x, z, o);
      if (o.sd < 30) break;
    }
    x -= dx * 18; z -= dz * 18;
    note = `isle at ${best.x.toFixed(0)},${best.z.toFixed(0)} R ${best.R.toFixed(0)} c ${best.c.map((v) => v.toFixed(3))}`;
    if (!yaw) yaw = String(Math.atan2(dx, dz));
  } else if (where.startsWith('biome:')) {
    const p = w.debugFindBiome(Number(where.slice(6)));
    if (p) { x = p.x; z = p.z; }
  } else [x, z] = where.split(',').map(Number);
  w.prime(x, z);
  g.debugAt(x, z);
  if (yaw) g.cam.yaw = Number(yaw);
  if (pitch) g.cam.pitch = Number(pitch);
  g.cam.zoom = g.cam.zoomTarget = zoom ? Number(zoom) : 1;
  g.cam.snap(g.player.cameraTarget);
  // AIR=height: look down at the hero's spot from above and behind
  return { x, z, note, genome: w.genome, yaw: g.cam.yaw };
}, [where, yaw, pitch, zoom]);
console.log(JSON.stringify(info));
if (process.env.AIR) {
  await page.evaluate(([h, yaw]) => {
    const g = window.__wk;
    const p = g.player;
    const y = g.world.terrain.heightAt(p.x, p.z);
    g.debugView = [p.x - Math.sin(yaw) * h * 0.9, y + h, p.z - Math.cos(yaw) * h * 0.9, p.x + Math.sin(yaw) * h * 0.4, y, p.z + Math.cos(yaw) * h * 0.4];
  }, [Number(process.env.AIR), info.yaw]);
}
if (process.env.PULSE) {
  await page.waitForTimeout(5000); // software GL draws ~1 frame/s: let the new spot render first
  // four purifications a few metres ahead, then 2.5 s of simulated time so the rings run out and meet
  await page.evaluate(() => {
    const g = window.__wk;
    for (let k = 0; k < 4; k++) g.world.purify(g.player.x + (k - 1.5) * 12 + Math.sin(g.cam.yaw) * 20, g.player.z + Math.cos(g.cam.yaw) * 20 + (k % 2) * 8, 4);
    g.debugStep(75);
  });
  await page.waitForTimeout(2500);
} else await page.waitForTimeout(4000);
await page.evaluate(() => document.querySelectorAll('.story, #story, .narration').forEach((e) => e.remove()));
await page.screenshot({ path: `shots/${name}.png` });
console.log(JSON.stringify(await page.evaluate(() => { const w = window.__wk.world; const i = window.__wk.gfx.renderer.info; const p = window.__wk.player; return { pos: [p.x | 0, p.z | 0], mode: window.__wk.mode, chunks: w.ground.count, calls: i.render.drawCalls, tris: i.render.triangles, fps: window.__wk.gfx.fps, living: w.livingAt(p.x, p.z) }; })));
console.log(logs.join('\n') || 'no console errors');
await browser.close(); server.close();
