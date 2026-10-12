/**
 * Atlas Stations: structures whose form and every member size come out of the mechanics.
 * A frame (a geodesic dome, or a funicular gridshell form-found from a Townscaper grid) is loaded with the weather
 * of the Wilds (self-weight, skin, snow on plan, wind pressure and suction) and solved as a pin-jointed space
 * truss; each member is sized for yield and Euler buckling and rounded up to stock (truss.ts), then meshed:
 * - struts: smooth n-gon prisms of the member's own radius, hub to hub;
 * - joints: icosahedral hubs scaled to the thickest member they hold; a ground sill along the supports, shoes at
 *   the feet of the edge arches and doorways;
 * - panels: thin two-sided skin plates over chosen faces, each pierced by a rounded hole whose size grows as the
 *   stress in the surrounding members falls ("cut a path where ornament meets purpose": idle skin opens up), and
 *   dome doorways where the base struts are least worked.
 * Units: real metres (domes 20–28 m across, gridshells 28–38 m spans), standing on y = 0: place without rescaling.
 * aux per vertex: x = part (0 strut, 1 joint / sill / shoe, 2 panel), y = signed axial stress / peak |stress| of the
 * structure (tension +, compression −), z = height fraction 0..1, w = utilisation (demand / yield-or-buckling
 * capacity) 0..1. Hubs carry the mean y and the largest w of their members; panels those of the members round them.
 */
import { Rng } from '../../../util/rng';
import { MeshBuilder, type MeshArrays, type V3, add, cross, dot, len, norm, perp, scale, sub } from './geo';
import { geodesicDome } from './dome';
import { gridshell } from './gridshell';
import { type Frame, type SizedTruss, type Weather, STEEL, TIMBER, sizeTruss, weatherLoads } from './truss';

interface StationBase {
  name: string;
  seed: number;
  material: 'steel' | 'timber';
  /**
   * Skin panels: faces whose centroid height fraction lies in one of the bands, and of those the given share,
   * picked as connected patches by a smooth seeded field.
   */
  panels: { bands: [number, number][]; share: number };
}
export interface DomeStation extends StationBase {
  kind: 'dome';
  freq: number;
  /** Height / sphere diameter. */
  fraction: number;
  /** Sphere diameter (m). */
  diameter: number;
  /** Doorways: base triangles left open at the ground (the sill under them carries nothing). */
  doors: number;
}
export interface ShellStation extends StationBase {
  kind: 'gridshell';
  /** Grid resolution (hexagon rows). */
  rings: number;
  /** Plan length and width (m), superellipse exponent, crown height (m). */
  span: number;
  width: number;
  squareness: number;
  rise: number;
  openings: number;
  openingWidth: number;
}
export type StationSpec = DomeStation | ShellStation;

export const STATIONS: StationSpec[] = [
  // Fuller: a 3V ⅝ steel dome, crown clad
  { kind: 'dome', name: 'fuller-3v', seed: 11, material: 'steel', freq: 3, fraction: 5 / 8, diameter: 20, doors: 1, panels: { bands: [[0.55, 1]], share: 1 } },
  // a 5V hemisphere, skin in a band and on the crown
  { kind: 'dome', name: 'hemi-5v', seed: 23, material: 'steel', freq: 5, fraction: 1 / 2, diameter: 28, doors: 2, panels: { bands: [[0.3, 0.55], [0.78, 1]], share: 1 } },
  // a 4V ⅝ timber dome
  { kind: 'dome', name: 'timber-4v', seed: 37, material: 'timber', freq: 4, fraction: 5 / 8, diameter: 22, doors: 1, panels: { bands: [[0.42, 1]], share: 0.7 } },
  // Mannheim: a long, low timber gridshell with three arched entries
  { kind: 'gridshell', name: 'mannheim', seed: 7, material: 'timber', rings: 6, span: 38, width: 26, squareness: 2.6, rise: 9, openings: 3, openingWidth: 0.12, panels: { bands: [[0.5, 1]], share: 0.55 } },
  // a round pavilion vault, four openings
  { kind: 'gridshell', name: 'pavilion', seed: 19, material: 'timber', rings: 5, span: 28, width: 28, squareness: 2, rise: 10, openings: 4, openingWidth: 0.1, panels: { bands: [[0.35, 1]], share: 0.45 } },
  // a tall rounded-rectangle hall, two openings
  { kind: 'gridshell', name: 'hall', seed: 41, material: 'timber', rings: 6, span: 32, width: 22, squareness: 3.2, rise: 11, openings: 2, openingWidth: 0.13, panels: { bands: [[0.45, 1]], share: 0.6 } },
];

