import { generateSurfaces } from './proctexGen';

/** Texture worker: builds the procedural surfaces for a seed and hands the buffers back without copying. */
self.onmessage = (e: MessageEvent<{ seed: number; size: number }>) => {
  const d = generateSurfaces(e.data.seed, e.data.size);
  (self as unknown as Worker).postMessage({ seed: e.data.seed, ...d }, [d.ground.buffer, d.stone.buffer, d.bark.buffer]);
};
