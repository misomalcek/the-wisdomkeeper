/**
 * Stone and crystal, generated.
 * - Boulders: an ellipsoid roughened by 3D fBm, then cut by a few random half-spaces so it shows the flat faces of
 *   fractured rock, meshed with surface nets.
 * - Hoodoos: a column of soft rock whose radius pinches and swells with the strata (sin of height warped by noise),
 *   capped by a wider, harder caprock, like the eroded pillars of a canyonland.
 * - Crystal clusters: real quartz habit, hexagonal prisms with six-faced pyramidal terminations, sprouting from a
 *   common root on the golden angle, flat-shaded so every facet catches the light.
 */
import { Rng } from '../../../util/rng';
import { MeshBuilder, type MeshArrays, type V3, add, cross, norm, perp, scale, sub } from './geo';
import { fbm3, surfaceNets } from './sdf';

export function buildBoulder(seed: number, res: number): MeshArrays {
  const rng = new Rng(seed);
  const R: V3 = [1, rng.range(0.55, 0.8), rng.range(0.7, 0.95)];
  const cuts: { n: V3; d: number }[] = [];
  for (let k = 0; k < rng.int(4, 7); k++) {
    const n = norm([rng.gauss(), rng.range(-0.3, 1), rng.gauss()]);
    // planes at about half the extent along their normal: decisive fracture faces
    const ext = Math.hypot(n[0] * R[0], n[1] * R[1], n[2] * R[2]);
    cuts.push({ n, d: rng.range(0.5, 0.72) * ext });
  }
  const s = seed & 0xffff;
  const f = (x: number, y: number, z: number) => {
    // ellipsoid (scaled-sphere bound), roughened
    const q = Math.hypot(x / R[0], y / R[1], z / R[2]);
    let d = (q - 1) * Math.min(R[0], R[1], R[2]);
    // weathering: ridged noise pits the surface and rounds nothing
    d += (0.5 - Math.abs(fbm3(x * 1.8, y * 1.8, z * 1.8, s, 4))) * 0.22 + fbm3(x * 6, y * 6, z * 6, s + 5, 2) * 0.03;
    for (const c of cuts) d = Math.max(d, c.n[0] * x + c.n[1] * y + c.n[2] * z - c.d);
    return d;
  };
  const b = new MeshBuilder();
  surfaceNets(f, [-1.3, -1.1, -1.3], [1.3, 1.1, 1.3], res, b, (x, y, z) => [0, fbm3(x * 4, y * 4, z * 4, s + 7, 2) * 0.5 + 0.5, 0]);
  return b.build();
}

export function buildHoodoo(seed: number, res: number): MeshArrays {
  const rng = new Rng(seed);
  const H = rng.range(2.6, 3.6);
  const capR = rng.range(0.5, 0.75);
  const s = seed & 0xffff;
  const ph = rng.range(0, 6.28);
  const f = (x: number, y: number, z: number) => {
    const t = Math.min(1, Math.max(0, y / H));
    // soft beds pinch, hard beds stand out; the column thins toward the top
    const beds = Math.sin(y * 4.2 + ph + fbm3(x, y * 0.5, z, s, 2) * 2) * 0.07;
    const r = 0.55 - 0.22 * t + beds + fbm3(x * 2.5, y * 1.2, z * 2.5, s + 3, 3) * 0.08;
    const col = Math.max(Math.hypot(x, z) - r, -y - 0.5, y - H);
    // caprock: a flattened lump sitting on top
    const cy = y - H - 0.12;
    const cap = Math.hypot(x / capR, cy / 0.22, z / (capR * 0.9)) * 0.22 - 0.22 + fbm3(x * 3, y * 3, z * 3, s + 9, 2) * 0.05;
    return Math.min(col, cap);
  };
  const b = new MeshBuilder();
  surfaceNets(f, [-1, -0.6, -1], [1, H + 0.6, 1], res, b, (_x, y) => [0, 0.5 + 0.5 * Math.sin(y * 4.2 + ph), Math.min(1, y / H)]);
  return b.build();
}

/** One quartz crystal: hexagonal prism of radius r and length l along dir, a six-faced point on top. */
function quartz(b: MeshBuilder, base: V3, dir: V3, r: number, l: number, hue: number, rng: Rng) {
  const u = perp(dir);
  const v = cross(dir, u);
  const tipL = r * rng.range(1.3, 1.9);
  const ring = (o: V3, k: number): V3 => {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    // slightly unequal faces, as real crystals grow
    const rr = r * (1 + 0.12 * Math.sin(k * 2.1 + hue * 9));
    return add(o, add(scale(u, Math.cos(a) * rr), scale(v, Math.sin(a) * rr)));
  };
  const top = add(base, scale(dir, l));
  const apex = add(top, scale(dir, tipL));
  const face = (p: V3[], w: number) => {
    // flat shading: own vertices per facet
    const n = norm(cross(sub(p[1], p[0]), sub(p[2], p[0])));
    const i = p.map((q, k) => b.vertex(q[0], q[1], q[2], n[0], n[1], n[2], 1, hue, 0, w + k * 0.0));
    if (i.length === 4) b.quad(i[0], i[1], i[2], i[3]);
    else b.tri(i[0], i[1], i[2]);
  };
  for (let k = 0; k < 6; k++) {
    const a0 = ring(base, k);
    const a1 = ring(base, k + 1);
    const b0 = ring(top, k);
    const b1 = ring(top, k + 1);
    face([a0, a1, b1, b0], 0.3);
    face([b0, b1, apex], 1);
  }
}

export function buildCrystalCluster(seed: number): MeshArrays {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const n = rng.int(6, 13);
  const GOLD = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < n; k++) {
    const tilt = k === 0 ? rng.range(0, 0.15) : rng.range(0.25, 0.95);
    const az = k * GOLD + rng.range(-0.3, 0.3);
    const dir = norm([Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az)]);
    const r = (k === 0 ? 0.42 : rng.range(0.14, 0.32)) * (1 - tilt * 0.3);
    const l = r * rng.range(3.5, 7) * (k === 0 ? 1.2 : 1);
    const base: V3 = [Math.cos(az) * rng.range(0, 0.35), -0.4, Math.sin(az) * rng.range(0, 0.35)];
    quartz(b, base, dir, r, l, rng.next(), rng);
  }
  return b.build();
}
