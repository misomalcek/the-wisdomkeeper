import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { Hero, idlePose } from '../entities/hero';
import type { Skin } from '../types';

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
let renderer: WebGPURenderer | null = null;

/** The game's renderer is reused for portraits (no second GPU context). */
export function setPortraitRenderer(r: WebGPURenderer) {
  renderer = r;
}

/** Synchronous cache lookup; '' until `renderPortrait` has resolved once for this skin/size. */
export function cachedPortrait(skin: Skin, w = 360, h = 520) {
  return cache.get(`${skin}:${w}x${h}`) ?? '';
}

/** Fill every `<img data-portrait="skin">` under `root` once its render is ready. */
export function fillPortraits(root: ParentNode) {
  root.querySelectorAll<HTMLImageElement>('img[data-portrait]').forEach((img) => {
    const skin = img.dataset.portrait as Skin;
    if (img.src) return;
    void renderPortrait(skin, Number(img.dataset.w) || 360, Number(img.dataset.h) || 520).then((url) => {
      if (url) img.src = url;
    });
  });
}

// three.js ACES filmic fit (RRT+ODT), applied on the CPU because render targets hold linear HDR.
function aces(r: number, g: number, b: number, exposure: number, out: number[]) {
  r *= exposure / 0.6;
  g *= exposure / 0.6;
  b *= exposure / 0.6;
  const x = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const y = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const z = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const fx = fit(x), fy = fit(y), fz = fit(z);
  out[0] = 1.60475 * fx - 0.53108 * fy - 0.07367 * fz;
  out[1] = -0.10208 * fx + 1.10813 * fy - 0.00605 * fz;
  out[2] = -0.00327 * fx - 0.07276 * fy + 1.07602 * fz;
}
const srgb = (v: number) => {
  v = Math.min(1, Math.max(0, v));
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
};

/** Renders the hero once into a data-URL for the inventory paper doll. */
export function renderPortrait(skin: Skin, w = 360, h = 520): Promise<string> {
  const key = `${skin}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const job = (async () => {
    if (!renderer) return '';
    const r = renderer;
    const rt = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    // glowing materials write named MRT outputs; 'output' is the colour attachment
    rt.texture.name = 'output';
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xaee6ff, 0x24304a, 1.6));
    const key1 = new THREE.DirectionalLight(0xffffff, 2.6);
    key1.position.set(2.5, 3.5, 3.5);
    const rim = new THREE.DirectionalLight(0x5cffc1, 2.2);
    rim.position.set(-3, 2, -3);
    scene.add(key1, rim);
    const hero = new Hero(skin);
    hero.forceBlade(true);
    hero.root.rotation.y = 0.55;
    scene.add(hero.root);
    const pose = idlePose();
    pose.aiming = false;
    for (let i = 0; i < 30; i++) hero.update(0.05, pose);
    const cam = new THREE.PerspectiveCamera(26, w / h, 0.1, 50);
    cam.position.set(0, 1.15, 6.4);
    cam.lookAt(0, 1.0, 0);
    const prevRT = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    try {
      r.setRenderTarget(rt);
      r.setClearAlpha(0);
      r.clear();
      r.render(scene, cam);
      r.setRenderTarget(prevRT);
      r.setClearAlpha(prevAlpha);
      const raw = (await r.readRenderTargetPixelsAsync(rt, 0, 0, w, h)) as Uint16Array | Float32Array;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flip = !(r.backend as any).isWebGPUBackend;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(w, h);
      const half = raw instanceof Uint16Array;
      const f = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(raw[i]) : raw[i]);
      const c = [0, 0, 0];
      for (let y = 0; y < h; y++) {
        const sy = flip ? h - 1 - y : y;
        for (let x = 0; x < w; x++) {
          const si = (sy * w + x) * 4;
          const di = (y * w + x) * 4;
          const a = Math.min(1, Math.max(0, f(si + 3)));
          if (a <= 0.001) continue;
          // un-premultiply the HDR colour before tone mapping
          aces(f(si) / a, f(si + 1) / a, f(si + 2) / a, 1.15, c);
          img.data[di] = srgb(c[0]);
          img.data[di + 1] = srgb(c[1]);
          img.data[di + 2] = srgb(c[2]);
          img.data[di + 3] = Math.round(a * 255);
        }
      }
      ctx.putImageData(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (err) {
      console.warn('portrait render failed', err);
      return '';
    } finally {
      r.setRenderTarget(prevRT);
      r.setClearAlpha(prevAlpha);
      hero.dispose();
      rt.dispose();
    }
  })();
  pending.set(key, job);
  void job.then((url) => {
    cache.set(key, url);
    pending.delete(key);
  });
  return job;
}
