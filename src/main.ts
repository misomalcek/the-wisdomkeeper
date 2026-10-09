import './style.css';
import { Game } from './game';

declare global {
  interface Window {
    __wk?: Game;
  }
}

function boot() {
  const root = document.getElementById('game-root')!;
  try {
    const game = new Game(root);
    game.start();
    if (/[?#&]debug/.test(location.search + location.hash)) window.__wk = game;
  } catch (err) {
    console.error('Wisdomkeeper failed to start', err);
    document.getElementById('nogl')?.classList.remove('hidden');
    document.getElementById('title')?.classList.add('hidden');
  }
}

boot();