/** The weather of the Wilds: heavy snow, a gale from a seeded bearing, a light skin. */
const weatherFor = (seed: number): Weather => {
  const a = (seed * 2.399) % (Math.PI * 2);
  return { snow: 1600, dead: 350, wind: 900, windDir: [Math.cos(a), Math.sin(a)] };
};

export interface Station {
  frame: Frame;
  sized: SizedTruss;
}

const memo = new WeakMap<StationSpec, Station>();

/** Frame + analysis + sizing, before meshing (also what the tests check). Memoised per spec object. */
export function analyseStation(s: StationSpec): Station {
  const hit = memo.get(s);
  if (hit) return hit;
  const frame =
    s.kind === 'dome'
      ? geodesicDome({ freq: s.freq, fraction: s.fraction, diameter: s.diameter })
      : gridshell(s.seed, {
          rings: s.rings,
          a: s.span / 2,
          b: s.width / 2,
          e: s.squareness,
          rise: s.rise,
          openings: s.openings,
          openingWidth: s.openingWidth,
        });
  const loads = weatherLoads(frame, weatherFor(s.seed));
  const steel = s.material === 'steel';
  // stock: braces start thinner, edge arches heavier
  const r0 = steel ? 0.03 : 0.06;
  const rMin = Float64Array.from(frame.role, (r) => r0 * (r === 1 ? 0.55 : r === 2 ? 1.4 : 1));
  const sized = sizeTruss(frame.x, frame.ends, frame.fixed, loads, {
    mat: steel ? STEEL : TIMBER,
    // steel: round hollow sections, D/t ≈ 33
    wall: steel ? 0.06 : undefined,
    gamma: 1.5,
    // gridshell laths also guard the whole net against snap-through: a long effective length
    K: s.kind === 'dome' ? 1.5 : 2,
    rMin,
    step: 1.22,
  });
  const st = { frame, sized };
  memo.set(s, st);
  return st;
}

/** Full detail: octagonal ribs, pentagonal braces, hubs, rimmed panels. Distant: square ribs only, flat panels. */
const LODS = [
  { sides: 8, braceSides: 5, hubs: true, panelSeg: 4, rims: true },
  { sides: 4, braceSides: 0, hubs: false, panelSeg: 1, rims: false },
];

/** Mesh a station at a level of detail (0 full, 1 distant). Metres, standing on y = 0. */
export function buildStation(spec: StationSpec, lod: 0 | 1): MeshArrays {
  const { frame, sized } = analyseStation(spec);
  const L = LODS[lod];
  const { x, ends, role } = frame;
  const n = x.length / 3;
  const m = ends.length / 2;
  const P = (i: number): V3 => [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]];
  let smax = 0;
  for (let e = 0; e < m; e++) smax = Math.max(smax, Math.abs(sized.stress[e]));
  const sy = (e: number) => sized.stress[e] / (smax || 1);
  const ut = (e: number) => Math.min(1, sized.util[e]);
  // joints: hub radius from the thickest member, aux from what passes through
  const hubR = new Float64Array(n);
  const hubY = new Float64Array(n);
  const hubW = new Float64Array(n);
  const deg = new Float64Array(n);
  for (let e = 0; e < m; e++)
    for (const i of [ends[2 * e], ends[2 * e + 1]]) {
      hubR[i] = Math.max(hubR[i], sized.r[e] * 1.45);
      hubY[i] += sy(e);
      hubW[i] = Math.max(hubW[i], ut(e));
      deg[i]++;
    }
  const b = new MeshBuilder();
  // struts
  for (let e = 0; e < m; e++) {
    const a = ends[2 * e];
    const c = ends[2 * e + 1];
    const pa = P(a);
    const pc = P(c);
    const d = norm(sub(pc, pa));
    const sides = role[e] === 1 ? L.braceSides : L.sides;
    if (!sides) continue;
    const l = len(sub(pc, pa));
    const inA = L.hubs ? Math.min(hubR[a] * 0.6, l * 0.4) : 0;
    const inC = L.hubs ? Math.min(hubR[c] * 0.6, l * 0.4) : 0;
    strut(b, add(pa, scale(d, inA)), add(pc, scale(d, -inC)), sized.r[e], sides, sy(e), ut(e));
  }
  // ground sill along the supports: a square beam, flat on top, broken for the doors
  const doors = spec.kind === 'dome' ? doorways(frame, sized.util, spec.doors) : new Set<number>();
  const sillDeg = new Uint8Array(n);
  let sr = 0;
  for (let i = 0; i < n; i++) if (frame.fixed[i * 3]) sr = Math.max(sr, hubR[i]);
  for (let k = 0; k < frame.sill.length; k += 2) {
    if (doors.has(k)) continue;
    const a = frame.sill[k];
    const c = frame.sill[k + 1];
    sillDeg[a]++;
    sillDeg[c]++;
    const d = norm(sub(P(c), P(a)));
    const lo: V3 = [0, -sr * 0.6, 0];
    strut(b, add(add(P(a), lo), scale(d, -sr)), add(add(P(c), lo), scale(d, sr)), sr * 1.25, 4, 0, 0, Math.PI / 4, 1);
  }
  // hubs, and shoes where a support is not held in a sill run (arch feet)
  for (let i = 0; i < n; i++) {
    const p = P(i);
    const ay = hubY[i] / (deg[i] || 1);
    if (L.hubs) hub(b, p, hubR[i], ay, hubW[i]);
    if (frame.fixed[i * 3] && sillDeg[i] < 2) shoe(b, p, hubR[i], ay, hubW[i]);
  }
  // skin panels
  if (spec.panels.bands.length) panels(b, spec, frame, sized, hubR, sy, ut, L.panelSeg, L.rims);
  const out = b.build(false);
  // stand on y = 0 (the shoes reach a little below the supports); aux.z = height fraction
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 1; k < out.pos.length; k += 3) (lo = Math.min(lo, out.pos[k])), (hi = Math.max(hi, out.pos[k]));
  for (let k = 1; k < out.pos.length; k += 3) {
    out.pos[k] -= lo;
    out.aux[((k - 1) / 3) * 4 + 2] = out.pos[k] / (hi - lo);
  }
  out.height = hi - lo;
  return out;
}

