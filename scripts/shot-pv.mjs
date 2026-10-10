// Screenshot the dev preview with a query: node scripts/shot-pv.mjs "<query>" <out.png> [w] [h]
import { launch } from './harness.mjs';
const [q = 'fiend', out = 'shots/pv.png', w = '1280', h = '720'] = process.argv.slice(2);
const { browser, page } = await launch({ width: +w, height: +h });
await page.goto(`http://127.0.0.1:5199/preview.html?${q}`);
await page.waitForTimeout(4000);
await page.screenshot({ path: out });
await browser.close();
