/// <reference lib="webworker" />
// Terrain chunk builder (P1-E): rebuilds the region's ground shape from plain options and posts geometry back as
// transferable typed arrays, so the main thread only uploads.
import { GroundShape, type ShapeOpts } from './gen/shape';
import { buildChunkArrays, chunkTransfer, type ChunkStyle } from './gen/chunkMesh';

let current: { id: number; shape: GroundShape; style: ChunkStyle } | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    current = { id: m.id, shape: new GroundShape(m.opts as ShapeOpts), style: m.style };
    return;
  }
  if (m.type === 'build') {
    if (!current || current.id !== m.id) return;
    const a = buildChunkArrays(current.shape, m.cx, m.cz, m.n, current.style);
    (self as unknown as Worker).postMessage({ type: 'chunk', id: m.id, ticket: m.ticket, cx: m.cx, cz: m.cz, lod: m.lod, a }, chunkTransfer(a));
  }
};