/**
 * Cut a path where the frame is least worked: the base triangles whose two rising struts have the lowest
 * utilisation, spread round the ring, lose their sill and become doorways. Returns sill pair offsets.
 */
function doorways(fr: Frame, util: Float64Array, count: number) {
  const key = (a: number, c: number) => (a < c ? a * 65536 + c : c * 65536 + a);
  const member = new Map<number, number>();
  for (let e = 0; e < fr.ends.length / 2; e++) member.set(key(fr.ends[2 * e], fr.ends[2 * e + 1]), e);
  const apex = new Map<number, number>();
  for (const f of fr.faces) if (f.length === 3) for (let k = 0; k < 3; k++) apex.set(key(f[k], f[(k + 1) % 3]), f[(k + 2) % 3]);
  const cand: { k: number; score: number; ang: number }[] = [];
  for (let k = 0; k < fr.sill.length; k += 2) {
    const a = fr.sill[k];
    const c = fr.sill[k + 1];
    const ap = apex.get(key(a, c));
    const ea = ap === undefined ? undefined : member.get(key(a, ap));
    const ec = ap === undefined ? undefined : member.get(key(c, ap));
    if (ea === undefined || ec === undefined) continue;
    const ang = Math.atan2(fr.x[a * 3 + 2] + fr.x[c * 3 + 2], fr.x[a * 3] + fr.x[c * 3]);
    cand.push({ k, score: util[ea] + util[ec], ang });
  }
  cand.sort((p, q) => p.score - q.score || p.k - q.k);
  const out = new Set<number>();
  const picked: number[] = [];
  for (const c of cand) {
    if (out.size >= count) break;
    if (picked.some((a) => Math.abs(Math.atan2(Math.sin(a - c.ang), Math.cos(a - c.ang))) < (0.8 * Math.PI) / count)) continue;
    out.add(c.k);
    picked.push(c.ang);
  }
  return out;
}

/** Prism of `sides` round a straight member, smooth normals, open ends (they sit in the hubs). */
function strut(b: MeshBuilder, p0: V3, p1: V3, r: number, sides: number, ay: number, aw: number, phase = 0, kind = 0) {
  const d = norm(sub(p1, p0));
  const u = perp(d);
  const v = cross(d, u);
  const base = b.vertexCount;
  for (const p of [p0, p1])
    for (let k = 0; k < sides; k++) {
      const t = (k / sides) * Math.PI * 2 + phase;
      const nx = u[0] * Math.cos(t) + v[0] * Math.sin(t);
      const ny = u[1] * Math.cos(t) + v[1] * Math.sin(t);
      const nz = u[2] * Math.cos(t) + v[2] * Math.sin(t);
      b.vertex(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r, nx, ny, nz, kind, ay, 0, aw);
    }
  for (let k = 0; k < sides; k++) {
    const k1 = (k + 1) % sides;
    b.quad(base + k, base + k1, base + sides + k1, base + sides + k);
  }
}

