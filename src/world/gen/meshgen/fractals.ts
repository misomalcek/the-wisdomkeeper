/**
 * Landmark formations meshed from true 3D fractals (distance estimators, surface nets), not pictures of them:
 * - Mandelbulb (White–Nylander): z → zⁿ + c in spherical coordinates; DE = ½·log r·r / dr. A bulb of whorls.
 * - Julia bulb: the same map with a fixed c, so the shape is one Julia set of the bulb family (organic towers).
 * - Menger sponge as a kaleidoscopic IFS (abs folds, a sort, scale 3 about a corner, optionally twisted between
 *   iterations), carved by a leaning, noise-eroded envelope into a ruin whose tunnels open on its cut faces.
 * Every vertex keeps the orbit trap (closest approach of the orbit to a plane/axis), which the shader turns into
 * the glowing veins and banding that trace the fractal's own structure.
 */
import { MeshBuilder, type MeshArrays } from './geo';
import { fbm3, surfaceNets } from './sdf';

export interface FractalSpec {
  kind: 'bulb' | 'menger' | 'julia';
  /** Julia constant index (julia). */
  c?: number;
  /** Bulb power / Menger twist (rad). */
  p: number;
  iter: number;
  /** Half-extent of the meshing box (fractal units) and the vertical offset of its centre. */
  half: number;
  yc: number;
}

export const FORMATIONS: FractalSpec[] = [
  // open ground: bulbs
  { kind: 'bulb', p: 8, iter: 7, half: 1.25, yc: 0.15 },
  { kind: 'julia', p: 4, iter: 8, half: 1.3, yc: 0, c: 0 },
  // canyonlands: ruins carved from a Menger sponge, straight and twisted
  { kind: 'menger', p: 0, iter: 5, half: 1.05, yc: 0 },
  { kind: 'menger', p: 0.25, iter: 5, half: 1.3, yc: 0 },
  // ranges: stacked Julia bulb, five-fold bulb
  { kind: 'julia', p: 3, iter: 9, half: 1.4, yc: 0, c: 0 },
  { kind: 'bulb', p: 5, iter: 7, half: 1.3, yc: 0.15 },
];

let trap = 0;

function bulb(px: number, py: number, pz: number, n: number, iter: number) {
  let x = px;
  let y = py;
  let z = pz;
  let dr = 1;
  let r = 0;
  trap = 1e9;
  for (let i = 0; i < iter; i++) {
    r = Math.hypot(x, y, z);
    if (r > 2) break;
    trap = Math.min(trap, Math.abs(y) + 0.3 * r);
    const th = Math.acos(Math.max(-1, Math.min(1, z / (r || 1e-9)))) * n;
    const ph = Math.atan2(y, x) * n;
    dr = Math.pow(r, n - 1) * n * dr + 1;
    const zr = Math.pow(r, n);
    x = zr * Math.sin(th) * Math.cos(ph) + px;
    y = zr * Math.sin(th) * Math.sin(ph) + py;
    z = zr * Math.cos(th) + pz;
  }
  return (0.5 * Math.log(Math.max(r, 1e-6)) * r) / dr;
}

function menger(px: number, py: number, pz: number, a: number, iter: number) {
  // Menger sponge as a KIFS (abs folds, sort, scale 3 about a corner) with a twist between iterations
  let x = px;
  let y = py;
  let z = pz;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  let k = 1;
  trap = 1e9;
  for (let i = 0; i < iter; i++) {
    x = Math.abs(x);
    y = Math.abs(y);
    z = Math.abs(z);
    if (x < y) [x, y] = [y, x];
    if (x < z) [x, z] = [z, x];
    if (y < z) [y, z] = [z, y];
    const nx = x * ca - z * sa;
    z = x * sa + z * ca;
    x = nx;
    x = 3 * x - 2;
    y = 3 * y - 2;
    z = 3 * z;
    if (z > 1) z -= 2;
    k *= 3;
    trap = Math.min(trap, Math.abs(z));
  }
  const bx = Math.max(Math.abs(x) - 1, Math.abs(y) - 1, Math.abs(z) - 1);
  return bx / k;
}

