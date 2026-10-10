// Turn the Tripo hero sculpt (≈2M triangles, 3×4K maps, unrigged) into the game's hero asset:
//   node scripts/assets/build-hero.mjs [src.glb] [out.glb]
//
// 1. orient to the engine (faces +Z, mirrored so the spear hand is the rig's +X "R" side) and scale to 2.1 m
// 2. cut the Root-Blade spear out of the body along its fitted axis
// 3. simplify both with meshoptimizer (attribute- and seam-aware), body ≈ 70k tris, spear ≈ 9k
// 4. fit the engine's 17-bone rig to body landmarks (slice centroids) and skin it: inverse-distance weights to
//    bone segments, normalised by limb radius, side-gated, then smoothed over the welded mesh
// 5. textures to 2K WebP, geometry meshopt-compressed; the spear ships as an unskinned `rootBlade` node in
//    grip space (hand at the origin, tip along +Y), like the procedural blade it replaces
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dequantize, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { findAxis } from './axis.mjs';

const [src = 'public/raw/hero-tripo.glb', out = 'public/assets/models/hero.glb'] = process.argv.slice(2);
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const doc = await io.read(src);
await doc.transform(dequantize());
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const P0 = prim.getAttribute('POSITION').getArray();
const N0 = prim.getAttribute('NORMAL').getArray();
const U0 = prim.getAttribute('TEXCOORD_0').getArray();
const I0 = prim.getIndices().getArray();
const n0 = P0.length / 3;
log('source', n0, 'verts', I0.length / 3, 'tris');

// ---- 1. orient + scale -------------------------------------------------------------------------------
// source faces -X; x' = -z, z' = -x turns it to face +Z with the spear hand on the rig's +X side. That is a
// mirror, so triangle winding is reversed below.
let yMin = Infinity, yMax = -Infinity;
for (let i = 0; i < n0; i++) {
  yMin = Math.min(yMin, P0[i * 3 + 1]);
  yMax = Math.max(yMax, P0[i * 3 + 1]);
}
const axis = findAxis(P0);
const tipY = axis.tip[1];
// body top: highest vertex well away from the spear
const HEIGHT = 2.1;
const P = new Float32Array(n0 * 3);
const N = new Float32Array(n0 * 3);
const raw = (i) => [-P0[i * 3 + 2], P0[i * 3 + 1] - yMin, -P0[i * 3]];
const tipG = [-axis.tip[2], axis.tip[1] - yMin, -axis.tip[0]];
const dG = [-axis.d[2], axis.d[1], -axis.d[0]];
const spearT = (x, y, z) => {
  const v = [x - tipG[0], y - tipG[1], z - tipG[2]];
  const t = v[0] * dG[0] + v[1] * dG[1] + v[2] * dG[2];
  return { t, r2: v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - t * t };
};
let bodyTop = 0;
for (let i = 0; i < n0; i += 3) {
  const [x, y, z] = raw(i);
  const { t, r2 } = spearT(x, y, z);
  if (t > -0.02 && t < 1.4 && r2 < 0.05 * 0.05) continue;
  bodyTop = Math.max(bodyTop, y);
}
const S = HEIGHT / bodyTop;
log('scale', S.toFixed(3), 'body top (src units)', bodyTop.toFixed(3), 'spear tip y', (tipY - yMin).toFixed(3));
for (let i = 0; i < n0; i++) {
  const [x, y, z] = raw(i);
  P[i * 3] = x * S;
  P[i * 3 + 1] = y * S;
  P[i * 3 + 2] = z * S;
  N[i * 3] = -N0[i * 3 + 2];
  N[i * 3 + 1] = N0[i * 3 + 1];
  N[i * 3 + 2] = -N0[i * 3];
}
for (let k = 0; k < 3; k++) tipG[k] *= S;
const I = new Uint32Array(I0.length);
for (let i = 0; i < I0.length; i += 3) I.set([I0[i], I0[i + 2], I0[i + 1]], i);

