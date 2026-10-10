// List connected components (position-welded) of a GLB's first primitive: node scripts/assets/components.mjs <glb>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
await doc.transform(dequantize());
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const P = prim.getAttribute('POSITION').getArray();
const I = prim.getIndices().getArray();
const n = P.length / 3;
const key = new Map(); const canon = new Int32Array(n);
for (let i = 0; i < n; i++) { const k = `${Math.round(P[i*3]*2e4)},${Math.round(P[i*3+1]*2e4)},${Math.round(P[i*3+2]*2e4)}`; let c = key.get(k); if (c === undefined) { c = i; key.set(k, i); } canon[i] = c; }
const par = new Int32Array(n).map((_, i) => i);
const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
for (let t = 0; t < I.length; t += 3) { const a = find(canon[I[t]]), b = find(canon[I[t+1]]), c = find(canon[I[t+2]]); par[b] = a; par[find(c)] = a; }
const comps = new Map();
for (let i = 0; i < n; i++) { const r = find(canon[i]); let c = comps.get(r); if (!c) comps.set(r, c = { n: 0, min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] }); c.n++; for (let k = 0; k < 3; k++) { c.min[k] = Math.min(c.min[k], P[i*3+k]); c.max[k] = Math.max(c.max[k], P[i*3+k]); } }
const list = [...comps.values()].sort((a, b) => b.n - a.n);
console.log('components', list.length);
for (const c of list.slice(0, 25)) console.log(c.n, c.min.map((v) => v.toFixed(3)).join(','), '|', c.max.map((v) => v.toFixed(3)).join(','));
