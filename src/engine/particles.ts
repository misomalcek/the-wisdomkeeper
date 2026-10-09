import * as THREE from 'three';

const MAX = 5000;

/** One additive Points object holds every spark, spore and shockwave mote in the game. */
export class Particles {
  readonly points: THREE.Points;
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
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        uniform float uScale; varying vec3 vC; varying float vA;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
          vC = aColor; vA = aAlpha;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vC * vA, a * vA);
        }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  setScale(s: number) {
    this.mat.uniforms.uScale.value = s;
  }

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
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.size.fill(0);
  }
}