// ---- 2. spear segmentation ---------------------------------------------------------------------------
// The fitted axis runs from the staff's gnarled butt (the model's highest point) down through the hand to the
// leaf blade below it. Extent: contiguous occupancy along the axis allowing small gaps (the hand interrupts it).
const bins = new Uint8Array(400);
for (let i = 0; i < n0; i += 2) {
  const { t, r2 } = spearT(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  if (t >= 0 && t < 4 && r2 < 0.05 ** 2) bins[(t * 100) | 0] = 1;
}
let tEnd = 0;
while (tEnd < 390 && bins.subarray(tEnd, tEnd + 9).some(Boolean)) tEnd++;
const spearLen = tEnd / 100;
// the right hand closes on the shaft just below the wrist (source wrist height −0.235)
const tHand = ((-0.235 + 0.489) * S - 0.06 - tipG[1]) / dG[1];
// regions (game space, metres): the shaft along the axis; the gnarled butt and its twigs up and left of the
// crest; a thin core through the closed hand; and the leaf blade hanging below the hand, outside the thigh
const isSpear = new Uint8Array(n0);
for (let i = 0; i < n0; i++) {
  const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
  const { t, r2 } = spearT(x, y, z);
  const r = Math.sqrt(Math.max(r2, 0));
  const shaft = t > -0.06 && t < tHand - 0.13 && r < 0.07;
  const butt = t > -0.06 && t < 0.9 && r < 0.26 && x < -0.27 && y > 1.8;
  const grip = t >= tHand - 0.13 && t < tHand + 0.12 && r < 0.026;
  const blade = y < 0.52 && x > 0.38;
  if (shaft || butt || grip || blade) isSpear[i] = 1;
}
const bodyIdx = [], spearIdx = [];
for (let t = 0; t < I.length; t += 3) {
  const s = isSpear[I[t]] + isSpear[I[t + 1]] + isSpear[I[t + 2]];
  (s === 3 ? spearIdx : bodyIdx).push(I[t], I[t + 1], I[t + 2]);
}
log('spear length', spearLen.toFixed(2), 'm, hand at', tHand.toFixed(2), 'm,', spearIdx.length / 3, 'tris; body', bodyIdx.length / 3, 'tris');

// ---- 3. simplify ---------------------------------------------------------------------------------------
function compact(idx) {
  const map = new Int32Array(n0).fill(-1);
  const pos = [], nor = [], uv = [], out = new Uint32Array(idx.length);
  let k = 0;
  for (let j = 0; j < idx.length; j++) {
    const v = idx[j];
    if (map[v] < 0) {
      map[v] = k++;
      pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      nor.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
      uv.push(U0[v * 2], U0[v * 2 + 1]);
    }
    out[j] = map[v];
  }
  return { pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: Float32Array.from(uv), idx: out };
}
function simplify(m, targetTris, err) {
  const attrs = new Float32Array((m.pos.length / 3) * 5);
  for (let i = 0; i < m.pos.length / 3; i++) {
    attrs.set([m.nor[i * 3], m.nor[i * 3 + 1], m.nor[i * 3 + 2], m.uv[i * 2], m.uv[i * 2 + 1]], i * 5);
  }
  const [idx, e] = MeshoptSimplifier.simplifyWithAttributes(m.idx, m.pos, 3, attrs, 5, [0.6, 0.6, 0.6, 2.5, 2.5], null, targetTris * 3, err, []);
  log('  simplified to', idx.length / 3, 'tris, error', e.toExponential(2));
  // drop unreferenced vertices
  const used = new Int32Array(m.pos.length / 3).fill(-1);
  let k = 0;
  for (const v of idx) if (used[v] < 0) used[v] = k++;
  const pos = new Float32Array(k * 3), nor = new Float32Array(k * 3), uv = new Float32Array(k * 2);
  for (let v = 0; v < used.length; v++) {
    const j = used[v];
    if (j < 0) continue;
    pos.set(m.pos.subarray(v * 3, v * 3 + 3), j * 3);
    nor.set(m.nor.subarray(v * 3, v * 3 + 3), j * 3);
    uv.set(m.uv.subarray(v * 2, v * 2 + 2), j * 2);
  }
  return { pos, nor, uv, idx: Uint32Array.from(idx, (v) => used[v]) };
}
log('simplifying body');
const body = simplify(compact(bodyIdx), 72000, 0.02);
log('simplifying spear');
const spear = simplify(compact(spearIdx), 9000, 0.02);

// ---- 3b. legs ------------------------------------------------------------------------------------------
// The source sculpt was generated from a reference cropped at the knees, so it ends just below them. Lift the
// figure by the missing shin and foot and scale it back to HEIGHT; the lower legs are the sculpted mycelial
// boots (src/assets/bootModel.ts), skinned to the knee and ankle bones fitted here.
const KNEE_ABOVE_CUT = 0.04, SHIN = 0.52, ANKLE = 0.09;
const LIFT = SHIN + ANKLE - KNEE_ABOVE_CUT;
const K = HEIGHT / (HEIGHT + LIFT);
const relift = (arr) => {
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] *= K;
    arr[i + 1] = (arr[i + 1] + LIFT) * K;
    arr[i + 2] *= K;
  }
};
relift(body.pos);
relift(spear.pos);
relift(tipG);
const tHandK = tHand * K;
const CUT_Y = LIFT * K;
log('legs: lift', LIFT.toFixed(3), 'scale', K.toFixed(3), 'cut at', CUT_Y.toFixed(3), 'm');
const spearWorld = spear.pos.slice();

