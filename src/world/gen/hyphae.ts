import { Rng } from '../../util/rng';

export interface HyphaSeg {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 0 = main cord, 1 = side hypha. */
  kind: number;
}

const edgeHash = (a: number, b: number, c: number, seed: number) => {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x27d4eb2d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

/**
 * Mycelial network for one terrain chunk, grown by the rules fungi follow:
 * - cords run from feeding sites (chunk nodes) toward resources, as persistent random walks with homing,
 * - tips branch laterally (sub-apical branching) and side hyphae fuse back into cords (anastomosis),
 * - every chunk edge carries deterministic "hub" crossings shared with its neighbour, so cords join
 *   seamlessly across chunk borders into one infinite network.
 */
export function growHyphae(cx: number, cz: number, size: number, seed: number, maxSegs: number): HyphaSeg[] {
  const rng = new Rng((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ seed) >>> 0);
  const x0 = cx * size;
  const z0 = cz * size;
  // hubs: west/east edges are shared via (edge x index, row), north/south via (col, edge z index)
  const hubs = [
    { x: x0, z: z0 + size * (0.15 + 0.7 * edgeHash(cx, cz, 1, seed)) },
    { x: x0 + size, z: z0 + size * (0.15 + 0.7 * edgeHash(cx + 1, cz, 1, seed)) },
    { x: x0 + size * (0.15 + 0.7 * edgeHash(cx, cz, 2, seed)), z: z0 },
    { x: x0 + size * (0.15 + 0.7 * edgeHash(cx, cz + 1, 2, seed)), z: z0 + size },
  ];
  const nodes = [{ x: x0 + size * rng.range(0.3, 0.7), z: z0 + size * rng.range(0.3, 0.7) }];
  if (rng.chance(0.5)) nodes.push({ x: x0 + size * rng.range(0.2, 0.8), z: z0 + size * rng.range(0.2, 0.8) });

  const segs: HyphaSeg[] = [];
  const cordPts: { x: number; z: number }[] = [];
  const step = 1.3;

  const cord = (ax: number, az: number, bx: number, bz: number) => {
    let x = ax;
    let z = az;
    let a = Math.atan2(bz - az, bx - ax) + rng.range(-0.6, 0.6);
    for (let i = 0; i < 120 && segs.length < maxSegs; i++) {
      const dx = bx - x;
      const dz = bz - z;
      const d = Math.hypot(dx, dz);
      if (d < step) {
        segs.push({ x0: x, z0: z, x1: bx, z1: bz, kind: 0 });
        return;
      }
      // persistence + homing + noise
      const want = Math.atan2(dz, dx);
      let da = want - a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      a += da * 0.22 + rng.gauss() * 0.28;
      const nx = x + Math.cos(a) * step;
      const nz = z + Math.sin(a) * step;
      segs.push({ x0: x, z0: z, x1: nx, z1: nz, kind: 0 });
      cordPts.push({ x: nx, z: nz });
      x = nx;
      z = nz;
      if (rng.chance(0.09)) side(x, z, a + rng.sign() * rng.range(0.6, 1.3), 3);
    }
  };

  const side = (sx: number, sz: number, a: number, gen: number) => {
    let x = sx;
    let z = sz;
    const len = Math.round(rng.range(4, 12) / (4 - gen));
    for (let i = 0; i < len && segs.length < maxSegs; i++) {
      a += rng.gauss() * 0.35;
      const nx = x + Math.cos(a) * step * 0.8;
      const nz = z + Math.sin(a) * step * 0.8;
      if (nx < x0 || nx > x0 + size || nz < z0 || nz > z0 + size) return;
      segs.push({ x0: x, z0: z, x1: nx, z1: nz, kind: 1 });
      x = nx;
      z = nz;
      // anastomosis: fuse into a nearby cord and stop
      for (const p of cordPts) {
        const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d2 < 2.2 && d2 > 0.3) {
          segs.push({ x0: x, z0: z, x1: p.x, z1: p.z, kind: 1 });
          return;
        }
      }
      if (gen > 1 && rng.chance(0.12)) side(x, z, a + rng.sign() * 0.9, gen - 1);
    }
  };

  for (const h of hubs) {
    const n = nodes[Math.floor(rng.next() * nodes.length)];
    cord(n.x, n.z, h.x, h.z);
  }
  if (nodes.length > 1) cord(nodes[0].x, nodes[0].z, nodes[1].x, nodes[1].z);
  return segs;
}
