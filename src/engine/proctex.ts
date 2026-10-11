import * as THREE from 'three';
import { generateSurfaces, type SurfaceData } from './proctexGen';

/**
 * Procedural surface textures, generated on the CPU when a world is built and sampled by the world materials
 * (engine/surfaces). Every texture tiles seamlessly (all noise is periodic on the tile) and is regenerated in place
 * from the stratum's seed, so each region grows its own ground, stone and bark while every material keeps the
 * same texture objects. Fractal glyphs and the Buddhabrot nebula are baked offline (scripts/assets/bake-fractals)
 * and loaded once.
 *
 * Channels:
 *  - ground: R cracks, G pebbles, B fbm, A moss
 *  - stone:  R mortar joints, G block tone + chipping, B fissures, A lichen
 *  - bark:   R fibres, G plate furrows, B fbm, A moss
 *  - fractal (baked): R Mandelbrot boundary, G Julia set, B Sierpinski carpet, A Mandelbrot interior
 */

/** 0 = low (no bump, fewest samples), 1 = medium, 2 = high and up. Read when world materials are built. */
export let surfaceDetail = 2;
export function setSurfaceDetail(q: 'low' | 'medium' | 'high' | 'ultra') {
  surfaceDetail = q === 'low' ? 0 : q === 'medium' ? 1 : 2;
}

// ---------------------------------------------------------------------------------------------
// The shared textures
// ---------------------------------------------------------------------------------------------

/** Neutral texel each texture shows until its first generation lands (flat, uncracked, no moss). */
function makeTex(size: number, neutral: number[]) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set(neutral, i);
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const SIZE = 512;
export const surfaces = {
  ground: makeTex(SIZE, [0, 0, 128, 0]),
  stone: makeTex(SIZE, [0, 128, 0, 0]),
  bark: makeTex(SIZE, [128, 0, 128, 0]),
};
let wanted: number | null = null;
let worker: Worker | null = null;

function apply(d: SurfaceData) {
  for (const k of ['ground', 'stone', 'bark'] as const) {
    const t = surfaces[k];
    if (t.image.width !== d.size) {
      t.image = { data: d[k], width: d.size, height: d.size };
      t.dispose(); // reallocate at the new size
    } else (t.image.data as Uint8Array).set(d[k]);
    t.needsUpdate = true;
  }
}

/**
 * Regenerate the surface textures for a world seed: in a worker when the browser has one (a few hundred ms of
 * noise stays off the frame), else right here. No-op when already built or building for this seed.
 */
export function buildSurfaces(seed: number) {
  if (wanted === seed) return;
  wanted = seed;
  const size = surfaceDetail === 0 ? 256 : SIZE;
  if (typeof document === 'undefined') return; // headless world builds (tests, tools) never draw them
  if (typeof Worker !== 'undefined') {
    try {
      worker ??= new Worker(new URL('./proctex.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<SurfaceData & { seed: number }>) => {
        if (e.data.seed === wanted) apply(e.data);
      };
      worker.postMessage({ seed, size });
      return;
    } catch {
      worker = null;
    }
  }
  apply(generateSurfaces(seed, size));
}

const loader = new THREE.TextureLoader();
const baked = (file: string, srgb: boolean) => {
  // headless (tests, offline tools): an empty texture stands in, the materials still build
  const t = typeof document === 'undefined' ? new THREE.Texture() : loader.load(`${import.meta.env.BASE_URL}assets/textures/${file}`);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
};
let fractal: THREE.Texture | null = null;
let nebula: THREE.Texture | null = null;
/** Baked fractal glyph atlas (R Mandelbrot, G Julia, B Sierpinski carpet, A Mandelbrot interior). */
export const fractalTexture = () => {
  if (!fractal) {
    fractal = baked('fractal.png', false);
    fractal.wrapS = fractal.wrapT = THREE.RepeatWrapping;
  }
  return fractal;
};
/** Baked Buddhabrot nebula (nebulabrot: R long orbits, G medium, B short). */
export const nebulaTexture = () => (nebula ??= baked('buddhabrot.webp', true));

/** CPU sampling of a generated texture (tests and placement code). */
export function sampleSurface(tex: THREE.DataTexture, u: number, v: number, ch: number) {
  const S = tex.image.width;
  const wrap = (i: number) => ((i % S) + S) % S;
  const x = wrap(Math.floor(u * S)), y = wrap(Math.floor(v * S));
  return (tex.image.data as Uint8Array)[(y * S + x) * 4 + ch] / 255;
}
