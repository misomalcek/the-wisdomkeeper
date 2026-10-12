import { describe, expect, it } from 'vitest';
import { Physarum } from '../src/world/gen/physarum';
import { latticeSite, SITE_CELL } from '../src/world/gen/sites';
import { Toponymy } from '../src/world/gen/names';
import { GroundShape } from '../src/world/gen/shape';
import { Form } from '../src/world/gen/landform';

const shape = () =>
  new GroundShape({ radius: 120, amp: 1.2, freq: 0.03, river: false, seed: 5, wild: true, flavour: 'seedbed', features: { erosion: true, terrace: true, orbit: true, landforms: true } });

describe('Physarum network (gen/physarum)', () => {
  const grow = (seed: number) => {
    const p = new Physarum({ size: 128, cell: 6, agents: 900, seed }, null);
    p.foods.push({ x: -180, z: 0, w: 1, ttl: Infinity }, { x: 180, z: 0, w: 1, ttl: Infinity });
    p.follow(0, 0);
    p.step(250);
    return p;
  };

  it('condenses the mass between two food sources', () => {
    const p = grow(3);
    // the band between the foods vs. an equal band well off it
    let on = 0;
    let off = 0;
    for (let x = -150; x <= 150; x += 6) {
      for (let z = -54; z <= 54; z += 6) {
        on += p.at(x, z);
        off += p.at(x, z + 210);
      }
    }
    expect(on).toBeGreaterThan(off * 1.5);
  });

  it('is deterministic per seed, and writes vein strength and distance along the veins', () => {
    const a = grow(9);
    const b = grow(9);
    expect(a.trail).toEqual(b.trail);
    const rg = new Uint8Array(128 * 128 * 2);
    a.write(rg);
    const slot = (x: number, z: number) => {
      const ix = Math.floor(x / 6);
      const iz = Math.floor(z / 6);
      return ((((iz % 128) + 128) % 128) * 128 + (((ix % 128) + 128) % 128)) * 2;
    };
    // the food cell is the origin of the distance channel; a strong vein cell is bright
    expect(rg[slot(-180, 0) + 1]).toBe(0);
    expect(rg[slot(-180, 0)]).toBeGreaterThan(200);
  });

  it('follows the hero without losing its agents', () => {
    const p = grow(4);
    expect(p.follow(500, 0)).toBe(true);
    p.step(20);
    expect(p.follow(500, 0)).toBe(false);
    expect([...p.trail].every(Number.isFinite)).toBe(true);
  });
});

describe('Wilds site lattice and place names', () => {
  it('places formations and stations deterministically, apart, outside the heart', () => {
    const s = shape();
    let formations = 0;
    let stations = 0;
    for (let j = -6; j <= 6; j++) {
      for (let i = -6; i <= 6; i++) {
        const a = latticeSite(s, 77, i, j, true);
        expect(a).toEqual(latticeSite(s, 77, i, j, true));
        if (!a) continue;
        expect(Math.hypot(a.x, a.z)).toBeGreaterThan(120 * 2.6);
        expect(Math.floor(a.x / SITE_CELL)).toBe(i);
        if (a.kind === 'formation') formations++;
        else {
          stations++;
          expect(s.slopeAt(a.x, a.z)).toBeLessThanOrEqual(0.3);
        }
        // without stations a formation cell is unchanged and a station cell is empty
        const b = latticeSite(s, 77, i, j, false);
        if (a.kind === 'formation') expect(b).toEqual(a);
        else expect(b).toBeNull();
      }
    }
    expect(formations).toBeGreaterThan(20);
    expect(stations).toBeGreaterThan(5);
  });

  it('names places the same way every time, in a voice of the region', () => {
    const a = new Toponymy(11);
    const b = new Toponymy(11);
    const c = new Toponymy(12);
    expect(a.province(2, -1, Form.Range)).toEqual(b.province(2, -1, Form.Range));
    expect(a.formation(4, 4, 'menger')).toBe(b.formation(4, 4, 'menger'));
    let differ = 0;
    for (let k = 0; k < 40; k++) {
      const w = a.word(k);
      expect(w).toMatch(/^[A-Z][a-z]+$/);
      expect(w.length).toBeLessThanOrEqual(10);
      if (w !== c.word(k)) differ++;
    }
    expect(differ).toBeGreaterThan(35);
  });
});