// ---- 4. rig fit ----------------------------------------------------------------------------------------
// landmarks as fractions of body height (measured on the slice profile of the source, see hero-measure.mjs)
const H = HEIGHT;
const nb = body.pos.length / 3;
function centroid(y0, y1, x0, x1) {
  let sx = 0, sy = 0, sz = 0, c = 0, zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < nb; i++) {
    const x = body.pos[i * 3], y = body.pos[i * 3 + 1], z = body.pos[i * 3 + 2];
    if (y < y0 * H || y > y1 * H || x < x0 * H || x > x1 * H) continue;
    sx += x; sy += y; sz += z; c++;
    zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
  }
  if (!c) throw new Error(`empty landmark ${[y0, y1, x0, x1]}`);
  // z: centre of the slab rather than the vertex mean (dense detail on one side would bias it)
  return [sx / c, sy / c, (zmin + zmax) / 2];
}
// source-frame y → fraction of height (after the leg lift), source x → fraction of height
const yf = (srcY) => (((srcY + 0.49) / bodyTop) * H + LIFT) * K / H;
const xf = (srcX) => (srcX / bodyTop) * K;
const J = {};
// a limb's centre at height y: cluster the slab's vertices in the xz-plane (1.5 cm cells, flood fill) and take
// the bounding-box centre of the cluster nearest the expected x
function limbCenter(srcY, srcX, half = 0.012) {
  const y0 = yf(srcY - half) * H, y1 = yf(srcY + half) * H;
  const cell = 0.015, grid = new Map();
  for (let i = 0; i < nb; i++) {
    const y = body.pos[i * 3 + 1];
    if (y < y0 || y > y1) continue;
    const gx = Math.floor(body.pos[i * 3] / cell), gz = Math.floor(body.pos[i * 3 + 2] / cell);
    grid.set(gx * 100000 + gz, [gx, gz]);
  }
  const seen = new Set();
  let best = null;
  for (const [k, [gx, gz]] of grid) {
    if (seen.has(k)) continue;
    const q = [[gx, gz]];
    seen.add(k);
    let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
    for (let h = 0; h < q.length; h++) {
      const [a, b] = q[h];
      xmin = Math.min(xmin, a); xmax = Math.max(xmax, a); zmin = Math.min(zmin, b); zmax = Math.max(zmax, b);
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
        const kk = (a + da) * 100000 + (b + db);
        if (grid.has(kk) && !seen.has(kk)) { seen.add(kk); q.push([a + da, b + db]); }
      }
    }
    const cx = ((xmin + xmax + 1) / 2) * cell, cz = ((zmin + zmax + 1) / 2) * cell;
    const d = Math.abs(cx - xf(srcX) * H);
    if (q.length > 3 && (!best || d < best.d)) best = { d, c: [cx, (y0 + y1) / 2, cz], w: (xmax - xmin + 1) * cell };
  }
  if (!best) throw new Error(`no limb at ${srcY},${srcX}`);
  return best.c;
}
const at = (name, p) => (J[name] = p);
at('body', [0, 0, 0]);
const pel = limbCenter(-0.03, 0, 0.01);
at('hips', [0, pel[1], pel[2]]);
const sp = limbCenter(0.005, 0, 0.01), ch = limbCenter(0.055, 0, 0.01), hd = limbCenter(0.145, 0, 0.01), nk = limbCenter(0.118, 0, 0.01);
at('spine', [0, sp[1], sp[2]]);
at('chest', [0, ch[1], ch[2]]);
// the helm slab mixes the crest strands in; the neck gives a cleaner fore-aft centre for the head pivot
at('head', [0, hd[1], nk[2]]);
// legs: the bounding-box centre of the slab inside a window on that side (legs never touch the hands there)
function slabCenter(srcY, x0, x1, half = 0.012) {
  const y0 = yf(srcY - half) * H, y1 = yf(srcY + half) * H;
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (let i = 0; i < nb; i++) {
    const x = body.pos[i * 3], y = body.pos[i * 3 + 1], z = body.pos[i * 3 + 2];
    if (y < y0 || y > y1 || x < x0 || x > x1) continue;
    a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z);
  }
  return [(a + b) / 2, (y0 + y1) / 2, (c + d) / 2];
}
const X = { th: [-0.055, 0.065], kn: [-0.05, 0.085], ft: [-0.105, 0.097], el: [-0.145, 0.152], hd: [-0.156, 0.19] };
// the stump just above the cut: its centre and half-extents seat the knee joint and the boot cuff
function stumpAt(y, x0, x1) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (let i = 0; i < nb; i++) {
    const x = body.pos[i * 3], yy = body.pos[i * 3 + 1], z = body.pos[i * 3 + 2];
    if (Math.abs(yy - y) > 0.012 || x < x0 || x > x1) continue;
    a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z);
  }
  return { c: [(a + b) / 2, y, (c + d) / 2], rx: (b - a) / 2, rz: (d - c) / 2 };
}
const STUMP = {};
for (const [s, k] of [['L', 0], ['R', 1]]) {
  const st = (STUMP[s] = stumpAt(CUT_Y + 0.03, k ? 0 : -0.5, k ? 0.5 : 0));
  const top = stumpAt(CUT_Y + 0.12, k ? 0 : -0.5, k ? 0.5 : 0);
  st.top = top;
  at(`kn${s}`, [st.c[0], CUT_Y + KNEE_ABOVE_CUT * K, st.c[2]]);
  at(`th${s}`, [J[`kn${s}`][0] * 0.72, yf(-0.065) * H, J.hips[2]]);
  at(`ft${s}`, [st.c[0] * 1.05, ANKLE * K, st.c[2] - 0.02]);
  at(`el${s}`, limbCenter(-0.08, X.el[k]));
  at(`hd${s}`, limbCenter(-0.235, X.hd[k]));
  // shoulder: under the deltoid, two thirds out from the spine to the arm's outer edge
  const sh = J[`el${s}`];
  at(`sh${s}`, [(k ? 1 : -1) * Math.max(0.14, Math.abs(sh[0]) * 0.55), yf(0.095) * H, J.chest[2]]);
}
if (process.env.DEBUG_FIT) {
  // front (x,y) and side (z,y) point plots with joints, for checking the fit by eye
  const Wd = 900, Hd = 900, img = new Uint8Array(Wd * Hd * 3);
  const put = (px, py, r, g, b) => { if (px >= 0 && py >= 0 && px < Wd && py < Hd) img.set([r, g, b], (py * Wd + px) * 3); };
  const k = Hd / 2.3;
  for (let i = 0; i < nb; i++) {
    const x = body.pos[i * 3], y = body.pos[i * 3 + 1], z = body.pos[i * 3 + 2];
    put(Math.round(225 + x * k), Math.round(Hd - 20 - y * k), 120, 160, 200);
    put(Math.round(675 + z * k), Math.round(Hd - 20 - y * k), 120, 160, 200);
  }
  for (let i = 0; i < spear.pos.length / 3; i++) {
    const x = spearWorld[i * 3], y = spearWorld[i * 3 + 1], z = spearWorld[i * 3 + 2];
    put(Math.round(225 + x * k), Math.round(Hd - 20 - y * k), 255, 170, 60);
    put(Math.round(675 + z * k), Math.round(Hd - 20 - y * k), 255, 170, 60);
  }
  for (const v of Object.values(J)) for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) {
    put(Math.round(225 + v[0] * k) + a, Math.round(Hd - 20 - v[1] * k) + b, 255, 60, 60);
    put(Math.round(675 + v[2] * k) + a, Math.round(Hd - 20 - v[1] * k) + b, 255, 60, 60);
  }
  await sharp(Buffer.from(img), { raw: { width: Wd, height: Hd, channels: 3 } }).png().toFile(process.env.DEBUG_FIT);
}
for (const [k, v] of Object.entries(J)) log('joint', k.padEnd(6), v.map((x) => x.toFixed(3)).join(' '));
for (const [s, st] of Object.entries(STUMP)) log('stump', s, st.c.map((x) => x.toFixed(3)).join(' '), 'r', st.rx.toFixed(3), st.rz.toFixed(3), 'top r', st.top.rx.toFixed(3), st.top.rz.toFixed(3));
(await import('node:fs')).writeFileSync('src/assets/hero-fit.json', JSON.stringify({ joints: J, stump: STUMP, cutY: CUT_Y, scale: K }, (_, v) => (typeof v === 'number' ? +v.toFixed(4) : v), 1) + '\n');

