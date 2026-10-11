import * as THREE from 'three';
import { MeshBasicNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import {
  uniform, float, vec2, vec3, vec4, color, mix, sin, cos, floor, texture, pow, max, clamp, step, smoothstep, dot, atan, asin, exp, mod,
  positionLocal, positionGeometry, positionWorld, positionView, normalize, uv, instancedBufferAttribute, mrt, output,
} from 'three/tsl';
import type { Palette } from '../story/strata';
import { worldTime, hash21, glow, type N } from '../engine/materials';
import { nebulaTexture } from '../engine/proctex';

/** Blueprint twin moons: primary cyan 0x00e1ff, secondary magenta 0xff0077 at 0.65 scale. */
export const MOON_A = new THREE.Vector3(-150, 200, -400).normalize();
export const MOON_B = new THREE.Vector3(120, 180, -450).normalize();

export class Sky {
  readonly mesh: THREE.Mesh;
  constructor(p: Palette) {
    const u = {
      top: uniform(new THREE.Color(p.skyTop)),
      horizon: uniform(new THREE.Color(p.skyHorizon)),
      accent: uniform(new THREE.Color(p.accent)),
      accent2: uniform(new THREE.Color(p.accent2)),
    };
    const t = worldTime;
    const d: N = normalize(positionLocal);
    const y = clamp(d.y, -0.2, 1);
    let col: N = mix(u.horizon, u.top, pow(max(y, 0), 0.45));
    const suv = vec2(atan(d.z, d.x), asin(clamp(d.y, -1, 1)));
    // stars
    const g = floor(suv.mul(vec2(160, 90)));
    const s = step(0.9965, hash21(g));
    const stars = s.mul(sin(t.mul(2).add(hash21(g.add(3)).mul(20))).mul(0.5).add(0.5)).mul(smoothstep(0.1, 0.5, y));
    // aurora ribbons
    const band = sin(suv.x.mul(3).add(sin(suv.y.mul(5).add(t.mul(0.12))).mul(2)).add(t.mul(0.05)));
    const a = smoothstep(0.35, 1, band).mul(smoothstep(0.08, 0.35, y)).mul(float(1).sub(smoothstep(0.5, 0.95, y)));
    col = col.add(mix(u.accent, u.accent2, sin(suv.x.mul(2)).mul(0.5).add(0.5)).mul(a).mul(0.22));
    // the Buddhabrot nebula: the inverted Mandelbrot hangs in the sky opposite the moons, gnomonic-projected
    // around its centre direction, slowly turning, its own colours pulled toward the region's palette
    const nc = new THREE.Vector3(0.55, 0.42, 0.72).normalize();
    const nt = new THREE.Vector3(0, 1, 0).cross(nc).normalize();
    const nb = nc.clone().cross(nt).normalize();
    const dn: N = dot(d, vec3(nc.x, nc.y, nc.z));
    const rot: N = t.mul(0.004);
    const px: N = dot(d, vec3(nt.x, nt.y, nt.z)).div(max(dn, 0.05));
    const py: N = dot(d, vec3(nb.x, nb.y, nb.z)).div(max(dn, 0.05));
    const nuv: N = vec2(px.mul(cos(rot)).sub(py.mul(sin(rot))), px.mul(sin(rot)).add(py.mul(cos(rot)))).mul(0.62).add(0.5);
    const neb: N = texture(nebulaTexture(), nuv).rgb;
    const nebMask: N = smoothstep(0.25, 0.5, dn).mul(smoothstep(0.5, 0.42, nuv.sub(0.5).length())).mul(smoothstep(-0.05, 0.2, y));
    const tinted: N = u.accent2.mul(neb.r).add(u.accent.mul(neb.g)).add(u.top.mul(4).add(0.15).mul(neb.b));
    col = col.add(mix(neb, tinted, 0.55).mul(nebMask).mul(0.5));
    // twin moons with craters and halos
    const d1 = dot(d, vec3(MOON_A.x, MOON_A.y, MOON_A.z));
    const d2 = dot(d, vec3(MOON_B.x, MOON_B.y, MOON_B.z));
    const disc1 = smoothstep(0.9925, 0.9937, d1);
    const disc2 = smoothstep(0.9968, 0.9975, d2);
    const crater = sin(d.x.mul(90)).mul(sin(d.y.mul(80).add(d.z.mul(60)))).mul(0.18).add(0.82);
    const moonA = color(0x00e1ff).mul(disc1.mul(crater).mul(1.25).add(pow(max(d1, 0), 70).mul(0.3)));
    const moonB = color(0xff0077).mul(disc2.mul(crater).mul(1.1).add(pow(max(d2, 0), 90).mul(0.26)));
    const lights = moonA.add(moonB).add(vec3(stars));
    col = col.add(lights);

    const mat = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    mat.colorNode = col;
    // only the moons' discs and the stars feed bloom, never the sky gradient
    mat.mrtNode = mrt({ output, emissive: vec4(moonA.mul(disc1.add(disc2).min(1).mul(0.9).add(0.1)).add(moonB.mul(0.6)).add(vec3(stars).mul(0.6)), 1) });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(420, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }
  /** A tiny scene holding just this sky, for prefiltering into the image-based-lighting environment. */
  envScene() {
    const s = new THREE.Scene();
    // same sky without the bloom routing (prefiltering renders into a plain cube target)
    const mat = (this.mesh.material as MeshBasicNodeMaterial).clone();
    mat.mrtNode = null;
    const m = new THREE.Mesh(this.mesh.geometry, mat);
    s.add(m);
    return s;
  }
  update(_t: number, camPos: THREE.Vector3) {
    this.mesh.position.copy(camPos);
  }
  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Drifting bioluminescent motes — spores and data-dust in one. GPU-animated instanced billboards. */
export class Motes {
  readonly object: THREE.Sprite;
  private material: SpriteNodeMaterial;
  constructor(radius: number, count: number, p: Palette, rise: boolean) {
    const base = new Float32Array(count * 4);
    const col = new Float32Array(count * 3);
    const c1 = new THREE.Color(p.accent);
    const c2 = new THREE.Color(p.accent2);
    const tmp = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * 1.1;
      base[i * 4] = Math.cos(a) * r;
      base[i * 4 + 1] = Math.random() * 18;
      base[i * 4 + 2] = Math.sin(a) * r;
      base[i * 4 + 3] = Math.random();
      tmp.copy(c1).lerp(c2, Math.random());
      col[i * 3] = tmp.r;
      col[i * 3 + 1] = tmp.g;
      col[i * 3 + 2] = tmp.b;
    }
    const aBase: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(base, 4));
    const aCol: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(col, 3));
    const dir = float(rise ? 1 : -0.35);
    const seed = aBase.w;
    const t = worldTime.mul(seed.mul(0.4).add(0.25));
    const py = mod(aBase.y.add(t.mul(6).mul(dir)).add(seed.mul(18)), 18);
    const pos = vec3(aBase.x.add(sin(t.mul(1.3).add(seed.mul(40))).mul(1.6)), py, aBase.z.add(cos(t.mul(1.1).add(seed.mul(30))).mul(1.6)));
    const tw = sin(worldTime.mul(seed.mul(2).add(1)).add(seed.mul(50))).mul(0.5).add(0.5);
    const alpha = tw.mul(0.75).add(0.25).mul(smoothstep(0, 2, py)).mul(float(1).sub(smoothstep(14, 18, py)));
    const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.positionNode = pos;
    m.scaleNode = seed.mul(0.2).add(0.22);
    const disc = smoothstep(0.5, 0, uv().sub(0.5).length());
    m.colorNode = aCol.mul(1.6).mul(alpha);
    m.opacityNode = disc.mul(alpha);
    glow(m, 0.8);
    this.material = m;
    this.object = new THREE.Sprite(m);
    this.object.count = count;
    this.object.frustumCulled = false;
  }
  update() {}
  dispose() {
    this.material.dispose();
  }
}

