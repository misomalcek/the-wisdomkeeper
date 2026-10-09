import { launch } from './harness.mjs';
const { browser, page, logs } = await launch({ width: 1500, height: 700 });
for (const g of [0, 1]) {
  await page.goto(`http://127.0.0.1:5199/preview.html?g=${g}`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `shots/hero-g${g}.png` });
}
console.log(logs.filter(l => !l.includes('404')).join('\n') || 'no console errors');
await browser.close();
