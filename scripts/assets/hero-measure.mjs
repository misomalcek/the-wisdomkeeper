// Slice profile of the Tripo hero in game space (faces +Z, spear hand at +X): finds landmarks for rig fitting.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2] ?? 'public/raw/hero-tripo.glb');
await doc.transform(dequantize());
const P0 = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION').getArray();
const n = P0.length / 3;
// game space: x' = -z, z' = -x (rotate to face +Z, mirrored so the spear hand is the rig's +X "R" side)
const P = new Float32Array(n * 3);
for (let i = 0; i < n; i++) { P[i*3] = -P0[i*3+2]; P[i*3+1] = P0[i*3+1]; P[i*3+2] = -P0[i*3]; }
const tip = [-0.269, 0.49, -0.111];
const d = [0.4915, -0.8708, 0.013];
const spear = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  const v = [P[i*3]-tip[0], P[i*3+1]-tip[1], P[i*3+2]-tip[2]];
  const t = v[0]*d[0]+v[1]*d[1]+v[2]*d[2];
  if (t < -0.01 || t > 1.25) continue;
  const r2 = v[0]*v[0]+v[1]*v[1]+v[2]*v[2]-t*t;
  const r = t < 0.22 ? 0.04 : 0.016;
  if (r2 < r*r) spear[i] = 1;
}
let ns = 0; for (const s of spear) ns += s;
console.log('spear verts', ns);
const ys = [];
for (let y = -0.49; y < 0.5; y += 0.02) {
  const xs = [];
  let zmin = 9, zmax = -9;
  for (let i = 0; i < n; i += 4) if (!spear[i] && Math.abs(P[i*3+1] - y) < 0.01) { xs.push(P[i*3]); zmin = Math.min(zmin, P[i*3+2]); zmax = Math.max(zmax, P[i*3+2]); }
  xs.sort((a, b) => a - b);
  // clusters along x separated by gaps > 0.012
  const cl = []; let s = xs[0];
  for (let k = 1; k <= xs.length; k++) if (k === xs.length || xs[k] - xs[k-1] > 0.012) { cl.push([s, xs[k-1]]); s = xs[k]; }
  console.log(y.toFixed(2), xs.length, cl.map(([a, b]) => `[${a.toFixed(3)},${b.toFixed(3)}]`).join(' '), 'z', zmin.toFixed(3), zmax.toFixed(3));
}
