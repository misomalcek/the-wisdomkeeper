// Turntable close-ups of one hero pose from the dev preview: node scripts/shot-turntable.mjs [pose] [name]
import { launch } from './harness.mjs';
const pose = process.argv[2] ?? '0';
const name = process.argv[3] ?? 'turn';
const { browser, page } = await launch({ width: 520, height: 700 });
for (const [i, yaw] of [0, 1.57, 3.14, -0.6].entries()) {
  await page.goto(`http://127.0.0.1:5199/preview.html?solo=${pose}&yaw=${yaw}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `shots/${name}-${i}.png` });
}
await browser.close();
