import { newSession } from './bot.mjs';
const { page, logs, close } = await newSession();
const r = await page.evaluate(() => {
  const g = window.__wk; g.debugGoto(2); g.debugStep(30); g.god = true;
  const c = g.debugCamps.find(c => c.spec.kind === 'node'); g.debugAt(c.spec.x - 14, c.spec.z);
  for (const e of g.enemies) e.idle = false; // everyone attacks at once
  for (let i = 0; i < 20; i++) g.spawnEnemy('mite', g.player.x + 10 + i, g.player.z + 5, false);
  g.debugStep(60);
  const times = [];
  for (let t = 0; t < 600; t++) {
    window.__bot.think({ skill: 0.8 });
    const a = performance.now(); g.debugStep(1); times.push(performance.now() - a);
  }
  times.sort((a, b) => a - b);
  return { enemies: g.enemies.length, p50: +times[300].toFixed(2), p95: +times[570].toFixed(2), max: +times[599].toFixed(2), bolts: g.projectiles.count };
});
console.log(JSON.stringify(r));
console.log(logs.join('\n') || 'no console errors');
await close();
