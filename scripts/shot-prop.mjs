// Two-angle shot of a set piece from the dev preview: node scripts/shot-prop.mjs <prop> <out.png> [level] [d] [y]
import { launch } from './harness.mjs';
import sharp from 'sharp';
const [prop = 'contact', out = 'shots/prop.png', level = '1', d = '11', y = '2'] = process.argv.slice(2);
const { browser, page } = await launch({ width: 800, height: 600 });
const tiles = [];
for (const [i, yaw] of [0.4, 2.2].entries()) {
  await page.goto(`http://127.0.0.1:5199/preview.html?prop=${prop}&level=${level}&yaw=${yaw}&d=${d}&y=${y}`);
  await page.waitForTimeout(5000);
  tiles.push({ input: await page.screenshot(), left: i * 800, top: 0 });
}
await sharp({ create: { width: 1600, height: 600, channels: 3, background: '#000' } }).composite(tiles).png().toFile(out);
await browser.close();
