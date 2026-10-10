import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
  const pos = p.getAttribute('POSITION');
  console.log('mesh', m.getName(), 'attrs', p.listSemantics(), 'verts', pos.getCount(), 'idx', p.getIndices()?.getCount(), 'min', pos.getMin([]), 'max', pos.getMax([]), 'mat', p.getMaterial()?.getName());
}
for (const t of root.listTextures()) console.log('tex', t.getName(), t.getMimeType(), t.getSize(), (t.getImage()?.byteLength/1e6).toFixed(2)+'MB');
for (const m of root.listMaterials()) console.log('mat', m.getName(), !!m.getBaseColorTexture(), !!m.getNormalTexture(), !!m.getMetallicRoughnessTexture(), !!m.getEmissiveTexture(), m.getEmissiveFactor());
for (const n of root.listNodes()) console.log('node', n.getName(), n.getTranslation(), n.getRotation(), n.getScale());
console.log('exts', root.listExtensionsUsed().map(e => e.extensionName));