// ---- 5. skin weights -----------------------------------------------------------------------------------
const BONE = { body: 0, hips: 1, spine: 2, chest: 3, head: 4, thL: 5, knL: 6, ftL: 7, thR: 8, knR: 9, ftR: 10, shL: 11, elL: 12, hdL: 13, shR: 14, elR: 15, hdR: 16 };
const PARENT = { hips: 'body', spine: 'hips', chest: 'spine', head: 'chest', thL: 'hips', knL: 'thL', ftL: 'knL', thR: 'hips', knR: 'thR', ftR: 'knR', shL: 'chest', elL: 'shL', hdL: 'elL', shR: 'chest', elR: 'shR', hdR: 'elR' };
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const scale = (a, s) => a.map((v) => v * s);
const handDir = (s) => scale(sub(J[`hd${s}`], J[`el${s}`]), 0.55);
// segment, radius (m), side gate (-1 left only, 1 right only, 0 both), y gate (max height for legs)
const SEG = [
  ['hips', J.hips, J.spine, 0.2, 0],
  ['spine', J.spine, J.chest, 0.19, 0],
  ['chest', J.chest, J.head, 0.21, 0],
  ['head', J.head, add(J.head, [0, 0.45, -0.05]), 0.17, 0],
  ['thL', J.thL, J.knL, 0.11, -1], ['knL', J.knL, J.ftL, 0.085, -1], ['ftL', J.ftL, add(J.ftL, [0, -0.06, 0.2]), 0.07, -1],
  ['thR', J.thR, J.knR, 0.11, 1], ['knR', J.knR, J.ftR, 0.085, 1], ['ftR', J.ftR, add(J.ftR, [0, -0.06, 0.2]), 0.07, 1],
  ['shL', J.shL, J.elL, 0.075, -1], ['elL', J.elL, J.hdL, 0.06, -1], ['hdL', J.hdL, add(J.hdL, handDir('L')), 0.05, -1],
  ['shR', J.shR, J.elR, 0.075, 1], ['elR', J.elR, J.hdR, 0.06, 1], ['hdR', J.hdR, add(J.hdR, handDir('R')), 0.05, 1],
];
const segDist = (p, a, b) => {
  const ab = sub(b, a), ap = sub(p, a);
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
};
const NB = 17;
const W = new Float32Array(nb * NB);
const crotchY = J.hips[1] - 0.06;
for (let i = 0; i < nb; i++) {
  const p = [body.pos[i * 3], body.pos[i * 3 + 1], body.pos[i * 3 + 2]];
  let sum = 0;
  for (const [name, a, b, r, side] of SEG) {
    const isLeg = name.startsWith('th') || name.startsWith('kn') || name.startsWith('ft');
    const isArm = name.startsWith('sh') || name.startsWith('el') || name.startsWith('hd');
    if (side && Math.sign(p[0] - side * 0.0) !== side && Math.abs(p[0]) > 0.025) continue;
    if (isLeg && p[1] > J.hips[1] + 0.08) continue;
    if (isArm && p[1] > J[`sh${side < 0 ? 'L' : 'R'}`][1] + 0.18) continue;
    if (!isLeg && !isArm && name !== 'hips' && p[1] < crotchY - 0.05) continue;
    const d = segDist(p, a, b) / r;
    const w = 1 / Math.pow(Math.max(d, 0.25), 6);
    W[i * NB + BONE[name]] = w;
    sum += w;
  }
  if (sum <= 0) W[i * NB + BONE.hips] = sum = 1;
  for (let k = 0; k < NB; k++) W[i * NB + k] /= sum;
}
// smooth over welded adjacency so seams and joint creases blend
const key = new Map(), canon = new Int32Array(nb);
for (let i = 0; i < nb; i++) {
  const k = `${Math.round(body.pos[i * 3] * 1e4)},${Math.round(body.pos[i * 3 + 1] * 1e4)},${Math.round(body.pos[i * 3 + 2] * 1e4)}`;
  if (!key.has(k)) key.set(k, i);
  canon[i] = key.get(k);
}
const nbrs = Array.from({ length: nb }, () => new Set());
for (let t = 0; t < body.idx.length; t += 3) {
  const a = canon[body.idx[t]], b = canon[body.idx[t + 1]], c = canon[body.idx[t + 2]];
  nbrs[a].add(b).add(c); nbrs[b].add(a).add(c); nbrs[c].add(a).add(b);
}
for (let it = 0; it < 4; it++) {
  const next = new Float32Array(W);
  for (let i = 0; i < nb; i++) {
    if (canon[i] !== i || !nbrs[i].size) continue;
    for (let k = 0; k < NB; k++) {
      let s = 0;
      for (const j of nbrs[i]) s += W[j * NB + k];
      next[i * NB + k] = W[i * NB + k] * 0.5 + (s / nbrs[i].size) * 0.5;
    }
  }
  W.set(next);
}
for (let i = 0; i < nb; i++) if (canon[i] !== i) W.set(W.subarray(canon[i] * NB, canon[i] * NB + NB), i * NB);
const joints = new Uint16Array(nb * 4), weights = new Float32Array(nb * 4);
for (let i = 0; i < nb; i++) {
  const order = [...Array(NB).keys()].sort((a, b) => W[i * NB + b] - W[i * NB + a]).slice(0, 4);
  let s = 0;
  for (const k of order) s += W[i * NB + k];
  order.forEach((k, j) => {
    joints[i * 4 + j] = k;
    weights[i * 4 + j] = W[i * NB + k] / s;
  });
}
log('skinned', nb, 'vertices');

