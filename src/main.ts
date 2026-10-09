import './style.css';
import { Game } from './game';
import { initPhysics } from './physics/physics';

declare global {
  interface Window {
    __wk?: Game;
  }
}

async function boot() {
  const root = document.getElementById('game-root')!;
  try {
    // Rapier's WASM is inlined in the bundle; compiling it takes a moment while the title fades in.
    await initPhysics();
    const game = new Game(root);
    game.start();
    if (/[?#&]debug/.test(location.search + location.hash)) window.__wk = game;
  } catch (err) {
    console.error('Wisdomkeeper failed to start', err);
    document.getElementById('nogl')?.classList.remove('hidden');
    document.getElementById('title')?.classList.add('hidden');
  }
}

void boot();
