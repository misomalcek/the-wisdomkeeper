import { serve, launch } from './harness.mjs';
import path from 'node:path';
const server = await serve(path.resolve('dist'));
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
const wait = (ms) => page.waitForTimeout(ms);
const shot = (n) => page.screenshot({ path: `shots/${n}.png` });
await page.goto('http://127.0.0.1:4173/?debug&nolock&scale=1&noadapt');
await wait(1200);
const hide = () => page.evaluate(() => { for (const id of ['banner']) document.getElementById(id).style.display = 'none'; window.__wk.ui.clearSay(); });
// canopy: fiend up close
await page.evaluate(() => { const g = window.__wk; g.debugGoto(2); g.god = true; });
await wait(2500); await hide();
await page.evaluate(() => {
  const g = window.__wk; const c = g.debugCamps.find(c => c.spec.kind === 'node');
  g.debugAt(c.spec.x - 18, c.spec.z); g.cam.yaw = Math.PI / 2; g.cam.pitch = 0.18;
  g.debugStep(2);
});
await wait(2500);
await shot('c-camp');
await page.evaluate(() => {
  const g = window.__wk; const e = g.enemies.find(e => e.kind === 'brute');
  g.debugAt(e.x - 7, e.z); g.cam.yaw = Math.PI / 2; g.cam.pitch = 0.2; e.idle = false; e.wake(g); g.debugStep(8);
});
await wait(2500);
await shot('c-fiend');
// melee swing
await page.evaluate(() => { const g = window.__wk; g.input.press('MouseLeft'); g.input.mouseLeft = true; g.debugStep(9); });
await wait(2000);
await shot('c-swing');
await page.evaluate(() => { window.__wk.input.mouseLeft = false; });
// root spike
await page.evaluate(() => { const g = window.__wk; g.player.res = 100; g.input.press('KeyQ'); g.debugStep(10); });
await wait(2000);
await shot('c-spike');
// shield + aim
await page.evaluate(() => { const g = window.__wk; g.player.res = 100; g.input.press('KeyF'); g.input.mouseRight = true; g.debugStep(20); });
await wait(2000);
await shot('c-shield-aim');
await page.evaluate(() => { window.__wk.input.mouseRight = false; });
// flight
await page.evaluate(() => { const g = window.__wk; g.player.res = 100; g.input.press('KeyV'); g.debugStep(10); g.input.press('Space'); g.debugStep(40); g.cam.pitch = 0.1; });
await wait(2500);
await shot('c-flight');
console.log(JSON.stringify(await page.evaluate(() => window.__wk.debugState())));
console.log(logs.join('\n') || 'no console errors');
await browser.close(); server.close();
