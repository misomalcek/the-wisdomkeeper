import * as THREE from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';
import { instancedBufferAttribute, smoothstep, uv } from 'three/tsl';
import { glow, type N } from './materials';

const MAX = 5000;

/** One instanced additive billboard batch holds every spark, spore and shockwave mote in the game. */
export class Particles {
  readonly sprite: THREE.Sprite;
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private size = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  private grav = new Float32Array(MAX);
  private baseSize = new Float32Array(MAX);
  private head = 0;
  private attrs: THREE.InstancedBufferAttribute[];

  constructor() {
    const aPos = new THREE.InstancedBufferAttribute(this.pos, 3);
    const aCol = new THREE.InstancedBufferAttribute(this.col, 3);
    const aSize = new THREE.InstancedBufferAttribute(this.size, 1);
    const aAlpha = new THREE.InstancedBufferAttribute(this.alpha, 1);
    this.attrs = [aPos, aCol, aSize, aAlpha];
    for (const at of this.attrs) at.setUsage(THREE.DynamicDrawUsage);
    const alpha: N = instancedBufferAttribute(aAlpha);
    const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.positionNode = instancedBufferAttribute(aPos);
    m.scaleNode = instancedBufferAttribute(aSize);
    const disc = smoothstep(0.5, 0.05, uv().sub(0.5).length());
    m.colorNode = (instancedBufferAttribute(aCol) as N).mul(alpha);
    m.opacityNode = disc.mul(alpha);
    glow(m);
    this.sprite = new THREE.Sprite(m);
    this.sprite.count = MAX;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 10;
  }

  /** Kept for API compatibility: billboards are world-sized, so no pixel scale is needed. */
  setScale(_s: number) {}

  emit(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    c: THREE.Color, size: number, life: number, drag = 1.5, grav = 0,
  ) {
    const i = this.head;
    this.head = (this.head + 1) % MAX;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = c.r; this.col[i3 + 1] = c.g; this.col[i3 + 2] = c.b;
    this.baseSize[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  burst(p: THREE.Vector3, c: THREE.Color, n: number, speed: number, size = 0.35, life = 0.7, up = 0.3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.3) * 1.2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.emit(p.x, p.y, p.z, Math.cos(a) * s, e * s * 0.6 + up * speed, Math.sin(a) * s, c, size * (0.6 + Math.random() * 0.8), life * (0.5 + Math.random() * 0.7), 2.2, 4);
    }
  }

  ring(p: THREE.Vector3, c: THREE.Color, n: number, speed: number, size = 0.4, life = 0.8) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.emit(p.x, p.y, p.z, Math.cos(a) * speed, 0.2, Math.sin(a) * speed, c, size, life, 2.8, 0);
    }
  }

  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      const l = this.life[i];
      if (l <= 0) {
        this.size[i] = 0;
        continue;
      }
      const nl = l - dt;
      this.life[i] = nl;
      if (nl <= 0) {
        this.size[i] = 0;
        this.alpha[i] = 0;
        continue;
      }
      const i3 = i * 3;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= d;
      this.vel[i3 + 1] = this.vel[i3 + 1] * d - this.grav[i] * dt;
      this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const f = nl / this.maxLife[i];
      this.alpha[i] = Math.min(1, f * 1.6);
      this.size[i] = this.baseSize[i] * (0.4 + f * 0.6);
    }
    for (const at of this.attrs) at.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.size.fill(0);
  }
}
