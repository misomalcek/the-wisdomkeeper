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
  /** Packed occlusion/roughness/metalness (glTF ORM) and tangent-space normal maps, when present. */
  orm?: THREE.Texture | null;
  normal?: THREE.Texture | null;
  /** Bind-pose bone offsets (parent-relative) by engine bone name, so the rig matches the sculptor's skeleton. */
  layout?: Record<string, [number, number, number]>;
  /** Unskinned companion meshes in model space (e.g. the hero's `rootBlade`), keyed by node name. */
  extras?: Record<string, THREE.BufferGeometry>;
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

/** Clone a geometry with float position/normal attributes (quantized ones clamp to [-1, 1] when transformed). */
function floatClone(src: THREE.BufferGeometry, m: THREE.Matrix4) {
  const g = src.clone();
  for (const k of ['position', 'normal'] as const) {
    const a = g.getAttribute(k) as THREE.BufferAttribute | undefined;
    if (!a || a.array instanceof Float32Array) continue;
    const f = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) f.set([a.getX(i), a.getY(i), a.getZ(i)], i * 3);
    g.setAttribute(k, new THREE.BufferAttribute(f, 3));
  }
  return g.applyMatrix4(m);
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
        gltf.scene.updateMatrixWorld(true);
        let found: THREE.Mesh | null = null;
        gltf.scene.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh && !(found as THREE.SkinnedMesh | null)?.isSkinnedMesh) found = o as THREE.Mesh;
          else if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
        });
        const mesh = found as THREE.Mesh | null;
        if (!mesh) throw new Error('no mesh');
        const sk = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
        const m = mesh.material as THREE.MeshStandardMaterial;
        // quantized GLBs fold the dequantisation into the inverse binds (skinned) or the node transform; bake it
        // into the vertices so the engine can bind its own skeleton against plain model-space geometry
        const D = sk
          ? new THREE.Matrix4().multiplyMatrices(sk.skeleton.bones[0].matrixWorld, sk.skeleton.boneInverses[0]).multiply(sk.bindMatrix)
          : mesh.matrixWorld;
        const geometry = floatClone(mesh.geometry, D);
        // custom sculpt attributes arrive lower-cased (_AMAT → _amat)
        for (const [from, to] of [['_amat', 'aMat'], ['_ao', 'aAO']]) {
          const a = geometry.getAttribute(from);
          if (a) {
            geometry.setAttribute(to, a);
            geometry.deleteAttribute(from);
          }
        }
        const layout: Record<string, [number, number, number]> = {};
        const extras: Record<string, THREE.BufferGeometry> = {};
        if (sk) for (const b of sk.skeleton.bones) if (b.name in BONE_INDEX) layout[b.name] = [b.position.x, b.position.y, b.position.z];
        gltf.scene.traverse((o) => {
          const x = o as THREE.Mesh;
          if (x.isMesh && x !== mesh && o.name) extras[o.name] = floatClone(x.geometry, o.matrixWorld);
        });
        loaded.set(name, {
          // the hero's skin is re-indexed onto the engine rig by bone name; creatures ship joints in rig order
          geometry: name === 'hero' && sk ? remapSkin(geometry, sk.skeleton.bones) : geometry,
          map: m.map ?? null,
          orm: m.roughnessMap ?? m.metalnessMap ?? null,
          normal: m.normalMap ?? null,
          layout,
          extras,
        });
      } catch (err) {
        console.warn(`asset ${name}: using the procedural ${e.fallback} model`, err);
      }
    }),
  );
  return manifest;
}