// ---- spear into grip space: hand at origin, tip along +Y ----------------------------------------------
// the grip point is where the right hand closes on the shaft: the axis point nearest the fitted wrist
const grip = add(tipG, scale(dG, tHandK));
// basis: y' = -d (toward tip); x' ⟂ in the horizontal plane; z' = x' × y'
const yA = scale(dG, -1);
let xA = [yA[2], 0, -yA[0]];
const xl = Math.hypot(...xA) || 1;
xA = scale(xA, 1 / xl);
const zA = [xA[1] * yA[2] - xA[2] * yA[1], xA[2] * yA[0] - xA[0] * yA[2], xA[0] * yA[1] - xA[1] * yA[0]];
const ns = spear.pos.length / 3;
for (let i = 0; i < ns; i++) {
  const v = sub([spear.pos[i * 3], spear.pos[i * 3 + 1], spear.pos[i * 3 + 2]], grip);
  const nv = [spear.nor[i * 3], spear.nor[i * 3 + 1], spear.nor[i * 3 + 2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  spear.pos.set([dot(v, xA), dot(v, yA), dot(v, zA)], i * 3);
  spear.nor.set([dot(nv, xA), dot(nv, yA), dot(nv, zA)], i * 3);
}
log('spear grip at', tHand.toFixed(2), 'm from tip');

// ---- 6. write the asset --------------------------------------------------------------------------------
const outDoc = new Document();
outDoc.createBuffer();
const R = outDoc.getRoot();
const material = outDoc.createMaterial('wisdomkeeper').setRoughnessFactor(1).setMetallicFactor(1);
const srcMat = prim.getMaterial();
const texOut = async (tex, name, q) => {
  const img = await sharp(Buffer.from(tex.getImage())).resize(2048, 2048).webp({ quality: q, effort: 5 }).toBuffer();
  return outDoc.createTexture(name).setImage(new Uint8Array(img)).setMimeType('image/webp');
};
material.setBaseColorTexture(await texOut(srcMat.getBaseColorTexture(), 'color', 88));
material.setMetallicRoughnessTexture(await texOut(srcMat.getMetallicRoughnessTexture(), 'orm', 90));
material.setOcclusionTexture(material.getMetallicRoughnessTexture());
material.setNormalTexture(await texOut(srcMat.getNormalTexture(), 'normal', 92));
outDoc.createExtension(EXTTextureWebP).setRequired(true);
log('textures 2K webp');

const acc = (name, arr, type) => outDoc.createAccessor(name).setArray(arr).setType(type);
const bodyPrim = outDoc.createPrimitive()
  .setAttribute('POSITION', acc('p', body.pos, 'VEC3'))
  .setAttribute('NORMAL', acc('n', body.nor, 'VEC3'))
  .setAttribute('TEXCOORD_0', acc('uv', body.uv, 'VEC2'))
  .setAttribute('JOINTS_0', acc('j', joints, 'VEC4'))
  .setAttribute('WEIGHTS_0', acc('w', weights, 'VEC4'))
  .setIndices(acc('i', body.idx, 'SCALAR'))
  .setMaterial(material);
const spearPrim = outDoc.createPrimitive()
  .setAttribute('POSITION', acc('sp', spear.pos, 'VEC3'))
  .setAttribute('NORMAL', acc('sn', spear.nor, 'VEC3'))
  .setAttribute('TEXCOORD_0', acc('suv', spear.uv, 'VEC2'))
  .setIndices(acc('si', spear.idx, 'SCALAR'))
  .setMaterial(material);
const scene = outDoc.createScene('hero');
const nodes = {};
for (const name of Object.keys(BONE)) {
  const parent = PARENT[name];
  const local = parent ? sub(J[name], J[parent]) : J[name];
  nodes[name] = outDoc.createNode(name).setTranslation(local);
}
for (const [c, p] of Object.entries(PARENT)) nodes[p].addChild(nodes[c]);
const ibm = new Float32Array(17 * 16);
Object.keys(BONE).forEach((name, i) => {
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -J[name][0], -J[name][1], -J[name][2], 1];
  ibm.set(m, i * 16);
});
const skin = outDoc.createSkin('rig').setSkeleton(nodes.body).setInverseBindMatrices(acc('ibm', ibm, 'MAT4'));
for (const name of Object.keys(BONE)) skin.addJoint(nodes[name]);
const bodyNode = outDoc.createNode('wisdomkeeper').setMesh(outDoc.createMesh('body').addPrimitive(bodyPrim)).setSkin(skin);
const bladeNode = outDoc.createNode('rootBlade').setMesh(outDoc.createMesh('rootBlade').addPrimitive(spearPrim));
scene.addChild(nodes.body).addChild(bodyNode).addChild(bladeNode);
R.setDefaultScene(scene);
outDoc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await outDoc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8 }));
outDoc.createExtension(KHRMeshQuantization).setRequired(true);
const outIO = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await outIO.write(out, outDoc);
const { size } = await import('node:fs').then((fs) => fs.statSync(out));
log('wrote', out, (size / 1e6).toFixed(2), 'MB');
