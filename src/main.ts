import './style.css';
import { Game } from './game';
import { initPhysics } from './physics/physics';
import { Gfx } from './engine/gfx';
import { preloadAssets } from './assets/pipeline';
import { setFlagTier, flagState } from './engine/flags';
import { mountPerfOverlay } from './engine/perf';

/**
 * Editions: a fork (the desktop edition, Infinite Evolutions) adds `src/evo/install.ts` and builds with
 * `VITE_EDITION=evolutions`. Here the glob is empty, so the web build carries nothing of it.
 */
const editions = import.meta.glob<{ installEvolutions(game: Game): unknown }>('./evo/install.ts');

declare global {
  interface Window {
    __wk?: Game;
  }
}

async function boot() {
  const root = document.getElementById('game-root')!;
  try {
    // Rapier's WASM is inlined in the bundle; compiling it takes a moment while the title fades in.
    const [gfx] = await Promise.all([Gfx.create(root), initPhysics()]);
    await preloadAssets(gfx.renderer);
    setFlagTier(gfx.quality);
    const game = new Game(gfx);
    game.start();
    if (import.meta.env.VITE_EDITION === 'evolutions') for (const load of Object.values(editions)) await (await load()).installEvolutions(game);
    mountPerfOverlay(() => ({ tier: gfx.quality, backend: gfx.backend, chunks: game.world?.ground.count ?? 0, flags: Object.entries(flagState()).filter(([, v]) => !v).map(([k]) => '-' + k).join(',') || 'all' }));
    if (/[?#&]debug/.test(location.search + location.hash)) window.__wk = game;
  } catch (err) {
    console.error('Wisdomkeeper failed to start', err);
    document.getElementById('nogl')?.classList.remove('hidden');
    document.getElementById('title')?.classList.add('hidden');
  }
}

void boot();