// unit icosahedron for the hubs
const ICO_V: V3[] = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  return raw.map(norm);
})();
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

function hub(b: MeshBuilder, p: V3, r: number, ay: number, aw: number) {
  const base = b.vertexCount;
  for (const q of ICO_V) b.vertex(p[0] + q[0] * r, p[1] + q[1] * r, p[2] + q[2] * r, q[0], q[1], q[2], 1, ay, 0, aw);
  for (const f of ICO_F) b.tri(base + f[0], base + f[1], base + f[2]);
}

/** Support shoe: a tapered square plinth from below ground up to the support node. */
function shoe(b: MeshBuilder, p: V3, r: number, ay: number, aw: number) {
  const h = Math.max(0.3, r * 3);
  const top = r * 1.6;
  const bot = r * 2.6;
  const rings: [number, number][] = [[p[1] - h, bot], [p[1], top]];
  // four flat sides + a lid, own vertices per face for crisp edges
  const corner = (y: number, s: number, k: number): V3 => [p[0] + s * (k === 0 || k === 3 ? -1 : 1), y, p[2] + s * (k < 2 ? -1 : 1)];
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    const q = [corner(rings[0][0], rings[0][1], k), corner(rings[0][0], rings[0][1], k1), corner(rings[1][0], rings[1][1], k1), corner(rings[1][0], rings[1][1], k)];
    const nrm = norm(cross(sub(q[1], q[0]), sub(q[2], q[0])));
    const nn = dot(nrm, sub(q[0], [p[0], q[0][1], p[2]])) < 0 ? scale(nrm, -1) : nrm;
    const ids = q.map((c) => b.vertex(c[0], c[1], c[2], nn[0], nn[1], nn[2], 1, ay, 0, aw));
    if (dot(nrm, nn) > 0) b.quad(ids[0], ids[1], ids[2], ids[3]);
    else b.quad(ids[0], ids[3], ids[2], ids[1]);
  }
  const lid = [0, 1, 2, 3].map((k) => corner(rings[1][0], rings[1][1], k));
  const ids = lid.map((c) => b.vertex(c[0], c[1], c[2], 0, 1, 0, 1, ay, 0, aw));
  // (−,−) (+,−) (+,+) (−,+) is clockwise seen from above: wind it the other way
  b.quad(ids[0], ids[3], ids[2], ids[1]);
}

function panels(
  b: MeshBuilder,
  spec: StationSpec,
  fr: Frame,
  sized: SizedTruss,
  hubR: Float64Array,
  sy: (e: number) => number,
  ut: (e: number) => number,
  seg: number,
  rims: boolean,
) {
  const { x, ends, role } = fr;
  const P = (i: number): V3 => [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]];
  let hi = 0;
  for (let k = 1; k < x.length; k += 3) hi = Math.max(hi, x[k]);
  const edge = new Map<string, number>();
  for (let e = 0; e < ends.length / 2; e++) edge.set(`${Math.min(ends[2 * e], ends[2 * e + 1])},${Math.max(ends[2 * e], ends[2 * e + 1])}`, e);
  const memberOf = (a: number, c: number) => edge.get(`${Math.min(a, c)},${Math.max(a, c)}`);
  // a smooth seeded field over the structure: three plane waves a third of its size long
  const rng = new Rng(spec.seed ^ 0xface);
  const waves = [0, 1, 2].map(() => {
    const d = norm([rng.gauss(), rng.gauss() * 0.5, rng.gauss()]);
    return { d, k: (Math.PI * 2) / (hi * rng.range(0.9, 1.6)), ph: rng.range(0, 6.3) };
  });
  const field = (c: V3) => waves.reduce((s, w) => s + Math.cos(dot(w.d, c) * w.k + w.ph), 0);
  const inBand = fr.faces.filter((f) => {
    const t = f.reduce((s, i) => s + x[i * 3 + 1], 0) / f.length / hi;
    return spec.panels.bands.some(([a, c]) => t >= a && t <= c);
  });
  const val = inBand.map((f) => field(scale(f.reduce((s: V3, i) => add(s, P(i)), [0, 0, 0]), 1 / f.length)));
  const cut = [...val].sort((a, c) => a - c)[Math.min(val.length - 1, Math.floor((1 - spec.panels.share) * val.length))] ?? 0;
  const chosen: { f: number[]; s: number; ay: number; aw: number; r: number }[] = [];
  inBand.forEach((f, fi) => {
    if (spec.panels.share < 1 && val[fi] < cut) return;
    // stress carried round the face (ribs and braces inside it)
    const ms: number[] = [];
    for (let k = 0; k < f.length; k++) {
      const e = memberOf(f[k], f[(k + 1) % f.length]);
      if (e !== undefined) ms.push(e);
    }
    if (f.length === 4) for (const [a, c2] of [[0, 2], [1, 3]]) {
      const e = memberOf(f[a], f[c2]);
      if (e !== undefined) ms.push(e);
    }
    if (!ms.length) return;
    let s = 0;
    let ay = 0;
    let aw = 0;
    let r = 0;
    for (const e of ms) {
      s += Math.abs(sy(e)) / ms.length;
      ay += sy(e) / ms.length;
      aw += ut(e) / ms.length;
      if (role[e] !== 1) r = Math.max(r, sized.r[e]);
    }
    chosen.push({ f, s, ay, aw, r });
  });
  let smax = 0;
  for (const c of chosen) smax = Math.max(smax, c.s);
  for (const c of chosen) {
    // low stress → wide opening
    const hole = 0.18 + 0.62 * (1 - c.s / (smax || 1));
    plate(b, c.f.map(P), c.f.map((i) => hubR[i]), c.r, hole, seg, rims, c.ay, c.aw);
  }
}

