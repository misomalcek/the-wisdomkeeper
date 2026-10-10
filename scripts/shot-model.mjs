// Turntable shots of a GLB through the dev model page: node scripts/shot-model.mjs <src> <name> [y] [d]
import { launch } from './harness.mjs';
const [src = '/raw/hero-tripo.glb', name = 'model', y = '1.05', d = '4.2'] = process.argv.slice(2);
const { browser, page } = await launch({ width: 480, height: 720 });
for (const [i, yaw] of [0, 1.57, 3.14, -0.7].entries()) {
  await page.goto(`http://127.0.0.1:5199/model.html?src=${src}&yaw=${yaw}&y=${y}&d=${d}`);
  await page.waitForFunction(() => window.info, null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  if (i === 0) console.log(JSON.stringify(await page.evaluate(() => window.info)));
  await page.screenshot({ path: `shots/${name}-${i}.png` });
}
await browser.close();
