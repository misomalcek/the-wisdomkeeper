/**
 * Signed distance fields → meshes. Surface nets (Gibson 1998; the dual of marching cubes): one vertex per grid cell
 * the surface crosses, placed at the mean of the crossing points on the cell's edges, and one quad per crossed grid
 * edge joining the four cells around it. Smooth, well-shaped quads without marching cubes' case tables, and normals
 * from the field's own gradient.
 */
import { MeshBuilder } from './geo';

export type Sdf = (x: number, y: number, z: number) => number;
/** Per-vertex aux (kind, random, -, trap) from the position; z is filled from height by the builder. */
export type AuxFn = (x: number, y: number, z: number) => [number, number, number];

export function surfaceNets(f: Sdf, min: [number, number, number], max: [number, number, number], res: number, b: MeshBuilder, aux: AuxFn) {
  const nx = res + 1;
  const sx = (max[0] - min[0]) / res;
  const sy = (max[1] - min[1]) / res;
  const sz = (max[2] - min[2]) / res;
  const v = new Float32Array(nx * nx * nx);
  const at = (i: number, j: number, k: number) => i + nx * (j + nx * k);
  for (let k = 0; k < nx; k++) for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) v[at(i, j, k)] = f(min[0] + i * sx, min[1] + j * sy, min[2] + k * sz);
  const cell = new Int32Array(res * res * res).fill(-1);
  const cat = (i: number, j: number, k: number) => i + res * (j + res * k);
  const eps = Math.min(sx, sy, sz) * 0.5;
  // corner offsets and the 12 cube edges
  const C = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const d = new Float32Array(8);
  for (let k = 0; k < res; k++) {
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          d[c] = v[at(i + C[c][0], j + C[c][1], k + C[c][2])];
          if (d[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let px = 0;
        let py = 0;
        let pz = 0;
        let n = 0;
        for (const [a, bb] of E) {
          if (d[a] < 0 === d[bb] < 0) continue;
          const t = d[a] / (d[a] - d[bb]);
          px += C[a][0] + (C[bb][0] - C[a][0]) * t;
          py += C[a][1] + (C[bb][1] - C[a][1]) * t;
          pz += C[a][2] + (C[bb][2] - C[a][2]) * t;
          n++;
        }
        const x = min[0] + (i + px / n) * sx;
        const y = min[1] + (j + py / n) * sy;
        const z = min[2] + (k + pz / n) * sz;
        const gx = f(x + eps, y, z) - f(x - eps, y, z);
        const gy = f(x, y + eps, z) - f(x, y - eps, z);
        const gz = f(x, y, z + eps) - f(x, y, z - eps);
        const gl = Math.hypot(gx, gy, gz) || 1;
        const a = aux(x, y, z);
        cell[cat(i, j, k)] = b.vertex(x, y, z, gx / gl, gy / gl, gz / gl, a[0], a[1], 0, a[2]);
      }
    }
  }
  // quads across every crossed grid edge (interior edges only: the four cells around it must exist)
  for (let k = 0; k < nx; k++) {
    for (let j = 0; j < nx; j++) {
      for (let i = 0; i < nx; i++) {
        const s0 = v[at(i, j, k)] < 0;
        if (i < res && j > 0 && k > 0 && s0 !== v[at(i + 1, j, k)] < 0) emit(cell[cat(i, j - 1, k - 1)], cell[cat(i, j, k - 1)], cell[cat(i, j, k)], cell[cat(i, j - 1, k)], s0, b);
        if (j < res && i > 0 && k > 0 && s0 !== v[at(i, j + 1, k)] < 0) emit(cell[cat(i - 1, j, k - 1)], cell[cat(i - 1, j, k)], cell[cat(i, j, k)], cell[cat(i, j, k - 1)], s0, b);
        if (k < res && i > 0 && j > 0 && s0 !== v[at(i, j, k + 1)] < 0) emit(cell[cat(i - 1, j - 1, k)], cell[cat(i, j - 1, k)], cell[cat(i, j, k)], cell[cat(i - 1, j, k)], s0, b);
      }
    }
  }
}

function emit(a: number, b2: number, c: number, d: number, flip: boolean, b: MeshBuilder) {
  if (a < 0 || b2 < 0 || c < 0 || d < 0) return;
  if (flip) b.quad(a, b2, c, d);
  else b.quad(a, d, c, b2);
}

// ------------------------------------------------------------------------------------------------- 3D value noise
const hash3 = (x: number, y: number, z: number, s: number) => {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ s;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};
export function noise3(x: number, y: number, z: number, seed: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz, seed);
  return (
    l(
      l(l(c(0, 0, 0), c(1, 0, 0), ux), l(c(0, 1, 0), c(1, 1, 0), ux), uy),
      l(l(c(0, 0, 1), c(1, 0, 1), ux), l(c(0, 1, 1), c(1, 1, 1), ux), uy),
      uz,
    ) * 2 - 1
  );
}
export function fbm3(x: number, y: number, z: number, seed: number, oct = 4) {
  let a = 0.5;
  let s = 0;
  for (let o = 0; o < oct; o++) {
    s += a * noise3(x, y, z, seed + o * 101);
    x *= 2.03;
    y *= 2.03;
    z *= 2.03;
    a *= 0.5;
  }
  return s;
}
