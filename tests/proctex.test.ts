import { describe, expect, it } from 'vitest';
import { generateSurfaces } from '../src/engine/proctexGen';

describe('procedural surface textures', () => {
  it('generate quickly, vary by seed and tile seamlessly', () => {
    const t0 = performance.now();
    const a = generateSurfaces(1234, 256);
    expect(performance.now() - t0).toBeLessThan(3000);
    const S = a.size;
    const at = (d: Uint8Array, x: number, y: number, c: number) => d[(((y + S) % S) * S + ((x + S) % S)) * 4 + c] / 255;
    // periodic noise: the step across the wrap seam is no bigger than a step inside the tile
    for (const d of [a.ground, a.stone, a.bark]) {
      let seam = 0, inner = 0;
      for (let y = 0; y < S; y += 3) {
        seam += Math.abs(at(d, S - 1, y, 2) - at(d, 0, y, 2));
        inner += Math.abs(at(d, S / 2 - 1, y, 2) - at(d, S / 2, y, 2));
      }
      expect(seam).toBeLessThan(inner * 2.5 + 2);
    }
    const b = generateSurfaces(99, 256);
    let diff = 0;
    for (let i = 0; i < a.ground.length; i += 97) diff += Math.abs(a.ground[i] - b.ground[i]);
    expect(diff).toBeGreaterThan(0);
  });
});
