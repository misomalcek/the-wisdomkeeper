// Find the spear's axis in the Tripo hero: node scripts/assets/spear.mjs <glb>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
console.time('read');
const doc = await io.read(process.argv[2]);
await doc.transform(dequantize());
console.timeEnd('read');
const P = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION').getArray();
import { findAxis } from './axis.mjs';
console.time('axis');
const a = findAxis(P);
console.timeEnd('axis');
console.log(JSON.stringify(a));
