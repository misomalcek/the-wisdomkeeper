import { generateSurfaces, juliaGlyph } from './proctexGen';

/** Texture worker: builds the procedural surfaces (and the region's Julia glyph) and hands the buffers back without copying. */
self.onmessage = (e: MessageEvent<{ key: string; seed: number; size: number; julia: [number, number] | null }>) => {
  const d = generateSurfaces(e.data.seed, e.data.size);
  const j = e.data.julia;
  const glyph = j ? juliaGlyph(j[0], j[1], GLYPH) : null;
  const bufs = [d.ground.buffer, d.stone.buffer, d.bark.buffer];
  if (glyph) bufs.push(glyph.buffer);
  (self as unknown as Worker).postMessage({ key: e.data.key, ...d, glyph }, bufs);
};
const GLYPH = 256;