/** A skyline of glowing crystal spires beyond the rim of the world, plus the blueprint's far ring at r≈500. */
export class Spires {
  readonly mesh: THREE.InstancedMesh;
  constructor(radius: number, p: Palette, count = 54) {
    const far = 12;
    const geo = new THREE.CylinderGeometry(0.5, 1, 1, 6).translate(0, 0.5, 0);
    const top: N = uniform(new THREE.Color(p.accent));
    const baseC: N = uniform(new THREE.Color(p.skyHorizon).multiplyScalar(0.5));
    const fogC: N = uniform(new THREE.Color(p.fog));
    const dens: N = uniform(p.fogDensity);
    const crystal: N = uniform(new THREE.Color(0x4a00e0));
    const vH: N = positionGeometry.y; // positionLocal is post-instancing in TSL
    const band = smoothstep(0.88, 0.99, sin(positionWorld.y.mul(0.35)));
    const vein = smoothstep(0.92, 1, sin(positionWorld.y.mul(0.11).add(atan(positionGeometry.z, positionGeometry.x).mul(3))));
    const c = mix(baseC, mix(top, crystal, 0.35).mul(0.9), pow(vH, 1.5));
    const e = top.mul(band.mul(0.5).mul(vH)).add(crystal.mul(vein.mul(0.6).mul(vH)));
    const D = positionView.length();
    const f = clamp(float(1).sub(exp(dens.mul(dens).mul(D).mul(D).mul(-0.12))), 0, 0.88);
    const mat = new MeshBasicNodeMaterial({ fog: false });
    mat.colorNode = mix(c.add(e), fogC, f);
    mat.mrtNode = mrt({ output, emissive: vec4(e.mul(float(1).sub(f)), 1) });
    this.mesh = new THREE.InstancedMesh(geo, mat, count + far);
    this.mesh.frustumCulled = false;
    const o = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.12;
      // a horizon skyline: the ring rides with the camera, so it can be approached but never reached
      const r = Math.max(radius * 1.95, 300) + Math.random() * 130;
      const h = 70 + Math.random() * 150;
      const w = 8 + Math.random() * 16;
      o.position.set(Math.cos(a) * r, -25, Math.sin(a) * r);
      o.rotation.set((Math.random() - 0.5) * 0.08, Math.random() * 3, (Math.random() - 0.5) * 0.08);
      o.scale.set(w, h, w);
      o.updateMatrix();
      this.mesh.setMatrixAt(i, o.matrix);
    }
    for (let i = 0; i < far; i++) {
      const a = (i / far) * Math.PI * 2 + Math.random() * 0.2;
      o.position.set(Math.cos(a) * 500, -40, Math.sin(a) * 500);
      o.rotation.set(0, Math.random() * 3, 0);
      o.scale.set(24 * (1 + Math.random()), 120 * (1 + Math.random() * 2), 24 * (1 + Math.random()));
      o.updateMatrix();
      this.mesh.setMatrixAt(count + i, o.matrix);
    }
  }
  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