/** One skin plate laid on the members (offset outward by their radius), corners clear of the hubs, pierced. */
function plate(b: MeshBuilder, corners: V3[], hr: number[], rr: number, hole: number, seg: number, rims: boolean, ay: number, aw: number) {
  const k = corners.length;
  let c: V3 = [0, 0, 0];
  for (const p of corners) c = add(c, scale(p, 1 / k));
  // Newell normal (faces are wound outward)
  let nrm: V3 = [0, 0, 0];
  for (let i = 0; i < k; i++) nrm = add(nrm, cross(corners[i], corners[(i + 1) % k]));
  nrm = norm(nrm);
  const th = Math.max(0.03, rr * 0.5);
  const lift = rr + th / 2;
  const cc = add(c, scale(nrm, lift));
  // inset corners past the hubs, sample the outline
  const inset = corners.map((p, i) => {
    const q = add(p, scale(nrm, lift));
    const toC = sub(cc, q);
    return add(q, scale(toC, Math.min(0.45, (hr[i] * 1.15) / (len(toC) || 1))));
  });
  const outer: V3[] = [];
  for (let i = 0; i < k; i++) for (let s = 0; s < seg; s++) outer.push(add(inset[i], scale(sub(inset[(i + 1) % k], inset[i]), s / seg)));
  const M = outer.length;
  // hole: the outline shrunk toward the centre and rounded toward a circle of the in-radius
  let rin = Infinity;
  for (const p of outer) rin = Math.min(rin, len(sub(p, cc)));
  const inner = outer.map((p) => {
    const dv = sub(p, cc);
    const l = len(dv) || 1;
    return add(cc, scale(dv, (hole * (0.35 * l + 0.65 * rin)) / l));
  });
  const half = scale(nrm, th / 2);
  const ring = (pts: V3[], off: V3, nn: (i: number) => V3) =>
    pts.map((p, i) => {
      const q = add(p, off);
      const v = nn(i);
      return b.vertex(q[0], q[1], q[2], v[0], v[1], v[2], 2, ay, 0, aw);
    });
  const back = scale(nrm, -1);
  const of = ring(outer, half, () => nrm);
  const inf = ring(inner, half, () => nrm);
  const ob = ring(outer, scale(half, -1), () => back);
  const ib = ring(inner, scale(half, -1), () => back);
  for (let i = 0; i < M; i++) {
    const j = (i + 1) % M;
    b.quad(of[i], of[j], inf[j], inf[i]);
    b.quad(ob[i], ib[i], ib[j], ob[j]);
  }
  if (!rims) return;
  const radial = (pts: V3[], sgn: number) => (i: number) => scale(norm(sub(pts[i], cc)), sgn);
  const hf = ring(inner, half, radial(inner, -1));
  const hb = ring(inner, scale(half, -1), radial(inner, -1));
  const rf = ring(outer, half, radial(outer, 1));
  const rb = ring(outer, scale(half, -1), radial(outer, 1));
  for (let i = 0; i < M; i++) {
    const j = (i + 1) % M;
    b.quad(hf[i], hf[j], hb[j], hb[i]);
    b.quad(rf[i], rb[i], rb[j], rf[j]);
  }
}
