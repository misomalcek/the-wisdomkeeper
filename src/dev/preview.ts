// Dev-only: hero pose gallery (served by `vite`, not part of the production build).
import * as THREE from 'three';
import { Hero, idlePose, type HeroPose } from '../entities/hero';
import type { Skin } from '../types';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1a20);
scene.fog = new THREE.FogExp2(0x0a1a20, 0.02);
scene.add(new THREE.HemisphereLight(0x99ccff, 0x223322, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(3, 6, 4);
scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 10).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0c2a28 }));
scene.add(floor);

const poses: { name: string; skin: Skin; f: (p: HeroPose) => void }[] = [
  { name: 'idle', skin: 'resonant', f: () => {} },
  { name: 'run', skin: 'resonant', f: (p) => { p.speed = 8.5; } },
  { name: 'jump', skin: 'verdant', f: (p) => { p.grounded = false; p.vy = 4; } },
  { name: 'swing0', skin: 'resonant', f: (p) => { p.attack = { active: true, idx: 0, t: 0.55 }; } },
  { name: 'swing2', skin: 'void', f: (p) => { p.attack = { active: true, idx: 2, t: 0.6 }; } },
  { name: 'aim', skin: 'resonant', f: (p) => { p.aiming = true; } },
  { name: 'flight', skin: 'verdant', f: (p) => { p.mode = 'flight'; p.speed = 20; } },
  { name: 'levitate', skin: 'void', f: (p) => { p.mode = 'levitate'; p.speed = 5; } },
];
const heroes = poses.map((o, i) => {
  const h = new Hero(o.skin);
  h.root.position.set((i - (poses.length - 1) / 2) * 2.2, o.name === 'flight' ? 1.2 : o.name === 'levitate' ? 1.0 : 0, 0);
  h.root.rotation.y = 0.5;
  scene.add(h.root);
  const p = idlePose();
  o.f(p);
  return { h, p };
});
const cam = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
const grp = Number(new URLSearchParams(location.search).get('g') ?? -1);
if (grp >= 0) {
  const cx = (grp * 4 + 1.5 - (poses.length - 1) / 2) * 2.2;
  cam.position.set(cx, 1.5, 5.2);
  cam.lookAt(cx, 1.1, 0);
} else {
  cam.position.set(0, 1.6, 10.5);
  cam.lookAt(0, 1.0, 0);
}
let t = 0;
function loop() {
  requestAnimationFrame(loop);
  t += 0.016;
  heroes.forEach(({ h, p }) => h.update(0.05, p));
  renderer.render(scene, cam);
  (window as unknown as { ready: number }).ready = t;
}
loop();
