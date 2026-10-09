import * as THREE from 'three';
import { Hero, idlePose } from '../entities/hero';
import type { Skin } from '../types';

const cache = new Map<string, string>();

/** Renders the hero once into a data-URL (separate throw-away WebGL context) for the inventory paper doll. */
export function renderPortrait(skin: Skin, w = 360, h = 520): string {
  const key = `${skin}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let url = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xaee6ff, 0x24304a, 1.6));
    const key1 = new THREE.DirectionalLight(0xffffff, 2.6);
    key1.position.set(2.5, 3.5, 3.5);
    const rim = new THREE.DirectionalLight(0x5cffc1, 2.2);
    rim.position.set(-3, 2, -3);
    scene.add(key1, rim);
    const hero = new Hero(skin);
    hero.forceBlade(true);
    hero.root.rotation.y = 0.55;
    scene.add(hero.root);
    const pose = idlePose();
    pose.aiming = false;
    for (let i = 0; i < 30; i++) hero.update(0.05, pose);
    const cam = new THREE.PerspectiveCamera(26, w / h, 0.1, 50);
    cam.position.set(0, 1.15, 6.4);
    cam.lookAt(0, 1.0, 0);
    r.render(scene, cam);
    url = canvas.toDataURL('image/png');
    hero.dispose();
    r.dispose();
    r.forceContextLoss();
  } catch {
    url = '';
  }
  cache.set(key, url);
  return url;
}
