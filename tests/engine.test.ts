import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Colliders } from '../src/world/colliders';
import { angleDiff, clamp, damp } from '../src/util/math';

describe('Colliders', () => {
  it('pushes a body out of a circle along the contact normal', () => {
    const c = new Colliders();
    c.add(10, 10, 2);
    const p = { x: 11, z: 10 };
    c.resolve(p, 0.5);
    expect(Math.hypot(p.x - 10, p.z - 10)).toBeCloseTo(2.5, 5);
    expect(p.z).toBeCloseTo(10);
  });
  it('leaves free bodies alone and handles big circles spanning cells', () => {
    const c = new Colliders();
    c.add(0, 0, 25);
    const free = { x: 40, z: 0 };
    c.resolve(free, 0.5);
    expect(free.x).toBe(40);
    const inside = { x: 24, z: 0 };
    c.resolve(inside, 0.5);
    expect(inside.x).toBeGreaterThanOrEqual(25.49);
  });
});

describe('math helpers', () => {
  it('angleDiff takes the short way round', () => {
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(-0.2);
    expect(angleDiff(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6.0);
  });
  it('damp converges and clamp clamps', () => {
    let v = 0;
    for (let i = 0; i < 120; i++) v = damp(v, 10, 8, 1 / 60);
    expect(v).toBeGreaterThan(9.9);
    expect(clamp(5, 0, 1)).toBe(1);
  });
});

describe('camera conventions', () => {
  it('forward = (sin yaw, cos yaw) and the strafe vector is to the right', () => {
    // matches ThirdPersonCam.forwardXZ / Game.buildIntent: right = (-cos yaw, sin yaw)
    for (const yaw of [0, 1, Math.PI, -2]) {
      const f = new THREE.Vector2(Math.sin(yaw), Math.cos(yaw));
      const r = new THREE.Vector2(-Math.cos(yaw), Math.sin(yaw));
      expect(f.dot(r)).toBeCloseTo(0);
      // looking down -z (yaw = π) must put +x on the right
      if (yaw === Math.PI) expect(r.x).toBeCloseTo(1);
    }
  });
});
