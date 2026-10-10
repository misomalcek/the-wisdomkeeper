// Dev-only: hero pose gallery (served by `vite`, not part of the production build).
import * as THREE from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { Hero, idlePose, type HeroPose } from '../entities/hero';
import type { Skin } from '../types';
import { preloadAssets } from '../assets/pipeline';

const renderer = new WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).has('webgl') });
await renderer.init();
if (!new URLSearchParams(location.search).has('sdf')) await preloadAssets(renderer);
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
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 10).rotateX(-Math.PI / 2), new MeshStandardNodeMaterial({ color: 0x0c2a28 }));
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
const qs = new URLSearchParams(location.search);
const grp = Number(qs.get('g') ?? -1);
const solo = qs.get('solo');
if (solo !== null) {
  // turntable close-up of one pose: ?solo=<pose index>&yaw=<radians>
  heroes.forEach(({ h }, i) => {
    h.root.visible = i === Number(solo);
    h.root.position.x = 0;
    h.root.rotation.y = Number(qs.get('yaw') ?? 0);
  });
  cam.position.set(0, 1.25, 3.6);
  cam.lookAt(0, 1.05, 0);
} else if (grp >= 0) {
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

// ?fiend: a Void-Root Fiend beside the hero for scale and material checks
if (qs.has('fiend')) {
  const { Enemy } = await import('../entities/enemies');
  const e = new Enemy('brute', 0, 0, 1, 0);
  e.group.scale.setScalar(1);
  e.group.position.set(1.6, 0, -1.5);
  e.group.rotation.y = -0.5;
  scene.add(e.group);
  heroes.forEach(({ h }, i) => (h.root.visible = i === 0));
  heroes[0].h.root.position.set(-1.2, 0, 0);
  cam.position.set(0, 2.2, 7.5);
  cam.lookAt(0, 1.6, 0);
}

// ?null: the Null's machines lined up with the hero for scale — drone, data-river pylon, Void-Infused Construct
if (qs.has('null')) {
  const { Enemy } = await import('../entities/enemies');
  heroes.forEach(({ h }, i) => (h.root.visible = i === 0));
  heroes[0].h.root.position.set(-2.4, 0, 1.5);
  const mk = (kind: 'drone' | 'pylon' | 'boss', x: number, z: number, y: number, yaw: number) => {
    const e = new Enemy(kind, x, z, 1, 0, 'construct');
    e.group.scale.setScalar(1);
    e.group.position.set(x, y, z);
    e.group.rotation.y = yaw;
    scene.add(e.group);
    return e;
  };
  mk('drone', -4.2, 1, 2.6, 0.5);
  mk('pylon', 5.5, -1, 0, 0);
  mk('boss', 0.6, -3, 0, 0.25);
  floor.scale.set(1.5, 1, 3);
  cam.position.set(0, 4.2, 15.5);
  cam.lookAt(0, 3.2, 0);
}
(window as unknown as { __heroes: unknown }).__heroes = heroes;

// ?enemy=<kind>&yaw=<rad>&d=<dist>&y=<look height>: one enemy alone, turntable close-up
if (qs.has('enemy')) {
  const { Enemy } = await import('../entities/enemies');
  heroes.forEach(({ h }) => (h.root.visible = false));
  const kind = qs.get('enemy') as 'brute' | 'drone' | 'pylon' | 'boss' | 'mite' | 'spitter';
  const e = new Enemy(kind, 0, 0, 1, 0, 'construct');
  e.group.scale.setScalar(1);
  e.group.position.set(0, kind === 'brute' ? 1.9 : kind === 'drone' || kind === 'mite' ? 1.6 : kind === 'spitter' ? 2.2 : kind === 'boss' ? 4.8 : 0, 0);
  e.group.rotation.y = Number(qs.get('yaw') ?? 0);
  scene.add(e.group);
  const d = Number(qs.get('d') ?? 6), y = Number(qs.get('y') ?? 1.8);
  cam.position.set(0, y + d * 0.12, d);
  cam.lookAt(0, y, 0);
}

// ?prop=contact&level=<0..1>&yaw&d&y: the Act IV Resonance Contact alone
if (qs.has('prop')) {
  const { ContactPad } = await import('../world/contact');
  heroes.forEach(({ h }) => (h.root.visible = false));
  const pad = new ContactPad(1);
  const level = Number(qs.get('level') ?? 1);
  pad.setArcTarget(new THREE.Vector3(-8, 14, -12), new THREE.Vector3());
  pad.group.rotation.y = Number(qs.get('yaw') ?? 0);
  scene.add(pad.group);
  const c = new THREE.Color(0x40ffe0).multiplyScalar(level > 0.5 ? 2.2 : 0.6);
  const d = Number(qs.get('d') ?? 11), y = Number(qs.get('y') ?? 2);
  cam.position.set(0, y + d * 0.3, d);
  cam.lookAt(0, y, 0);
  let t = 0;
  const tick = () => {
    t += 1 / 60;
    pad.update(1 / 60, t, c, level, cam.position);
    requestAnimationFrame(tick);
  };
  tick();
}