const JC: [number, number, number][] = [
  [0.45, 0.5, -0.32],
  [-0.2, 0.62, 0.35],
];
function juliabulb(px: number, py: number, pz: number, n: number, iter: number, c: [number, number, number]) {
  let x = px;
  let y = py;
  let z = pz;
  let dr = 1;
  let r = 0;
  trap = 1e9;
  for (let i = 0; i < iter; i++) {
    r = Math.hypot(x, y, z);
    if (r > 2) break;
    trap = Math.min(trap, Math.abs(z) + 0.2 * r);
    const th = Math.acos(Math.max(-1, Math.min(1, z / (r || 1e-9)))) * n;
    const ph = Math.atan2(y, x) * n;
    dr = Math.pow(r, n - 1) * n * dr;
    const zr = Math.pow(r, n);
    x = zr * Math.sin(th) * Math.cos(ph) + c[0];
    y = zr * Math.sin(th) * Math.sin(ph) + c[1];
    z = zr * Math.cos(th) + c[2];
  }
  return (0.5 * Math.log(Math.max(r, 1e-6)) * r) / Math.max(dr, 1e-6);
}

/** Mesh a formation. Output is normalised to stand on y = 0 with unit height (scale it when placing). */
export function buildFormation(f: FractalSpec, res: number): MeshArrays {
  const de = (x: number, y: number, z: number) =>
    f.kind === 'bulb' ? bulb(x, y, z, f.p, f.iter) : f.kind === 'menger' ? menger(x, y, z, f.p, f.iter) : juliabulb(x, y, z, f.p, f.iter, JC[f.c ?? 0]);
  // the bulb is laid with its axis vertical; an iso-offset thickens fine filaments into solid rock
  const thick = f.half * 0.012;
  const sdf = (x: number, y: number, z: number) => {
    let d = f.kind === 'bulb' || f.kind === 'julia' ? de(x, z, y) : de(x, y, z);
    if (f.kind === 'menger') {
      // carve the sponge into a ruined, leaning tower: its tunnels open on the cut faces
      const t = (y + f.half) / (2 * f.half);
      const rr = f.half * (0.78 - 0.48 * t) + fbm3(x * 0.9, y * 0.9, z * 0.9, 77, 3) * f.half * 0.18;
      const lean = 0.18 * f.half * t;
      const top = y - f.half * (0.7 + 0.2 * Math.sin(x * 1.3 + z * 0.7)) - 0.25 * x;
      d = Math.max(d, Math.hypot(x - lean, z) - rr, top);
    }
    // clip to the meshing box so the surface always closes
    const h = f.half * 0.97;
    const bx = Math.max(Math.abs(x) - h, Math.abs(y - f.yc) - h, Math.abs(z) - h);
    return Math.max(d - thick, bx);
  };
  const b = new MeshBuilder();
  const h = f.half;
  surfaceNets(sdf, [-h, -h + f.yc, -h], [h, h + f.yc, h], res, b, (x, y, z) => {
    sdf(x, y, z);
    const t = trap;
    return [0, (Math.sin(t * 9.0) * 0.5 + 0.5), Math.min(1, t)];
  });
  const m = b.build(false);
  // stand it up: lowest point on y = 0, height 1
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 1; i < m.pos.length; i += 3) {
    lo = Math.min(lo, m.pos[i]);
    hi = Math.max(hi, m.pos[i]);
  }
  const sc = 1 / Math.max(1e-6, hi - lo);
  let r = 0;
  for (let i = 0; i < m.pos.length; i += 3) {
    m.pos[i] *= sc;
    m.pos[i + 1] = (m.pos[i + 1] - lo) * sc;
    m.pos[i + 2] *= sc;
    r = Math.max(r, Math.hypot(m.pos[i], m.pos[i + 2]));
    m.aux[(i / 3) * 4 + 2] = m.pos[i + 1];
  }
  m.radius = r;
  m.height = 1;
  return m;
}
