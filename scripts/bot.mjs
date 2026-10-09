// Headless third-person bot + session helper. Drives the real game logic through Game.debugStep().
import { serve, launch } from './harness.mjs';
import path from 'node:path';

export const BOT_SRC = `
(() => {
  const g = window.__wk;
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  let lastPos = [0, 0, 0], stuckT = 0, tick = 0, strafe = 1, strafeT = 0, landing = false;
  window.__bot = {
    stats: { melee: 0, ranged: 0, abilities: 0, stuck: 0, flights: 0 },
    aimAt(x, y, z) {
      const c = g.gfx.camera.position;
      const dx = x - c.x, dy = y - c.y, dz = z - c.z;
      g.cam.yaw = Math.atan2(dx, dz);
      g.cam.pitch = clampN(Math.atan2(-dy, Math.hypot(dx, dz)), -0.5, 1.15);
    },
    /** translate a world-space direction into camera-relative stick input */
    moveWorld(dx, dz, mag = 1) {
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const fx = Math.sin(g.cam.yaw), fz = Math.cos(g.cam.yaw), rx = -Math.cos(g.cam.yaw), rz = Math.sin(g.cam.yaw);
      g.input.touchMove.set((dx * rx + dz * rz) * mag, -(dx * fx + dz * fz) * mag);
    },
    /** one decision; opts.skill 0..1 */
    think(opts = {}) {
      tick++;
      const p = g.player, inp = g.input, D = g.derived;
      inp.lastDevice = 'touch'; // no pointer lock needed
      inp.touchMove.set(0, 0); inp.mouseLeft = false; inp.mouseRight = false;
      const sk = opts.skill ?? 0.8;
      const goalOf = () => {
        const obj = g.objectivePoint();
        return obj;
      };
      // targets: fight what is close; ignore far-off wanderers when travelling
      const gl0 = g.objectivePoint();
      const gd0 = gl0 ? Math.hypot(gl0.x - p.x, gl0.z - p.z) : 0;
      const reach = gd0 > 50 ? 16 : 28;
      let tgt = null, td = 1e9, near = 0, nearClose = 0;
      for (const e of g.enemies) {
        if (e.dead || e.spawnT < 0.5) continue;
        const d = Math.hypot(e.x - p.x, e.z - p.z);
        if (d < 15) near++;
        if (d < 10) nearClose++;
        if (d > reach) continue;
        if (d < td) { td = d; tgt = e; }
      }
      const enc = g.encounter;
      // stuck detection
      if (tick % 20 === 0) {
        const moved = Math.hypot(p.x - lastPos[0], p.z - lastPos[2]);
        stuckT = moved < 1.2 && !tgt ? stuckT + 1 : 0;
        lastPos = [p.x, p.y, p.z];
      }
      // abilities
      if (near >= 2 && p.res >= 25 && g.combat.cd.spike <= 0 && tgt && td < 16) { inp.press('KeyQ'); this.stats.abilities++; this.aimAt(tgt.x, tgt.y, tgt.z); }
      if (p.hp < D.maxHp * 0.55 && p.res >= 35 && g.combat.cd.shield <= 0 && p.shield <= 0) { inp.press('KeyF'); this.stats.abilities++; }
      if (nearClose >= 3 && p.res >= 75 && g.combat.cd.surge <= 0) { inp.press('KeyR'); this.stats.abilities++; }

      if (tgt) {
        const dx = tgt.x - p.x, dz = tgt.z - p.z;
        const melee = td < 6 && (tgt.kind === 'mite' || tgt.kind === 'brute' || td < 4);
        this.aimAt(tgt.x + (Math.random() - 0.5) * (1 - sk) * 3, tgt.y, tgt.z);
        const toward = Math.atan2(dx, dz);
        const f = { x: Math.sin(g.cam.yaw), z: Math.cos(g.cam.yaw) };
        const r = { x: -Math.cos(g.cam.yaw), z: Math.sin(g.cam.yaw) };
        void toward; void f; void r;
        strafeT--; if (strafeT <= 0) { strafe = Math.random() < 0.5 ? -1 : 1; strafeT = 25 + Math.floor(Math.random() * 30); }
        if (melee) {
          inp.mouseLeft = true; if (tick % 8 === 0) inp.press('MouseLeft');
          inp.touchMove.set(strafe * 0.3, td > 2.6 ? -1 : 0.3); this.stats.melee++;
        } else {
          inp.mouseRight = true; this.stats.ranged++;
          const keep = tgt.kind === 'brute' || tgt.kind === 'boss' ? 14 : 11;
          const back = td < keep - 3 ? 1 : td > keep + 5 ? -0.8 : 0;
          inp.touchMove.set(strafe * 0.8, back);
        }
        // hold the ring: an encounter only progresses while you stand inside it
        if (enc) { const ax = enc.anchor.pos.x - p.x, az = enc.anchor.pos.z - p.z; if (Math.hypot(ax, az) > enc.anchor.zoneRadius * 0.75) this.moveWorld(ax, az); }
        if (td < 4.5 && p.dashCD <= 0 && Math.random() < 0.18 * sk) inp.press('ShiftLeft');
        if (p.mode === 'flight') { inp.press('KeyV'); }
        return;
      }
      // objective travel
      let goal = enc ? { x: enc.anchor.pos.x, z: enc.anchor.pos.z } : goalOf();
      if (!goal) goal = { x: 0, z: 0 };
      const dx = goal.x - p.x, dz = goal.z - p.z, d = Math.hypot(dx, dz);
      const gh = g.world.terrain.heightAt(goal.x, goal.z);
      if (enc) { if (d > 6) { this.aimAt(goal.x, gh + 1.5, goal.z); inp.touchMove.set(0, -1); } return; }
      if (d < 7) { if (tick % 6 === 0) inp.press('KeyE'); if (p.mode === 'flight') inp.press('KeyV'); landing = false; return; }
      // long haul: fly, short hop: walk
      if (d > 30 && p.res > 30 && p.mode !== 'flight' && stuckT === 0) { inp.press('KeyV'); this.stats.flights++; }
      if (p.mode === 'flight') {
        const wantY = gh + (d > 25 ? 14 : 4);
        this.aimAt(goal.x, d > 25 ? Math.max(wantY, p.y + 1) : gh + 2, goal.z);
        g.cam.pitch = clampN(g.cam.pitch, -0.3, 0.45);
        inp.touchMove.set(0, -1);
        if (d < 22 || p.res < 8) { inp.press('KeyV'); }
        return;
      }
      this.aimAt(goal.x, gh + 1.5, goal.z);
      g.cam.pitch = 0.2;
      inp.touchMove.set(stuckT > 1 ? 0.7 : 0, -1);
      if (stuckT > 0 && tick % 10 === 0) { inp.press('Space'); this.stats.stuck++; }
      if (stuckT > 3) { g.cam.yaw += 1.2; stuckT = 1; }
    },
  };
})();
`;

export async function newSession(query = '?debug&nolock&scale=0.4&nobloom', size = { width: 640, height: 360 }) {
  const server = await serve(path.resolve('dist'));
  const { browser, page, logs } = await launch(size);
  await page.goto('http://127.0.0.1:4173/' + query);
  await page.waitForTimeout(700);
  await page.evaluate(BOT_SRC);
  return { server, browser, page, logs, close: async () => { await browser.close(); server.close(); } };
}
