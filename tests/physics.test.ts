import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, Physics, RAPIER, LAYER } from '../src/physics/physics';

beforeAll(async () => {
  await initPhysics();
});

/** Drop the hero at (x, y, z) and walk with constant velocity for `secs`. */
function walk(p: Physics, start: [number, number, number], v: [number, number], secs: number) {
  let [x, y, z] = start;
  let vy = 0;
  let grounded = false;
  const dt = 1 / 60;
  for (let i = 0; i < secs * 60; i++) {
    vy = grounded ? -1 : vy - 30 * dt;
    const r = p.char.move(x, y, z, v[0] * dt, vy * dt, v[1] * dt, dt);
    x = r.x;
    y = r.y;
    z = r.z;
    grounded = r.grounded;
    p.streamTerrain(x, z);
    p.step(dt);
  }
  return { x, y, z, grounded };
}

describe('Rapier character controller', () => {
  it('falls under custom gravity and lands on the heightfield', () => {
    const p = new Physics(() => 2);
    p.primeTerrain(0, 0);
    p.step(1 / 60);
    const r = walk(p, [0, 10, 0], [0, 0], 2);
    expect(r.grounded).toBe(true);
    expect(r.y).toBeGreaterThan(1.9);
    expect(r.y).toBeLessThan(2.2);
    p.dispose();
  });

  it('climbs a 30° slope but not a 60° wall', () => {
    const gentle = new Physics((x) => Math.max(0, x) * Math.tan((30 * Math.PI) / 180));
    gentle.primeTerrain(0, 0);
    gentle.step(1 / 60);
    const a = walk(gentle, [-3, 1, 0], [6, 0], 3);
    expect(a.x).toBeGreaterThan(8);
    gentle.dispose();

    const steep = new Physics((x) => Math.max(0, x) * Math.tan((62 * Math.PI) / 180));
    steep.primeTerrain(0, 0);
    steep.step(1 / 60);
    const b = walk(steep, [-3, 1, 0], [6, 0], 3);
    expect(b.x).toBeLessThan(2.5);
    steep.dispose();
  });

  it('stops at pillars and slides around them', () => {
    const p = new Physics(() => 0);
    p.primeTerrain(0, 0);
    p.addPillar(5, 0, 1);
    p.step(1 / 60);
    const r = walk(p, [0, 0.2, 0], [6, 0], 2);
    expect(r.x).toBeLessThan(5 - 1 - 0.3);
    p.dispose();
  });

  it('steps up small ledges and stands on fixed platforms', () => {
    const p = new Physics(() => 0);
    p.primeTerrain(0, 0);
    p.addFixed(RAPIER.ColliderDesc.cuboid(4, 0.2, 4).setTranslation(8, 0.2, 0), LAYER.platform);
    p.step(1 / 60);
    const r = walk(p, [0, 0.2, 0], [5, 0], 2.5);
    expect(r.x).toBeGreaterThan(6);
    expect(r.y).toBeGreaterThan(0.35);
    const g = p.groundBelow(8, 5, 0);
    expect(g.y).toBeCloseTo(0.4, 1);
    p.dispose();
  });

  it('pushes dynamic bodies out of the way', () => {
    const p = new Physics(() => 0);
    p.primeTerrain(0, 0);
    const body = p.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(3, 0.5, 0));
    p.world.createCollider(RAPIER.ColliderDesc.ball(0.45).setDensity(0.4).setCollisionGroups((LAYER.pod << 16) | 0xffff), body);
    p.step(1 / 60);
    walk(p, [0, 0.2, 0], [6, 0], 1.5);
    expect(body.translation().x).toBeGreaterThan(3.5);
    p.dispose();
  });
});
