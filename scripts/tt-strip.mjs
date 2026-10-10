// Turntable strip of one preview pose: node scripts/tt-strip.mjs [pose] [out.png]
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
const pose = process.argv[2] ?? '0';
const out = process.argv[3] ?? 'shots/tt-all.png';
execFileSync('node', ['scripts/shot-turntable.mjs', pose, 'tt'], { stdio: 'inherit' });
const tiles = [0, 1, 2, 3].map((i) => ({ input: `shots/tt-${i}.png`, left: i * 520, top: 0 }));
await sharp({ create: { width: 2080, height: 700, channels: 3, background: '#000' } }).composite(tiles).png().toFile(out);
