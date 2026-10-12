import * as THREE from 'three';
import type { World } from './world';
import { Biome } from './gen/field';
import type { GroundSample } from './gen/shape';
import { SITE_CELL, latticeSite } from './gen/sites';
import { FORMATIONS } from './gen/meshgen/fractals';
import { title } from './gen/names';

export interface AtlasLabel {
  x: number;
  z: number;
  name: string;
  kind: 'province' | 'formation' | 'station';
}

export interface AtlasData {
  raster: HTMLCanvasElement;
  /** Half-width of the raster (m) and its centre. */
  extent: number;
  cx: number;
  cz: number;
  labels: AtlasLabel[];
}

const N = 176;
const HALF = 2100;
const _gs: GroundSample = { h: 0, river: 0, blight: 0, biome: Biome.Meadow, core: 0, wild: 0, isleSd: 1e4, rock: 0, strata: 0, sand: 0, ero: 0 };

/**
 * The Atlas: a 4.2 km chart of the Wilds around (cx, cz), drawn from the ground field itself. Each landform keeps its
 * colour (bare rock, banded sediment, sand, rolling basin), the relief is hill-shaded, lakes and rivers of light are
 * inked in, the Physarum veins are traced over it, and every province, formation and station carries its name.
 */
export function buildAtlas(world: World, cx: number, cz: number): AtlasData {
  const t = world.terrain;
  const sh = t.shape;
  const pal = world.palette;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  const px = (2 * HALF) / N;
  const H = new Float32Array(N * N);
  const cols = new Float32Array(N * N * 3);
  const lo = new THREE.Color(pal.groundBase).multiplyScalar(4);
  const hi = new THREE.Color(pal.groundHigh).multiplyScalar(2.6);
  const rock = new THREE.Color(0.42, 0.4, 0.46);
  const sed = [new THREE.Color(0.62, 0.42, 0.3), new THREE.Color(0.74, 0.58, 0.42), new THREE.Color(0.5, 0.34, 0.28)];
  const sand = new THREE.Color(0.86, 0.72, 0.5);
  const water = new THREE.Color(pal.river);
  const blight = new THREE.Color(0.32, 0.04, 0.16);
  const c = new THREE.Color();
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = cx + ((i + 0.5) / N - 0.5) * 2 * HALF;
      const z = cz + ((j + 0.5) / N - 0.5) * 2 * HALF;
      const s = sh.sample(x, z, _gs);
      const k = j * N + i;
      H[k] = s.h;
      c.copy(lo).lerp(hi, THREE.MathUtils.clamp((s.h + 5) / 60, 0, 1));
      if (s.rock > 0.02) c.lerp(rock, Math.min(1, s.rock * 1.2));
      if (s.strata > 0.02) c.lerp(sed[Math.abs(Math.floor(s.h / 9)) % 3], Math.min(1, s.strata * 1.2));
      if (s.sand > 0.02) c.lerp(sand, Math.min(1, s.sand * 1.1));
      if (s.blight > 0.2) c.lerp(blight, Math.min(0.8, s.blight));
      const wet = Math.max(s.river, s.isleSd < -4 ? 1 : 0);
      if (wet > 0.05) c.lerp(water, Math.min(1, wet * 1.3));
      cols[k * 3] = c.r;
      cols[k * 3 + 1] = c.g;
      cols[k * 3 + 2] = c.b;
    }
  }
  // hill shade from the north-west, plus the veins of the network
  const vein = { x: 0, y: 0 };
  const acc = new THREE.Color(pal.accent);
  let lum = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const dx = H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)];
      const dz = H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i];
      const shade = THREE.MathUtils.clamp(0.85 - (dx + dz) / (px * 2) * 0.9, 0.35, 1.45);
      let r = cols[k * 3] * shade;
      let g = cols[k * 3 + 1] * shade;
      let b = cols[k * 3 + 2] * shade;
      const x = cx + ((i + 0.5) / N - 0.5) * 2 * HALF;
      const z = cz + ((j + 0.5) / N - 0.5) * 2 * HALF;
      const v = world.network ? world.network.at(x, z, vein) : 0;
      if (v > 0.3) {
        const a = Math.min(1, (v - 0.3) * 1.6) * 0.8;
        r += (acc.r * 1.6 - r) * a;
        g += (acc.g * 1.6 - g) * a;
        b += (acc.b * 1.6 - b) * a;
      }
      img.data[k * 4] = Math.min(255, r * 255);
      img.data[k * 4 + 1] = Math.min(255, g * 255);
      img.data[k * 4 + 2] = Math.min(255, b * 255);
      img.data[k * 4 + 3] = 255;
      lum += (r + g + b) / 3;
    }
  }
  // auto-exposure, as the region map does, so dark worlds still read
  const gain = THREE.MathUtils.clamp(0.36 / Math.max(lum / (N * N), 0.02), 0.8, 3);
  for (let k = 0; k < img.data.length; k += 4) for (let q = 0; q < 3; q++) img.data[k + q] = Math.min(255, img.data[k + q] * gain);
  ctx.putImageData(img, 0, 0);

  const labels: AtlasLabel[] = [];
  const forms = t.wild?.forms;
  if (forms) {
    const seen = new Set<string>();
    for (let z = cz - HALF; z <= cz + HALF; z += 260) {
      for (let x = cx - HALF; x <= cx + HALF; x += 260) {
        if (t.wildness(x, z) < 0.6) continue;
        const p = forms.province(x, z);
        const k = `${p.i},${p.j}`;
        if (seen.has(k) || Math.abs(p.x - cx) > HALF * 0.92 || Math.abs(p.z - cz) > HALF * 0.92) continue;
        seen.add(k);
        labels.push({ x: p.x, z: p.z, name: title(world.names.province(p.i, p.j, p.form).name), kind: 'province' });
      }
    }
    const i0 = Math.floor((cx - HALF) / SITE_CELL);
    const j0 = Math.floor((cz - HALF) / SITE_CELL);
    for (let j = j0; j <= j0 + Math.ceil((2 * HALF) / SITE_CELL); j++) {
      for (let i = i0; i <= i0 + Math.ceil((2 * HALF) / SITE_CELL); i++) {
        const s = latticeSite(sh, world.siteSeed, i, j, !!world.landmarks?.stations);
        if (!s || Math.abs(s.x - cx) > HALF || Math.abs(s.z - cz) > HALF) continue;
        const name = s.kind === 'formation' ? world.names.formation(i, j, FORMATIONS[s.form].kind) : world.names.station(i, j);
        labels.push({ x: s.x, z: s.z, name: title(name), kind: s.kind });
      }
    }
  }
  return { raster: cv, extent: HALF, cx, cz, labels };
}
