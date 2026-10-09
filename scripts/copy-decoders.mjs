// Copies the Draco and Basis (KTX2) decoders into public/ so GLB assets listed in the manifest can be decoded.
// Only needed once a manifest entry points at a compressed GLB; the procedural fallbacks need nothing.
import { cpSync, mkdirSync } from 'node:fs';
const src = 'node_modules/three/examples/jsm/libs';
for (const lib of ['draco/gltf', 'basis']) {
  const out = `public/assets/decoders/${lib.split('/')[0]}`;
  mkdirSync(out, { recursive: true });
  cpSync(`${src}/${lib}`, out, { recursive: true });
  console.log('copied', lib, '->', out);
}
