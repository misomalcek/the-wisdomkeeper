import { serve, launch } from './harness.mjs';
import path from 'node:path';
const server = await serve(path.resolve('dist'));
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
const wait = (ms) => page.waitForTimeout(ms);
await page.goto('http://127.0.0.1:4173/?debug&nolock&scale=1&noadapt');
await wait(1000);
for (const i of [0, 1, 2, 4]) {
  await page.evaluate((i) => { const g = window.__wk; g.debugGoto(i); g.god = true; }, i);
  await wait(1800);
  await page.evaluate(() => { document.getElementById('banner').style.display = 'none'; const g = window.__wk; g.ui.clearSay(); g.debugClearCamps(); g.cam.pitch = -0.12; g.cam.yaw = g.cam.yaw + 0.25; g.debugStep(30); });
  await wait(2500);
  await page.screenshot({ path: `shots/h-${i}.png` });
}
console.log(logs.join('\n') || 'no console errors');
await browser.close(); server.close();
