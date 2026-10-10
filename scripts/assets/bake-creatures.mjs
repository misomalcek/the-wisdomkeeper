// Offline hi-fi bake of the sculpted creatures: node scripts/assets/bake-creatures.mjs [name ...]
//
// The runtime sculpts (src/assets/*Model.ts) polygonise at ~4 cm with no surface detail. Here the same
// primitives are polygonised at ~1 cm with the creature's detail function carved into the field (sinew
// striations, bark fissures, crystal facets) and field-baked occlusion, then simplified with meshoptimizer
// to a game budget (normal + material + AO aware) and written as a meshopt-compressed skinned GLB that the
// asset manifest points at. The runtime falls back to its own sculpt when the GLB is missing.
import path from 'node:path';
import fs from 'node:fs';
import { runnerImport } from 'vite';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder, prune } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

/** Bake registry: module, geometry factory, optional rig factory, cell (m), triangle budget, output. */
const JOBS = {
  voidRootFiend: { mod: 'src/assets/fiendModel.ts', geo: 'fiendGeometry', rig: 'buildFiendRig', cell: 0.011, tris: 60000, out: 'models/void-root-fiend.glb' },
};

async function bake(name, job) {
  const { module: M } = await runnerImport(path.join(root, job.mod), { root, logLevel: 'error' });
  log(name, 'sculpting at', job.cell, 'm with detail');
  const g = M[job.geo]({ cell: job.cell, detail: true });
  const pos = g.getAttribute('position').array;
  const nor = g.getAttribute('normal').array;
  const amat = g.getAttribute('aMat').array;
  const ao = g.getAttribute('aAO').array;
  const si = g.getAttribute('skinIndex')?.array;
  const sw = g.getAttribute('skinWeight')?.array;
  const idx = new Uint32Array(g.index.array);
  const nv = pos.length / 3;
  log(name, 'high-res', nv, 'verts', idx.length / 3, 'tris');

  // simplify: weld-free surface nets output is already indexed; weight normals, AO and material borders
  await MeshoptSimplifier.ready;
  const attr = new Float32Array(nv * 8);
  for (let i = 0; i < nv; i++) attr.set([nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2], ao[i], amat[i * 4], amat[i * 4 + 1], amat[i * 4 + 2], amat[i * 4 + 3]], i * 8);
  const [lod, err] = MeshoptSimplifier.simplifyWithAttributes(idx, new Float32Array(pos), 3, attr, 8, [0.5, 0.5, 0.5, 0.8, 1, 1, 1, 1], null, job.tris * 3, 0.02, []);
  log(name, 'simplified to', lod.length / 3, 'tris, error', err.toExponential(2));
  // compact the vertex buffer to the vertices still referenced
  const remap = new Int32Array(nv).fill(-1);
  let n = 0;
  for (const i of lod) if (remap[i] < 0) remap[i] = n++;
  const P = new Float32Array(n * 3), Nn = new Float32Array(n * 3), MA = new Float32Array(n * 4), AO = new Float32Array(n);
  const J = new Uint16Array(n * 4), W = new Float32Array(n * 4);
  for (let i = 0; i < nv; i++) {
    const r = remap[i];
    if (r < 0) continue;
    P.set(pos.subarray(i * 3, i * 3 + 3), r * 3);
    Nn.set(nor.subarray(i * 3, i * 3 + 3), r * 3);
    MA.set(amat.subarray(i * 4, i * 4 + 4), r * 4);
    AO[r] = ao[i];
    if (si) {
      J.set(si.subarray(i * 4, i * 4 + 4), r * 4);
      W.set(sw.subarray(i * 4, i * 4 + 4), r * 4);
    }
  }
  const I = new Uint32Array(lod.length);
  for (let i = 0; i < lod.length; i++) I[i] = remap[lod[i]];

  const doc = new Document();
  doc.createBuffer();
  const acc = (nm, arr, type) => doc.createAccessor(nm).setArray(arr).setType(type);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('p', P, 'VEC3'))
    .setAttribute('NORMAL', acc('n', Nn, 'VEC3'))
    .setAttribute('_AMAT', acc('m', MA, 'VEC4'))
    .setAttribute('_AO', acc('ao', AO, 'SCALAR'))
    .setIndices(acc('i', I, 'SCALAR'))
    .setMaterial(doc.createMaterial(name).setRoughnessFactor(0.6));
  const scene = doc.createScene(name);
  const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
  if (si && job.rig) {
    prim.setAttribute('JOINTS_0', acc('j', J, 'VEC4')).setAttribute('WEIGHTS_0', acc('w', W, 'VEC4'));
    const rig = M[job.rig]();
    const bones = rig.bones;
    const nodes = bones.map((b, i) => doc.createNode(`j${i}`).setTranslation([b.position.x, b.position.y, b.position.z]));
    bones.forEach((b, i) => {
      const pi = bones.indexOf(b.parent);
      if (pi >= 0) nodes[pi].addChild(nodes[i]);
    });
    const ibm = new Float32Array(bones.length * 16);
    bones.forEach((b, i) => {
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.clone().invert().elements;
      ibm.set(e, i * 16);
    });
    const skin = doc.createSkin('rig').setSkeleton(nodes[0]).setInverseBindMatrices(acc('ibm', ibm, 'MAT4'));
    nodes.forEach((nd) => skin.addJoint(nd));
    node.setSkin(skin);
    scene.addChild(nodes[0]);
  }
  scene.addChild(node);
  await MeshoptEncoder.ready;
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 14, quantizeNormal: 10, pattern: /^(POSITION|NORMAL|_AMAT|_AO|WEIGHTS_0)$/ }), prune());
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const out = path.join(root, 'public/assets', job.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await io.write(out, doc);
  log(name, 'wrote', path.relative(root, out), (fs.statSync(out).size / 1e6).toFixed(2), 'MB');
}

const names = process.argv.slice(2);
for (const [name, job] of Object.entries(JOBS)) if (!names.length || names.includes(name)) await bake(name, job);
process.exit(0);
