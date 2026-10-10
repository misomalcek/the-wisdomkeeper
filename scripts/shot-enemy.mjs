// Turntable strip of one enemy from the dev preview: node scripts/shot-enemy.mjs <kind> <out.png> [d] [y]
import { launch } from './harness.mjs';
import sharp from 'sharp';
const [kind = 'brute', out = 'shots/enemy.png', d = '6', y = '1.8'] = process.argv.slice(2);
const { browser, page } = await launch({ width: 560, height: 720 });
const tiles = [];
for (const [i, yaw] of [0, 0.9, 1.57, 3.14].entries()) {
  await page.goto(`http://127.0.0.1:5199/preview.html?enemy=${kind}&yaw=${yaw}&d=${d}&y=${y}`);
  await page.waitForTimeout(3500);
  tiles.push({ input: await page.screenshot(), left: i * 560, top: 0 });
}
await sharp({ create: { width: 2240, height: 720, channels: 3, background: '#000' } }).composite(tiles).png().toFile(out);
await browser.close();
