import * as THREE from 'three';
import type { Rng } from '../util/rng';
import type { Palette } from '../story/strata';
import type { Terrain } from './terrain';

const MAX_SEG = 34000;
const MAX_TIPS = 150;

interface Tip {
  x: number;
  z: number;
  a: number;
  life: number;
  gen: number;
}

/**
 * The living network. Growth tips random-walk across the terrain, lean toward
 * "targets" (nodes, echo-trees) and branch. Everything is one LineSegments
 * buffer; a shader reveals each segment as it is born and pulses light through it.
 */
export class Mycelium {
  readonly lines: THREE.LineSegments;
  private pos = new Float32Array(MAX_SEG * 6);
  private birth = new Float32Array(MAX_SEG * 2);
  private kind = new Float32Array(MAX_SEG * 2);
  private head = 0;
  private total = 0;
  private dirty = false;
  private tips: Tip[] = [];
  private targets: { x: number; z: number }[] = [];
  private anchors: { x: number; z: number }[] = [];
  private acc = 0;
  private now = 0;
  private u: Record<string, THREE.IUniform>;
  private geo = new THREE.BufferGeometry();

  constructor(private terrain: Terrain, private rng: Rng, palette: Palette) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    this.geo.setAttribute('aKind', new THREE.BufferAttribute(this.kind, 1));
    this.geo.setDrawRange(0, 0);
    this.u = {
      uTime: { value: 0 },
      uA: { value: new THREE.Color(palette.accent).multiplyScalar(1.05) },
      uB: { value: new THREE.Color(palette.accent2).multiplyScalar(1.05) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aBirth; attribute float aKind; varying float vBirth; varying float vKind; varying vec3 vP;
        void main(){ vBirth = aBirth; vKind = aKind; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uA, uB; varying float vBirth; varying float vKind; varying vec3 vP;
        void main(){
          float age = uTime - vBirth;
          if (age < 0.0) discard;
          float reveal = smoothstep(0.0, 0.35, age);
          float flash = exp(-age * 2.2) * 0.6;
          float pulse = 0.5 + 0.5 * sin(uTime * 2.4 - (vP.x + vP.z) * 0.35 + vKind * 5.0);
          vec3 c = mix(uA, uB, vKind) * (0.26 + 0.6 * pulse * pulse + flash);
          gl_FragColor = vec4(c * reveal, reveal);
        }`,
    });
    this.lines = new THREE.LineSegments(this.geo, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;
  }

  addTarget(x: number, z: number) {
    this.targets.push({ x, z });
    this.anchors.push({ x, z });
  }

  private addSeg(x0: number, z0: number, x1: number, z1: number, b: number, kind: number) {
    const i = this.head;
    this.head = (this.head + 1) % MAX_SEG;
    this.total = Math.min(this.total + 1, MAX_SEG);
    const p = i * 6;
    this.pos[p] = x0; this.pos[p + 1] = this.terrain.heightAt(x0, z0) + 0.14; this.pos[p + 2] = z0;
    this.pos[p + 3] = x1; this.pos[p + 4] = this.terrain.heightAt(x1, z1) + 0.14; this.pos[p + 5] = z1;
    this.birth[i * 2] = b;
    this.birth[i * 2 + 1] = b + 0.08;
    this.kind[i * 2] = kind;
    this.kind[i * 2 + 1] = kind;
    this.dirty = true;
  }

  seed(x: number, z: number, n = 3, gen = 0, life = 60) {
    for (let i = 0; i < n && this.tips.length < MAX_TIPS; i++) {
      this.tips.push({ x, z, a: this.rng.range(0, Math.PI * 2), life: life * this.rng.range(0.6, 1.2), gen });
    }
  }

  /** Grow a meandering hypha from a to b, revealed progressively. */
  connect(a: { x: number; z: number }, b: { x: number; z: number }) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) return;
    const steps = Math.min(Math.ceil(len / 1.1), 90);
    const nx = -dz / len;
    const nz = dx / len;
    const ph = this.rng.range(0, 6.28);
    const amp = Math.min(3.5, len * 0.12);
    let px = a.x;
    let pz = a.z;
    const kind = this.rng.range(0.2, 0.8);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const w = Math.sin(t * Math.PI) * amp * Math.sin(t * 7 + ph);
      const x = a.x + dx * t + nx * w;
      const z = a.z + dz * t + nz * w;
      this.addSeg(px, pz, x, z, this.now + i * 0.018, kind);
      if (i % 9 === 0) this.seed(x, z, 1, 2, 14);
      px = x;
      pz = z;
    }
    this.anchors.push({ x: b.x, z: b.z });
  }

  nearestAnchor(x: number, z: number, maxDist: number) {
    let best: { x: number; z: number } | null = null;
    let bd = maxDist * maxDist;
    for (const a of this.anchors) {
      const d = (a.x - x) ** 2 + (a.z - z) ** 2;
      if (d < bd && d > 1) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  addAnchor(x: number, z: number) {
    this.anchors.push({ x, z });
  }

  /** Simulate growth instantly (births back-dated) so a world opens already alive. */
  prewarm(steps: number) {
    for (let i = 0; i < steps; i++) this.tick(-4);
    this.dirty = true;
  }

  private tick(birth: number) {
    const R = this.terrain.radius * 1.02;
    for (let i = this.tips.length - 1; i >= 0; i--) {
      const tip = this.tips[i];
      // lean toward a nearby target
      let bias = 0;
      let best = 28 * 28;
      for (const tg of this.targets) {
        const d = (tg.x - tip.x) ** 2 + (tg.z - tip.z) ** 2;
        if (d < best) {
          best = d;
          const want = Math.atan2(tg.z - tip.z, tg.x - tip.x);
          bias = Math.atan2(Math.sin(want - tip.a), Math.cos(want - tip.a)) * 0.12;
        }
      }
      tip.a += this.rng.gauss() * 0.3 + bias;
      const step = 0.75;
      const nx = tip.x + Math.cos(tip.a) * step;
      const nz = tip.z + Math.sin(tip.a) * step;
      if (nx * nx + nz * nz > R * R) {
        tip.a += Math.PI * 0.6;
        tip.life -= 4;
        if (tip.life <= 0) this.tips.splice(i, 1);
        continue;
      }
      this.addSeg(tip.x, tip.z, nx, nz, birth, Math.min(1, 0.15 + tip.gen * 0.22));
      tip.x = nx;
      tip.z = nz;
      tip.life--;
      if (tip.gen < 3 && this.tips.length < MAX_TIPS && this.rng.chance(0.045)) {
        this.tips.push({ x: tip.x, z: tip.z, a: tip.a + this.rng.range(0.6, 1.2) * this.rng.sign(), life: tip.life * 0.55, gen: tip.gen + 1 });
      }
      if (tip.life <= 0) this.tips.splice(i, 1);
    }
  }

  update(dt: number, t: number) {
    this.now = t;
    this.u.uTime.value = t;
    this.acc += dt;
    while (this.acc > 0.06) {
      this.acc -= 0.06;
      this.tick(t);
    }
    if (this.dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aBirth.needsUpdate = true;
      this.geo.attributes.aKind.needsUpdate = true;
      this.geo.setDrawRange(0, this.total * 2);
      this.dirty = false;
    }
  }

  dispose() {
    this.geo.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}
