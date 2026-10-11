// Offline bake of the fractal textures: node scripts/assets/bake-fractals.mjs
//
// public/assets/textures/buddhabrot.webp: a 1024² "nebulabrot", the inverted Mandelbrot. Instead of colouring the
//   points c that stay bounded, it plots the orbits of the points that escape: every z_n of every escaping orbit
//   lands a hit. Red, green and blue are the same plot with iteration limits of 5000, 500 and 50, so long orbits
//   glow red and short ones blue. The sky uses it as a nebula.
// public/assets/textures/fractal.png: 512² RGBA glyph atlas for inlays and ground rings:
//   R = Mandelbrot boundary (distance estimate, so the filaments stay crisp), G = Julia set c = -0.8 + 0.156i,
//   B = Sierpinski carpet (tiles seamlessly), A = Mandelbrot interior.
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const outDir = path.join(root, 'public/assets/textures');
fs.mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// deterministic xorshift so the bake is reproducible
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};

// ---------------------------------------------------------------- Buddhabrot (nebulabrot)
{
  const S = 1024;
  const LIM = [5000, 800, 100];
  const hist = [new Float32Array(S * S), new Float32Array(S * S), new Float32Array(S * S)];
  const orbit = new Float64Array(LIM[0] * 2);
  const SAMPLES = Number(process.env.BB_SAMPLES ?? 40_000_000);
  // image rows run along the real axis (the classic seated-Buddha pose), columns along the imaginary axis
  const re0 = -2.05, re1 = 0.95, im0 = -1.5, im1 = 1.5;
  const sx = S / (im1 - im0), sy = S / (re1 - re0);
  for (let s = 0; s < SAMPLES; s++) {
    const cr = rnd() * 4 - 2.2, ci = rnd() * 3.2 - 1.6;
    // skip the main cardioid and period-2 bulb: those orbits never escape
    const q = (cr - 0.25) ** 2 + ci * ci;
    if (q * (q + (cr - 0.25)) < 0.25 * ci * ci || (cr + 1) ** 2 + ci * ci < 0.0625) continue;
    let zr = 0, zi = 0, n = 0;
    for (; n < LIM[0]; n++) {
      const t = zr * zr - zi * zi + cr;
      zi = 2 * zr * zi + ci;
      zr = t;
      orbit[n * 2] = zr;
      orbit[n * 2 + 1] = zi;
      if (zr * zr + zi * zi > 4) break;
    }
    if (n >= LIM[0]) continue;
    for (let ch = 0; ch < 3; ch++) {
      if (n >= LIM[ch]) continue;
      const h = hist[ch];
      for (let k = 0; k < n; k++) {
        const x = Math.floor((orbit[k * 2 + 1] - im0) * sx), y = Math.floor((orbit[k * 2] - re0) * sy);
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        h[y * S + x]++;
        h[y * S + (S - 1 - x)]++; // the set is symmetric about the real axis
      }
    }
    if (s % 10_000_000 === 0 && s) log('buddhabrot', s / 1e6, 'M samples');
  }
  // tone map each channel between a black point (the even haze of short orbits) and its 99.8th percentile
  const img = Buffer.alloc(S * S * 3);
  hist.forEach((h, ch) => {
    const sorted = Float32Array.from(h).sort();
    const lo = sorted[Math.floor(sorted.length * (ch === 2 ? 0.8 : 0.6))];
    const hi = sorted[Math.floor(sorted.length * 0.998)] || 1;
    for (let i = 0; i < S * S; i++) img[i * 3 + ch] = Math.round(255 * Math.min(1, Math.pow(Math.max(0, h[i] - lo) / (hi - lo), 0.8)));
  });
  await sharp(img, { raw: { width: S, height: S, channels: 3 } }).webp({ quality: 88 }).toFile(path.join(outDir, 'buddhabrot.webp'));
  log('wrote buddhabrot.webp');
}

// ---------------------------------------------------------------- glyph atlas
{
  const S = 512;
  const img = Buffer.alloc(S * S * 4);
  /** Julia set z² + c by distance estimate: boundary glow 0..1 (1 inside). */
  const julia = (zr, zi, cr, ci, maxN, px) => {
    let dr = 1, di = 0;
    for (let n = 0; n < maxN; n++) {
      const ndr = 2 * (zr * dr - zi * di), ndi = 2 * (zr * di + zi * dr);
      dr = ndr;
      di = ndi;
      const t = zr * zr - zi * zi + cr;
      zi = 2 * zr * zi + ci;
      zr = t;
      if (zr * zr + zi * zi > 1e6) {
        const m = Math.sqrt(zr * zr + zi * zi);
        const d = (0.5 * m * Math.log(m)) / Math.hypot(dr, di);
        return Math.max(0, 1 - d / (px * 6)) ** 1.5;
      }
    }
    return 0.3; // inside: a faint fill under the bright boundary
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // Mandelbrot: z0 = 0, c = pixel; the derivative of z w.r.t. c gains +1 each step
      {
        const cr = -0.75 + ((x + 0.5) / S - 0.5) * 2.9, ci = ((y + 0.5) / S - 0.5) * 2.9;
        let zr = 0, zi = 0, dr = 0, di = 0, inside = 1, glow = 0.25;
        for (let n = 0; n < 400; n++) {
          const ndr = 2 * (zr * dr - zi * di) + 1, ndi = 2 * (zr * di + zi * dr);
          dr = ndr;
          di = ndi;
          const t = zr * zr - zi * zi + cr;
          zi = 2 * zr * zi + ci;
          zr = t;
          if (zr * zr + zi * zi > 1e6) {
            const m = Math.sqrt(zr * zr + zi * zi);
            const d = (0.5 * m * Math.log(m)) / Math.hypot(dr, di);
            glow = Math.max(0, 1 - d / ((2.9 / S) * 5)) ** 1.5;
            inside = 0;
            break;
          }
        }
        img[i] = Math.round(255 * glow);
        img[i + 3] = inside * 255;
      }
      // Julia c = -0.8 + 0.156i
      {
        const zr = ((x + 0.5) / S - 0.5) * 3.2, zi = ((y + 0.5) / S - 0.5) * 3.2;
        img[i + 1] = Math.round(255 * julia(zr, zi, -0.8, 0.156, 300, 3.2 / S));
      }
      // Sierpinski carpet, five levels
      {
        let a = x, b = y, hole = 0;
        const k = S / 243;
        a = Math.floor(a / k);
        b = Math.floor(b / k);
        for (let l = 0; l < 5; l++) {
          if (a % 3 === 1 && b % 3 === 1) hole = 1;
          a = Math.floor(a / 3);
          b = Math.floor(b / 3);
        }
        img[i + 2] = hole ? 0 : 255;
      }
    }
  }
  await sharp(img, { raw: { width: S, height: S, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(outDir, 'fractal.png'));
  log('wrote fractal.png');
}
