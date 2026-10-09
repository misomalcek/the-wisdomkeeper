// Screenshot a stratum with extra URL flags: node scripts/shot-q.mjs <stratum> <name> [query]
import { serve, launch } from './harness.mjs';
import path from 'node:path';
const server = await serve(path.resolve('dist'));
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
const idx = Number(process.argv[2] ?? 0);
const name = process.argv[3] ?? 'q';
const extra = process.argv[4] ?? '';
await page.goto(`http://127.0.0.1:4173/?debug&nolock&scale=1&noadapt${extra}`);
await page.waitForTimeout(1500);
await page.evaluate((i) => { const g = window.__wk; g.debugGoto(i); g.god = true; }, idx);
await page.waitForTimeout(5000);
await page.evaluate(() => document.querySelectorAll('.story, #story, .narration').forEach((e) => e.remove()));
await page.screenshot({ path: `shots/${name}.png` });
console.log(logs.join('\n') || 'no console errors');
await browser.close(); server.close();
