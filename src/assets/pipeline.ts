import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { BONE } from './heroModel';

/**
 * Manifest-driven asset pipeline. `public/assets/assets-manifest.json` lists every character model; an entry
 * with a GLB is fetched (Draco or meshopt geometry, KTX2 textures) and its skin is remapped onto the engine's
 * rig by bone name. Entries without one, or whose GLB fails to load, fall back to the procedural sculpts, so
 * the game never blocks on art. Loaders are imported lazily, only when a GLB is actually listed.
 */

export interface ManifestEntry {
  glb: string | null;
  fallback: 'sdf' | 'procedural';
  sockets: string[];
  height?: number;
  variants?: string[];
}
export interface Manifest {
  version: number;
  models: Record<string, ManifestEntry>;
}
export interface LoadedModel {
  geometry: THREE.BufferGeometry;
  /** Texture map, when the GLB carries one. */
  map: THREE.Texture | null;
}

const loaded = new Map<string, LoadedModel>();
let manifest: Manifest | null = null;

export const getManifest = () => manifest;
export const loadedModel = (name: string) => loaded.get(name) ?? null;

const BONE_INDEX: Record<string, number> = BONE as unknown as Record<string, number>;

/** Re-index a GLB skin onto the engine rig by bone name; unknown bones collapse onto their nearest known parent. */
export function remapSkin(geo: THREE.BufferGeometry, bones: THREE.Bone[]): THREE.BufferGeometry {
  const map = bones.map((b) => {
    for (let o: THREE.Object3D | null = b; o; o = o.parent) if (o.name in BONE_INDEX) return BONE_INDEX[o.name];
    return BONE.body;
  });
  const si = geo.getAttribute('skinIndex') as THREE.BufferAttribute;
  const out = new Uint16Array(si.count * 4);
  for (let i = 0; i < si.count * 4; i++) out[i] = map[si.array[i]] ?? BONE.body;
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(out, 4));
  if (!geo.getAttribute('aMat')) geo.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 4), 4));
  return geo;
}

/** Fetch the manifest and any GLBs it names. Never throws: failures leave the procedural fallback in place. */
export async function preloadAssets(renderer?: WebGPURenderer): Promise<Manifest | null> {
  const base = import.meta.env.BASE_URL;
  try {
    const res = await fetch(`${base}assets/assets-manifest.json`);
    if (!res.ok) return null;
    manifest = (await res.json()) as Manifest;
  } catch {
    return null;
  }
  const wanted = Object.entries(manifest.models).filter(([, e]) => e.glb);
  if (!wanted.length) return manifest;
  const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
    import('three/addons/loaders/KTX2Loader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ]);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(new DRACOLoader().setDecoderPath(`${base}assets/decoders/draco/`));
  const ktx2 = new KTX2Loader().setTranscoderPath(`${base}assets/decoders/basis/`);
  if (renderer) ktx2.detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  await Promise.all(
    wanted.map(async ([name, e]) => {
      try {
        const gltf = await loader.loadAsync(`${base}assets/${e.glb}`);
        let found: THREE.SkinnedMesh | null = null;
        gltf.scene.traverse((o) => {
          if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
        });
        const sk = found as THREE.SkinnedMesh | null;
        if (!sk) throw new Error('no skinned mesh');
        const m = sk.material as THREE.MeshStandardMaterial;
        loaded.set(name, { geometry: remapSkin(sk.geometry, sk.skeleton.bones), map: m.map ?? null });
      } catch (err) {
        console.warn(`asset ${name}: using the procedural ${e.fallback} model`, err);
      }
    }),
  );
  return manifest;
}
