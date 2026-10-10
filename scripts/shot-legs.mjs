// Close-up turntable of the hero's legs and feet: node scripts/shot-legs.mjs [out] [look height] [distance] [pose]
import { launch } from './harness.mjs';
import sharp from 'sharp';
const [out = 'shots/legs.png', cy = '0.5', cd = '2.2', pose = '0'] = process.argv.slice(2);
const { browser, page } = await launch({ width: 520, height: 700 });
const tiles = [];
for (const [i, yaw] of [0, 1.57, 3.14, -0.6].entries()) {
  await page.goto(`http://127.0.0.1:5199/preview.html?solo=${pose}&yaw=${yaw}&cy=${cy}&cd=${cd}`);
  await page.waitForTimeout(3500);
  tiles.push({ input: await page.screenshot(), left: i * 520, top: 0 });
}
await sharp({ create: { width: 2080, height: 700, channels: 3, background: '#000' } }).composite(tiles).png().toFile(out);
await browser.close();
