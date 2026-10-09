import * as THREE from 'three';
import type { Palette } from '../story/strata';

export class Sky {
  readonly mesh: THREE.Mesh;
  private u: Record<string, THREE.IUniform>;
  constructor(p: Palette) {
    this.u = {
      uTop: { value: new THREE.Color(p.skyTop) },
      uHorizon: { value: new THREE.Color(p.skyHorizon) },
      uAccent: { value: new THREE.Color(p.accent) },
      uAccent2: { value: new THREE.Color(p.accent2) },
      uTime: { value: 0 },
      uSun: { value: new THREE.Color(p.sun) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uHorizon, uAccent, uAccent2, uSun; uniform float uTime; varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main(){
          vec3 d = normalize(vDir);
          float y = clamp(d.y, -0.2, 1.0);
          vec3 col = mix(uHorizon, uTop, pow(max(y, 0.0), 0.45));
          vec2 uv = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0)));
          // stars
          vec2 g = floor(uv * vec2(160.0, 90.0));
          float s = step(0.9965, hash(g));
          col += s * (0.5 + 0.5 * sin(uTime * 2.0 + hash(g + 3.0) * 20.0)) * smoothstep(0.1, 0.5, y);
          // aurora ribbons
          float band = sin(uv.x * 3.0 + sin(uv.y * 5.0 + uTime * 0.12) * 2.0 + uTime * 0.05);
          float a = smoothstep(0.35, 1.0, band) * smoothstep(0.08, 0.35, y) * (1.0 - smoothstep(0.5, 0.95, y));
          col += mix(uAccent, uAccent2, 0.5 + 0.5 * sin(uv.x * 2.0)) * a * 0.22;
          // twin moons with halos
          vec3 m1 = normalize(vec3(0.55, 0.30, -0.78));
          vec3 m2 = normalize(vec3(-0.72, 0.42, -0.55));
          float d1 = dot(d, m1);
          float d2 = dot(d, m2);
          float disc1 = smoothstep(0.9935, 0.9945, d1);
          float disc2 = smoothstep(0.9975, 0.9981, d2);
          float crater = 0.82 + 0.18 * sin(d.x * 90.0) * sin(d.y * 80.0 + d.z * 60.0);
          col += uSun * (disc1 * crater * 1.15 + pow(max(d1, 0.0), 60.0) * 0.28);
          col += mix(uSun, uAccent2, 0.4) * (disc2 * 0.95 + pow(max(d2, 0.0), 80.0) * 0.22);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 16), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }
  update(t: number, camPos: THREE.Vector3) {
    this.u.uTime.value = t;
    this.mesh.position.copy(camPos);
  }
  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Drifting bioluminescent motes — spores and data-dust in one. */
export class Motes {
  readonly points: THREE.Points;
  private u: Record<string, THREE.IUniform>;
  constructor(radius: number, count: number, p: Palette, rise: boolean) {
    const base = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const col = new Float32Array(count * 3);
    const c1 = new THREE.Color(p.accent);
    const c2 = new THREE.Color(p.accent2);
    const tmp = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * 1.1;
      base[i * 3] = Math.cos(a) * r;
      base[i * 3 + 1] = Math.random() * 18;
      base[i * 3 + 2] = Math.sin(a) * r;
      seed[i] = Math.random();
      tmp.copy(c1).lerp(c2, Math.random());
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.u = { uTime: { value: 0 }, uScale: { value: 800 }, uDir: { value: rise ? 1 : -0.35 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSeed; attribute vec3 aColor; uniform float uTime, uScale, uDir;
        varying vec3 vC; varying float vA;
        void main(){
          vec3 p = position;
          float t = uTime * (0.25 + aSeed * 0.4);
          p.y = mod(p.y + t * 2.0 * uDir * 3.0 + aSeed * 18.0, 18.0);
          p.x += sin(t * 1.3 + aSeed * 40.0) * 1.6;
          p.z += cos(t * 1.1 + aSeed * 30.0) * 1.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float tw = 0.5 + 0.5 * sin(uTime * (1.0 + aSeed * 2.0) + aSeed * 50.0);
          gl_PointSize = (0.22 + 0.2 * aSeed) * uScale / max(-mv.z, 0.1);
          vA = (0.25 + 0.75 * tw) * smoothstep(0.0, 2.0, p.y) * (1.0 - smoothstep(14.0, 18.0, p.y));
          vC = aColor;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * 1.6 * vA, a * vA); }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }
  update(t: number, scale: number) {
    this.u.uTime.value = t;
    this.u.uScale.value = scale;
  }
  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}


/** A skyline of glowing crystal spires beyond the rim of the world. */
export class Spires {
  readonly mesh: THREE.InstancedMesh;
  constructor(radius: number, p: Palette, count = 54) {
    const geo = new THREE.CylinderGeometry(0.5, 1, 1, 6).translate(0, 0.5, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTop: { value: new THREE.Color(p.accent) }, uBase: { value: new THREE.Color(p.skyHorizon).multiplyScalar(0.5) }, uFog: { value: new THREE.Color(p.fog) }, uDensity: { value: p.fogDensity } },
      vertexShader: /* glsl */ `
        varying float vH; varying float vW; varying float vD;
        void main(){
          vH = position.y;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.y;
          vec4 mv = viewMatrix * wp; vD = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uBase, uFog; uniform float uDensity; varying float vH; varying float vW; varying float vD;
        void main(){
          float band = smoothstep(0.88, 0.99, sin(vW * 0.35));
          vec3 c = mix(uBase, uTop * 0.9, pow(vH, 1.5)) + uTop * band * 0.5 * vH;
          float f = 1.0 - exp(-uDensity * uDensity * vD * vD * 0.12);
          gl_FragColor = vec4(mix(c, uFog, clamp(f, 0.0, 0.88)), 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    const o = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.12;
      const r = radius * (1.95 + Math.random() * 1.1);
      const h = 70 + Math.random() * 150;
      const w = 8 + Math.random() * 16;
      o.position.set(Math.cos(a) * r, -25, Math.sin(a) * r);
      o.rotation.set((Math.random() - 0.5) * 0.08, Math.random() * 3, (Math.random() - 0.5) * 0.08);
      o.scale.set(w, h, w);
      o.updateMatrix();
      this.mesh.setMatrixAt(i, o.matrix);
    }
  }
  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
