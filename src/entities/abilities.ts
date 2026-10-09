import * as THREE from 'three';

const _o = new THREE.Object3D();

interface Spike {
  x: number;
  y: number;
  z: number;
  t: number; // seconds since erupt (negative = delayed)
  s: number;
  tilt: number;
}

/** Visual layer for abilities: root spikes, fractal shield, melee sweep arc, surge ring. */
export class AbilityFx {
  readonly group = new THREE.Group();
  private spikeMesh: THREE.InstancedMesh;
  private spikes: Spike[] = [];
  private shieldGroup = new THREE.Group();
  private shieldMat: THREE.ShaderMaterial;
  private shieldWire: THREE.Mesh;
  private want = false;
  private shieldOn = 0; // 0..1
  private shieldFlash = 0;
  private arc: THREE.Mesh;
  private arcMat: THREE.MeshBasicMaterial;
  private arcT = 1;
  private surge: THREE.Mesh;
  private surgeT = 99;
  private surgeR = 15;
  private time = 0;

  constructor() {
    const col = new THREE.Color(0x9bff6b).multiplyScalar(1.6);
    this.spikeMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.55, 3.2, 6).translate(0, 1.6, 0),
      new THREE.MeshStandardMaterial({ color: 0x2a4a2a, emissive: col, emissiveIntensity: 0.9, roughness: 0.5, flatShading: true }),
      64,
    );
    this.spikeMesh.count = 0;
    this.spikeMesh.frustumCulled = false;
    this.group.add(this.spikeMesh);

    this.shieldMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uT: { value: 0 }, uA: { value: 0 }, uFlash: { value: 0 }, uCol: { value: new THREE.Color(0x4fd8ff) } },
      vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vP; varying vec3 vV; void main(){ vP = position; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        uniform float uT, uA, uFlash; uniform vec3 uCol; varying vec3 vN; varying vec3 vP; varying vec3 vV;
        void main(){
          float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
          vec3 p = normalize(vP);
          float hex = abs(sin(p.x * 14.0 + uT * 0.6) * sin(p.y * 14.0 - uT * 0.5) * sin(p.z * 14.0 + uT * 0.4));
          float lines = smoothstep(0.82, 0.98, hex);
          float a = (fres * 0.85 + lines * 0.55 + 0.05) * uA;
          vec3 c = mix(uCol, vec3(1.0), uFlash) * (1.0 + uFlash * 2.0);
          gl_FragColor = vec4(c * a * 1.6, a);
        }`,
    });
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.75, 3), this.shieldMat);
    this.shieldWire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.45, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0x9fefff).multiplyScalar(1.6), wireframe: true, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.shieldGroup.add(shell, this.shieldWire);
    this.shieldGroup.visible = false;
    this.group.add(this.shieldGroup);

    this.arcMat = new THREE.MeshBasicMaterial({ color: 0x9bffd8, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    this.arc = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 28, 1, -0.95, 1.9).rotateX(-Math.PI / 2), this.arcMat);
    this.arc.visible = false;
    this.group.add(this.arc);

    this.surge = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 72).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xb084ff).multiplyScalar(3), transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.group.add(this.surge);
  }

  addSpike(x: number, y: number, z: number, delay: number, scale = 1) {
    if (this.spikes.length >= 64) this.spikes.shift();
    this.spikes.push({ x, y, z, t: -delay, s: scale, tilt: (Math.random() - 0.5) * 0.35 });
  }

  showShield(on: boolean) {
    this.want = on;
    if (on) this.shieldGroup.visible = true;
  }
  flashShield() {
    this.shieldFlash = 1;
  }
  setShieldColor(c: THREE.ColorRepresentation) {
    this.shieldMat.uniforms.uCol.value.set(c);
  }

  /** Sweep arc in front of the hero (sx: reach, yaw faces +z) */
  swing(x: number, y: number, z: number, yaw: number, reach: number, half: number, color: THREE.Color) {
    this.arc.position.set(x, y, z);
    this.arc.rotation.y = yaw - Math.PI / 2;
    this.arc.scale.set(reach, 1, reach);
    this.arcMat.color.copy(color).multiplyScalar(0.7);
    // ring theta range is fixed (±0.95); scale handles wide slams by widening the mesh
    this.arc.scale.z = reach * Math.min(1.6, half / 0.95);
    this.arc.visible = true;
    this.arcT = 0;
  }

  castSurge(x: number, y: number, z: number, radius: number) {
    this.surge.position.set(x, y + 0.4, z);
    this.surgeR = radius;
    this.surgeT = 0;
  }

  update(dt: number, shieldHp: number, shieldMax: number, playerPos: THREE.Vector3) {
    this.time += dt;
    // spikes
    let n = 0;
    for (let i = this.spikes.length - 1; i >= 0; i--) {
      const s = this.spikes[i];
      s.t += dt;
      if (s.t > 0.75) {
        this.spikes.splice(i, 1);
        continue;
      }
    }
    for (const s of this.spikes) {
      if (s.t < 0) continue;
      const up = s.t < 0.14 ? s.t / 0.14 : s.t < 0.5 ? 1 : 1 - (s.t - 0.5) / 0.25;
      const k = Math.max(0.001, up) * s.s;
      _o.position.set(s.x, s.y - 0.2, s.z);
      _o.rotation.set(s.tilt, s.t * 4, -s.tilt);
      _o.scale.set(k, k * (0.4 + up * 0.8), k);
      _o.updateMatrix();
      this.spikeMesh.setMatrixAt(n++, _o.matrix);
    }
    this.spikeMesh.count = n;
    this.spikeMesh.instanceMatrix.needsUpdate = true;

    // shield
    const want = this.want && shieldHp > 0;
    this.shieldOn += ((want ? 1 : 0) - this.shieldOn) * Math.min(1, dt * 8);
    this.shieldGroup.visible = this.shieldOn > 0.02;
    if (this.shieldGroup.visible) {
      this.shieldGroup.position.set(playerPos.x, playerPos.y + 1.0, playerPos.z);
      this.shieldFlash = Math.max(0, this.shieldFlash - dt * 4);
      const u = this.shieldMat.uniforms;
      u.uT.value = this.time;
      u.uA.value = this.shieldOn * (0.45 + 0.55 * Math.min(1, shieldHp / Math.max(shieldMax, 1)));
      u.uFlash.value = this.shieldFlash;
      this.shieldGroup.rotation.y += dt * 0.6;
      this.shieldWire.rotation.set(this.time * 0.9, -this.time * 0.7, 0);
      this.shieldGroup.scale.setScalar(0.9 + this.shieldOn * 0.1 + this.shieldFlash * 0.06);
    }

    // melee arc
    if (this.arc.visible) {
      this.arcT += dt / 0.2;
      this.arcMat.opacity = Math.max(0, 0.85 * (1 - this.arcT));
      if (this.arcT >= 1) this.arc.visible = false;
    }

    // surge
    this.surgeT += dt;
    const k = Math.min(1, this.surgeT / 0.55);
    const mat = this.surge.material as THREE.MeshBasicMaterial;
    mat.opacity = k >= 1 ? 0 : (1 - k) * 0.9;
    this.surge.scale.setScalar(Math.max(0.01, k * this.surgeR * 1.05));
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}
