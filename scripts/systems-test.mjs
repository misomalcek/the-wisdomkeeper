import { newSession } from './bot.mjs';
let ok = true;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) ok = false; };
const fresh = async (stratum = 0) => {
  const s = await newSession();
  await s.page.evaluate((i) => { const g = window.__wk; g.debugGoto(i); g.debugStep(20); g.debugClearCamps(); g.debugStep(5); }, stratum);
  return s;
};

// ---- 1. melee combo and ranged fire both hurt enemies
{
  const { page, logs, close } = await fresh(0);
  const r = await page.evaluate(() => {
    const g = window.__wk, p = g.player;
    const spawnAhead = (d) => { const y = g.cam.yaw; g.spawnEnemy('mite', p.x + Math.sin(y) * d, p.z + Math.cos(y) * d, false); g.debugStep(45); return g.enemies.at(-1); };
    const out = {};
    g.god = true;
    let m = spawnAhead(3);
    m.hp = m.maxHp = 400; const h0 = m.hp;
    g.input.press('MouseLeft'); g.input.mouseLeft = true; g.debugStep(30); g.input.mouseLeft = false;
    out.melee = h0 - m.hp;
    m.dead = true; g.debugStep(2);
    m = spawnAhead(16); m.hp = m.maxHp = 400; m.idle = true; const h1 = m.hp;
    g.input.mouseRight = true;
    for (let i = 0; i < 40; i++) { window.__bot.aimAt(m.x, m.y, m.z); g.debugStep(1); }
    g.input.mouseRight = false;
    out.ranged = h1 - m.hp;
    return out;
  });
  check('melee combo damages a nearby enemy', r.melee > 0, `dmg=${r.melee.toFixed(0)}`);
  check('aimed spore bolts hit a distant enemy', r.ranged > 0, `dmg=${r.ranged.toFixed(0)}`);
  check('combat: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 2. locomotion modes: jump, flight (6-axis), landing, river levitation
{
  const { page, logs, close } = await fresh(1);
  const r = await page.evaluate(() => {
    const g = window.__wk, p = g.player, t = g.world.terrain;
    const out = {};
    p.res = 100;
    g.input.press('Space'); g.debugStep(8); out.jumped = p.y - t.heightAt(p.x, p.z) > 0.3;
    g.debugStep(60);
    g.input.press('KeyV'); g.debugStep(2); out.flight = p.mode; const fuel0 = p.fuel;
    g.cam.pitch = -0.25; g.input.touchMove.set(0, -1); const y0 = p.y; g.debugStep(60); out.climbed = p.y - y0;
    g.input.touchMove.set(0, 0);
    out.drain = fuel0 - p.fuel;
    g.input.press('KeyV'); g.debugStep(60); out.after = p.mode;
    g.debugStep(200);
    out.landed = p.mode === 'ground';
    // find the river and walk onto it
    let best = null; for (let z = -50; z < 50 && !best; z += 2) for (let x = -50; x < 50; x += 1) if (t.riverAt(x, z) > 0.95) { best = [x, z]; break; }
    g.debugAt(best[0], best[1] - 6); g.debugStep(10); g.input.touchMove.set(0, 0);
    g.debugAt(best[0], best[1]); g.debugStep(30);
    out.river = p.mode;
    out.hover = p.y - t.heightAt(p.x, p.z);
    return out;
  });
  check('jump leaves the ground', r.jumped);
  check('V ignites free flight', r.flight === 'flight', r.flight);
  check('flight follows the camera pitch (climbs)', r.climbed > 3, `climbed=${r.climbed.toFixed(1)}`);
  check('flight burns fuel (fiber, then Resonance)', r.drain > 3, `drain=${r.drain.toFixed(1)}`);
  check('V again drops out of flight', r.after !== 'flight', r.after);
  check('hero lands back on the ground', r.landed);
  check('the river of light levitates the hero', r.river === 'levitate' && r.hover > 0.8, `${r.river} h=${r.hover.toFixed(2)}`);
  check('locomotion: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 3. abilities
{
  const { page, logs, close } = await fresh(0);
  const r = await page.evaluate(() => {
    const g = window.__wk, p = g.player, y = g.cam.yaw;
    const out = {};
    p.res = 0; out.denied = !g.combat.castSpike(p);
    p.res = 100;
    g.spawnEnemy('brute', p.x + Math.sin(y) * 7, p.z + Math.cos(y) * 7, false); g.debugStep(45);
    const b = g.enemies.at(-1); b.idle = false; const h0 = b.hp;
    g.input.press('KeyQ'); g.debugStep(40);
    out.spike = h0 - b.hp; out.rooted = b.rootT > 0 || b.hp < h0;
    p.res = 100; g.input.press('KeyF'); g.debugStep(3); out.shield = p.shield;
    g.god = false; p.invuln = 0; const hp0 = p.hp; g.hurtPlayer(20, p.x + 1, p.z); out.shieldTook = hp0 === p.hp && p.shield < out.shield;
    p.res = 100; g.input.press('KeyR'); g.debugStep(5); out.surge = h0 - b.hp > out.spike;
    return out;
  });
  check('abilities refuse without Resonance', r.denied);
  check('Root Spike damages / roots', r.spike > 0 || r.rooted, `dmg=${r.spike.toFixed(0)}`);
  check('Fractal Shield absorbs damage before life', r.shield > 0 && r.shieldTook);
  check('Surge hits harder on top', r.surge);
  check('abilities: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 4. tier-III perks run and do their job
for (const aff of ['root', 'echo', 'flow']) {
  const { page, logs, close } = await fresh(2);
  const r = await page.evaluate((aff) => {
    const g = window.__wk, p = g.player, y = g.cam.yaw;
    g.run.tiers[aff] = 3; g.god = true; p.res = 100;
    for (let i = 0; i < 4; i++) g.plantEcho(p.x + (i - 1.5) * 5, p.z + 6, 'manual');
    g.spawnEnemy('brute', p.x + Math.sin(y) * 10, p.z + Math.cos(y) * 10, false);
    for (let i = 0; i < 4; i++) g.spawnEnemy('mite', p.x + 6 + i, p.z - 6, false);
    g.debugStep(50);
    for (const e of g.enemies) e.idle = false;
    const out = { slowed: 0, bolts: 0, sentinels: 0 };
    g.input.press('KeyR');
    for (let t = 0; t < 30 * 8; t++) {
      window.__bot.think({ skill: 0.8 });
      g.debugStep(1);
      out.bolts = Math.max(out.bolts, g.projectiles.count);
      if (g.enemies.some((e) => e.slowT > 0 && e.slowF < 0.5)) out.slowed++;
      out.sentinels = Math.max(out.sentinels, g.world.grove.echoes.filter((e) => e.sentinel).length);
    }
    out.kills = g.run.kills;
    return out;
  }, aff);
  check(`tier-3 ${aff}: no console errors`, logs.length === 0, logs.join(' | '));
  check(`tier-3 ${aff}: combat works`, r.kills > 0, JSON.stringify(r));
  if (aff === 'flow') check('flow: Surge dilates time', r.slowed > 0);
  if (aff === 'root') check('root: Surge plants Sentinel Blooms', r.sentinels > 0);
  await close();
}

// ---- 5. Embrace / Purify and the path diagram
{
  const { page, logs, close } = await fresh(0);
  const r = await page.evaluate(() => {
    const g = window.__wk, n = g.world.nodes[0];
    const out = {};
    const hpBefore = g.run.maxHp;
    n.setState('dormant'); g.completeNode(n);
    out.open = g.ui.isOpen('binary') && g.mode === 'choice';
    out.svg = document.getElementById('bin-path').innerHTML.includes('<svg');
    g.input.press('KeyB'); g.debugStep(2);
    out.purity = g.run.purityPoints; out.modeAfter = g.mode; out.maxHp = g.run.maxHp - hpBefore;
    return out;
  });
  check('Remembrance opens the Embrace / Purify choice with a pathway diagram', r.open && r.svg);
  check('pressing B purifies (life up, play resumes)', r.purity === 1 && r.modeAfter === 'play' && r.maxHp >= 10, JSON.stringify(r));
  const r2 = await page.evaluate(() => {
    const g = window.__wk, n = g.world.nodes[0];
    const sp0 = g.run.skillPoints;
    n.setState('dormant'); g.completeNode(n);
    g.input.press('KeyA'); g.debugStep(2);
    return { nullPoints: g.run.nullPoints, sp: g.run.skillPoints - sp0, rem: g.run.remembrances.slice() };
  });
  check('pressing A embraces the Null (+skill point, recorded)', r2.nullPoints === 1 && r2.sp >= 1 && r2.rem.join() === 'purify,embrace', JSON.stringify(r2));
  check('Remembrance flow: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 6. loot, inventory UI, skill tree, armor variants
{
  const { page, logs, close } = await fresh(0);
  const r = await page.evaluate(() => {
    const g = window.__wk, p = g.player, out = {};
    for (let i = 0; i < 12; i++) g.dropLoot(p.x, p.z, i % 2 ? 'cache' : 'fiend');
    g.debugStep(60);
    out.equipped = Object.keys(g.run.equipped).length; out.inv = g.run.inventory.length;
    g.input.press('Tab'); g.debugStep(2);
    out.open = g.ui.isOpen('inventory') && g.paused;
    const cell = document.querySelector('.cell');
    out.cells = document.querySelectorAll('.cell').length;
    if (cell) cell.click();
    out.detail = !!document.querySelector('.detail h4');
    const hp0 = g.derived.maxHp;
    const eq = document.querySelector('[data-act="equip"]'); if (eq) eq.click();
    out.statChanged = JSON.stringify(g.derived) !== JSON.stringify({});
    g.run.skillPoints = 2;
    document.querySelector('[data-tab="skills"]').click();
    document.querySelector('[data-sk="deep_root"]').click();
    out.skill = g.run.skills.deep_root; out.voidMul = g.derived.voidMul;
    g.run.purityPoints = 3;
    document.querySelector('[data-tab="skins"]').click();
    document.querySelector('[data-skin="verdant"]').click();
    out.skin = g.run.skin;
    g.input.press('Tab'); g.debugStep(2);
    out.closed = !g.ui.isOpen('inventory') && !g.paused;
    return out;
  });
  check('loot drops are collected into gear', r.equipped > 1 && r.inv + r.equipped >= 6, `equipped=${r.equipped} pack=${r.inv}`);
  check('Tab opens the inventory and pauses', r.open);
  check('backpack items select and show details', r.cells > 0 && r.detail);
  check('skill tree spends points and changes stats', r.skill === 1 && r.voidMul >= 1.15, `${r.skill} ${r.voidMul}`);
  check('unlocked armor variant can be worn', r.skin === 'verdant');
  check('Tab closes it and resumes', r.closed);
  check('inventory: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 7. pylon purge, spore cache, map fast travel
{
  const { page, logs, close } = await fresh(1);
  const r = await page.evaluate(() => {
    const g = window.__wk, p = g.player, w = g.world, out = {};
    const py = w.pylons[0], cache = w.caches[0];
    g.debugAt(cache.pos.x + 1.5, cache.pos.z); g.debugStep(5); g.input.press('KeyE'); g.debugStep(3);
    out.cache = cache.opened;
    g.debugAt(py.pos.x + 5, py.pos.z); g.debugStep(5); g.input.press('KeyE'); g.debugStep(3);
    out.active = py.state === 'active' && !!g.encounter;
    for (let t = 0; t < 30 * 120 && py.state !== 'done'; t++) { window.__bot.think({ skill: 0.9 }); g.debugStep(1); }
    out.done = py.state === 'done';
    // far away, then travel from the map
    const far = w.pylons[1] ?? py;
    far.setState('done');
    g.debugAt(w.startPos.x, w.startPos.z); g.debugClearCamps(); for (const e of g.enemies) e.dead = true; g.debugStep(5);
    out.before = Math.hypot(p.x - far.pos.x, p.z - far.pos.z);
    g.openOverlay('map'); out.mapOpen = g.ui.isOpen('map');
    g.mapClick(far.pos.x, far.pos.z);
    out.toast = document.getElementById('toast').textContent;
    window.__farIdx = w.pylons.indexOf(far);
    return out;
  });
  // the travel lands on a timer; under software GL a single frame can take longer than that, so wait for it
  await page.waitForFunction(() => !window.__wk.travelBusy, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => { const g = window.__wk, p = g.player, py = g.world.pylons[window.__farIdx]; return Math.hypot(p.x - py.pos.x, p.z - py.pos.z); });
  check('Spore Cache opens', r.cache);
  check('Pylon starts a purge event', r.active);
  check('Pylon purge completes', r.done);
  check('map opens', r.mapOpen);
  check('map click fast-travels to a purged Pylon', after < 12 && r.before > 30, `before=${r.before.toFixed(0)} after=${after.toFixed(0)} toast=${r.toast}`);
  check('open-world POIs: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 8. death -> reseed via the real UI
{
  const { page, logs, close } = await fresh(1);
  await page.evaluate(() => { const g = window.__wk; g.player.hp = 1; g.player.invuln = 0; g.hurtPlayer(500, g.player.x, g.player.z); });
  await page.evaluate(() => window.__wk.debugStep(90));
  check('death overlay appears', await page.evaluate(() => !document.getElementById('death').classList.contains('hidden')));
  await page.click('#btn-reseed');
  const st = await page.evaluate(() => ({ mode: window.__wk.mode, hp: window.__wk.player.hp, deaths: window.__wk.run.deaths }));
  check('reseed restores play', st.mode === 'play' && st.hp > 90 && st.deaths === 1, JSON.stringify(st));
  check('death flow: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 8b. edition hooks: the events the desktop edition listens to keep firing, and its travel gate holds
{
  const { page, logs, close } = await fresh(1);
  await page.evaluate(() => {
    const g = window.__wk, seen = (window.__seen = {});
    for (const e of ['stratum', 'tick', 'spawn', 'kill', 'hurt', 'death', 'respawn', 'echo', 'pylon', 'remembrance', 'save']) g.hooks.on(e, () => (seen[e] = (seen[e] ?? 0) + 1));
  });
  const r = await page.evaluate(() => {
    const g = window.__wk, p = g.player;
    g.debugStep(3);
    g.spawnEnemy('mite', p.x + 12, p.z, false);
    const e = g.enemies[g.enemies.length - 1];
    // a strain an edition breeds stays inside the clamp, and its size survives the mite's own jitter
    const hp0 = e.maxHp, sp0 = e.speed;
    e.applyStrain({ size: 2, vigor: 1.5, haste: 1.25, hue: 0.1 });
    g.debugStep(20);
    window.__strain = { hp: e.maxHp / hp0, speed: e.speed / sp0, size: e.body.scale.x, again: (e.applyStrain({ vigor: 1.5 }), e.maxHp / hp0) };
    e.dead = true; g.onEnemyKilled(e);
    g.plantEcho(p.x + 6, p.z + 6, 'manual');
    p.invuln = 0; g.hurtPlayer(5, p.x + 1, p.z);
    p.invuln = 0; p.hp = 1; g.hurtPlayer(500, p.x + 1, p.z);
    g.debugStep(90);
    return { ...window.__seen };
  });
  await page.click('#btn-reseed');
  const gate = await page.evaluate(() => {
    // the gate: a purged pylon the edition bars stays out of reach
    const g = window.__wk, py = g.world.pylons[0];
    py.setState('done');
    g.hooks.travelGate = (x, z) => (x === py.pos.x && z === py.pos.z ? 'barred' : null);
    g.openOverlay('map'); g.mapClick(py.pos.x, py.pos.z);
    const out = { toast: document.getElementById('toast').textContent, busy: g.travelBusy };
    g.hooks.travelGate = null;
    g.ui.hide('map');
    return out;
  });
  await page.evaluate(() => window.__wk.debugGoto(2));
  const after = await page.evaluate(() => window.__seen);
  check('hooks: tick, spawn, kill, echo, hurt and death fire', r.tick > 0 && r.spawn >= 1 && r.kill >= 1 && r.echo >= 1 && r.hurt >= 2 && r.death === 1, JSON.stringify(r));
  const strain = await page.evaluate(() => window.__strain);
  check('hooks: a bred strain is clamped and keeps its size', Math.abs(strain.hp * strain.speed - 1.45) < 0.12 && Math.abs(strain.speed - 1.25) < 1e-6 && strain.size > 1.1 && strain.again === strain.hp, JSON.stringify(strain));
  check('hooks: the travel gate bars a purged pylon', gate.toast === 'barred' && !gate.busy, `toast=${gate.toast}`);
  check('hooks: respawn, stratum and save fire', after.respawn >= 1 && after.stratum >= 1 && after.save >= 1, JSON.stringify(after));
  check('hooks: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 9. save -> reload -> continue (gear and skills persist)
{
  const { page, logs, close } = await fresh(1);
  await page.evaluate(() => { const g = window.__wk; g.run.tiers.flow = 1; g.run.level = 4; g.run.skills.tidal_step = 2; g.dropLoot(g.player.x, g.player.z, 'embrace'); g.debugStep(40); g.refreshDerived(); g.saveRun(); });
  const before = await page.evaluate(() => ({ n: Object.keys(window.__wk.run.equipped).length + window.__wk.run.inventory.length }));
  await page.reload();
  await page.waitForTimeout(900);
  check('continue button shown after reload', await page.evaluate(() => !document.getElementById('btn-continue').classList.contains('hidden')));
  await page.click('#btn-continue');
  await page.waitForTimeout(600);
  const st = await page.evaluate(() => ({ s: window.__wk.def.id, lvl: window.__wk.run.level, sk: window.__wk.run.skills.tidal_step, n: Object.keys(window.__wk.run.equipped).length + window.__wk.run.inventory.length, mode: window.__wk.mode }));
  check('continue restores stratum, level, skills and gear', st.s === 'river' && st.lvl === 4 && st.sk === 2 && st.n === before.n && st.mode === 'play', JSON.stringify(st));
  check('continue: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 9b. Act IV: Resonance Contacts wake the Construct; its pylons armour it; the breach exposes the core
{
  const { page, logs, close } = await fresh(3);
  const r = await page.evaluate(() => {
    const g = window.__wk, out = {};
    out.stratum = g.def.id;
    out.gateHidden = !g.world.gate.group.visible;
    out.missions = (g.run.missions || []).filter((m) => m.stratum === 3).length;
    g.god = true;
    g.debugCompleteNodes();
    const b = g.enemies.find((e) => e.kind === 'boss');
    out.construct = !!b && b.variant === 'construct';
    g.debugAt(b.x + 20, b.z); g.debugStep(90);
    out.awake = b.activated;
    out.armored = b.armored;
    const hp0 = b.hp; b.invuln = 0;
    g.combat.damageEnemy(b, 500, 1, 0, {});
    out.deflected = b.hp === hp0;
    for (const p of g.enemies.filter((e) => e.kind === 'pylon')) g.combat.damageEnemy(p, 99999, 1, 0, {});
    g.debugStep(3);
    out.breach = !b.armored;
    b.invuln = 0;
    g.combat.damageEnemy(b, 500, 1, 0, {});
    out.hurt = b.hp < hp0;
    g.debugKillBoss(); g.debugStep(10);
    out.gateOpen = g.world.gate.group.visible && g.world.gate.wantOpen;
    out.crystals = g.run.crystals;
    return out;
  });
  check('Act IV is the Veil of Void with its gate sealed', r.stratum === 'veil' && r.gateHidden, JSON.stringify(r));
  check('the Director offers side missions', r.missions > 0, `missions=${r.missions}`);
  check('linking every Contact wakes the Void-Infused Construct', r.construct && r.awake);
  check('data-river pylons armour the Construct', r.armored && r.deflected);
  check('destroying the pylons breaches its shell', r.breach && r.hurt);
  check('defeating it opens the Threshold', r.gateOpen && r.crystals > 0, `crystals=${r.crystals}`);
  check('Act IV: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 9c. Null-Sentry Drone: ability overload stuns it and doubles the damage
{
  const { page, logs, close } = await fresh(2);
  const r = await page.evaluate(() => {
    const g = window.__wk, p = g.player;
    g.spawnEnemy('drone', p.x + 12, p.z, false);
    const d = g.enemies.find((e) => e.kind === 'drone');
    g.debugStep(40);
    d.invuln = 0;
    const h0 = d.hp;
    g.combat.damageEnemy(d, 10, 1, 0, {});
    const plain = h0 - d.hp;
    const h1 = d.hp;
    g.combat.damageEnemy(d, 10, 1, 0, { ability: true });
    return { plain, overload: h1 - d.hp, state: d.state };
  });
  check('drone overload: abilities deal double and stun', r.overload >= r.plain * 1.9 && r.state === 'stun', JSON.stringify(r));
  check('drone: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}

// ---- 10. endings: Null ending + new cycle
{
  const { page, logs, close } = await fresh(5);
  await page.evaluate(() => { const g = window.__wk; g.run.nullPoints = 4; g.run.remembrances = ['embrace', 'embrace', 'embrace', 'embrace', 'purify']; const n = g.world.nodes[0]; g.debugAt(n.pos.x + 2, n.pos.z); g.input.press('KeyE'); g.debugStep(3); });
  await page.waitForTimeout(4300);
  await page.evaluate(() => window.__wk.debugStep(5));
  const title = await page.evaluate(() => document.getElementById('ending-title').textContent);
  check('the Null ending is composed', title === 'The Hollow Crown', title);
  const lib = await page.evaluate(() => JSON.parse(localStorage.getItem('wk.library.v1') || '[]').length);
  check('story saved to the library', lib === 1, `entries=${lib}`);
  await page.evaluate(() => document.getElementById('btn-newcycle').click());
  await page.waitForTimeout(400);
  check('new cycle increments', (await page.evaluate(() => window.__wk.run.cycle)) === 2);
  check('ending flow: no console errors', logs.length === 0, logs.join(' | '));
  await close();
}
console.log(ok ? '\nALL SYSTEM CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
