import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { texture, uv, vec2, sin, atan, length, smoothstep, uniform, color, mix, fract } from 'three/tsl';
import { glow, glowBasic, glowLine, fbm2, worldTime, type N } from '../engine/materials';
import { sculptMaterial } from '../assets/creatureMaterial';
import { heroUniforms, applyLook } from '../assets/heroModel';
import { loadedModel } from '../assets/pipeline';
import { contactPadGeometry, datastreamDaisGeometry } from '../assets/propModels';
import { Rng } from '../util/rng';

/**
 * Act IV Resonance Contact, as in the vision frame: a machined slab hovering over a slow vortex of datastream
 * light, its core socket lit, arcs of resonance leaping from the core toward the Elder Tree once linked, and a
 * panel of scrolling datastream text hanging beside it. The node logic stays in MemoryNode; this is its body.
 */
export class ContactPad {
  readonly group = new THREE.Group();
  private pad: THREE.Mesh;
  private u = heroUniforms();
  private core: THREE.Mesh;
  private coreMat: MeshBasicNodeMaterial;
  private halo: THREE.Mesh;
  private haloMat: MeshBasicNodeMaterial;
  private vortexMat: MeshBasicNodeMaterial;
  private uSpin: N = uniform(0);
  private uGlow: N = uniform(0.3);
  private uTint = uniform(new THREE.Color());
  private panel: THREE.Mesh;
  private panelMat: MeshBasicNodeMaterial;
  private arcs: THREE.Line[] = [];
  private arcMat;
  private arcGeo: THREE.BufferGeometry[] = [];
  private arcTo: THREE.Vector3 | null = null;
  private arcClock = 0;
  private disposables: { dispose(): void }[] = [];
  private readonly hover = 1.7;

  constructor(seed: number) {
    const u = this.u;
    applyLook(u, { body: 0x3c4148, armor: 0x5a6672, vein: 0x40ffe0, accent: 0x8a7bff, dark: 0x171b22 });
    const mat = sculptMaterial(u, { mottle: 1.2, crackGlow: 0.35, rim: 0.15 });
    this.pad = new THREE.Mesh(loadedModel('resonanceContact')?.geometry ?? contactPadGeometry(), mat);
    this.pad.castShadow = true;
    this.pad.receiveShadow = true;
    this.pad.position.y = this.hover;
    this.group.add(this.pad);
    this.disposables.push(mat);

    // core flare above the socket
    this.coreMat = glowBasic({ color: new THREE.Color(0x40ffe0).multiplyScalar(2.2) });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), this.coreMat);
    this.core.position.y = 0.72;
    this.pad.add(this.core);
    this.haloMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const r: N = length(uv().sub(0.5)).mul(2);
    // additive: the mask goes into the colour too, since the bloom target takes rgb without alpha
    const hm: N = smoothstep(1, 0, r).pow(3);
    this.haloMat.colorNode = this.uTint.mul(this.uGlow.mul(1.2)).mul(hm);
    this.haloMat.opacityNode = hm;
    glow(this.haloMat);
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), this.haloMat);
    this.halo.position.y = this.hover + 0.8;
    this.group.add(this.halo);

    // the vortex beneath: spiral arms of light turning on the ground
    this.vortexMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const st: N = uv().sub(0.5).mul(2);
    const rad: N = length(st);
    const ang: N = atan(st.y, st.x);
    const swirl: N = sin(ang.mul(3).add(rad.mul(9)).sub(this.uSpin)).mul(0.5).add(0.5);
    const turb: N = fbm2(vec2(ang.mul(1.6), rad.mul(4).sub(this.uSpin.mul(0.3))));
    const arms: N = smoothstep(0.55, 0.95, swirl.mul(0.7).add(turb.mul(0.6)));
    const fall: N = smoothstep(1, 0.35, rad).mul(smoothstep(0.05, 0.3, rad));
    const eye: N = smoothstep(0.32, 0, rad);
    const vm: N = arms.mul(fall).add(eye.mul(0.6)).mul(this.uGlow).clamp(0, 1);
    this.vortexMat.colorNode = this.uTint.mul(vm).mul(1.3);
    this.vortexMat.opacityNode = vm;
    glow(this.vortexMat);
    const vortex = new THREE.Mesh(new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2), this.vortexMat);
    vortex.position.y = 0.25;
    vortex.renderOrder = 1;
    this.group.add(vortex);

    // datastream text panel hanging beside the pad
    const text = textPanelTexture(seed);
    this.panelMat = holoPanelMaterial(text, this.uTint.mul(1.4), this.uGlow.mul(0.6).add(0.4));
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.6), this.panelMat);
    this.panel.position.set(-3.6, this.hover + 2.4, 0.4);
    this.group.add(this.panel);

    // resonance arcs: jagged lines from the core, re-struck a few times a second
    this.arcMat = glowLine({ color: new THREE.Color(0x9ffff0).multiplyScalar(2.4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(ARC_N * 3), 3));
      const l = new THREE.Line(g, this.arcMat);
      l.frustumCulled = false;
      this.arcs.push(l);
      this.arcGeo.push(g);
      this.group.add(l);
    }
    this.disposables.push(text, this.coreMat, this.haloMat, this.vortexMat, this.panelMat, this.arcMat, this.core.geometry, this.halo.geometry, vortex.geometry, this.panel.geometry, ...this.arcGeo);
  }

  /** Where the arcs reach once the Contact is linked (the Elder Tree), in world space. */
  setArcTarget(world: THREE.Vector3, origin: THREE.Vector3) {
    this.arcTo = world.clone().sub(origin);
    const yaw = Math.atan2(this.arcTo.x, this.arcTo.z);
    this.pad.rotation.y = yaw + 0.3;
    this.panel.position.set(Math.cos(yaw) * 3.6, this.hover + 2.4, -Math.sin(yaw) * 3.6);
  }

  /** `c` is the node's current light colour; `level` 0 dormant … 1 active … 0.8 linked. */
  update(dt: number, t: number, c: THREE.Color, level: number, cam?: THREE.Vector3) {
    this.u.uT.value = t;
    this.u.cGlow.value.copy(c).multiplyScalar(0.55);
    this.uTint.value.copy(c).multiplyScalar(0.5);
    this.uGlow.value = 0.25 + level * 0.75;
    this.uSpin.value += dt * (0.4 + level * 1.6);
    this.coreMat.color.copy(c).multiplyScalar(1.1);
    this.pad.position.y = this.hover + Math.sin(t * 0.9) * 0.12;
    this.pad.rotation.z = Math.sin(t * 0.6) * 0.015;
    this.halo.position.y = this.pad.position.y + 0.8;
    if (cam) {
      this.halo.lookAt(cam);
      const pw = this.panel.getWorldPosition(_v);
      this.panel.rotation.y = Math.atan2(cam.x - pw.x, cam.z - pw.z);
    }
    // arcs: strike while active (to the ground around the pad) and once linked (toward the tree)
    this.arcClock -= dt;
    const on = level > 0.5;
    this.arcMat.opacity = damp1(this.arcMat.opacity, on ? 0.85 : 0, dt);
    if (on && this.arcClock <= 0) {
      this.arcClock = 0.07 + Math.random() * 0.12;
      const from = _v.set(0, this.pad.position.y + 0.75, 0);
      this.arcGeo.forEach((g, i) => {
        let to: THREE.Vector3;
        if (this.arcTo && i === 0) to = _w.copy(this.arcTo).setLength(Math.min(this.arcTo.length(), 14)).setY(from.y + 5 + Math.random() * 3);
        else {
          const a = Math.random() * Math.PI * 2;
          to = _w.set(Math.cos(a) * (2.5 + Math.random() * 1.5), 0.2, Math.sin(a) * (2.5 + Math.random() * 1.5));
        }
        strike(g.attributes.position as THREE.BufferAttribute, from, to, 0.18 + from.distanceTo(to) * 0.05);
      });
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

const ARC_N = 14;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const damp1 = (a: number, b: number, dt: number) => a + (b - a) * (1 - Math.exp(-8 * dt));

/** A jagged bolt between two points: midpoint-jittered polyline, tapering jitter at both ends. */
function strike(attr: THREE.BufferAttribute, a: THREE.Vector3, b: THREE.Vector3, amp: number) {
  for (let i = 0; i < ARC_N; i++) {
    const t = i / (ARC_N - 1);
    const j = Math.sin(t * Math.PI) * amp * 2;
    attr.setXYZ(i, a.x + (b.x - a.x) * t + (Math.random() - 0.5) * j, a.y + (b.y - a.y) * t + (Math.random() - 0.5) * j + Math.sin(t * Math.PI) * amp * 3, a.z + (b.z - a.z) * t + (Math.random() - 0.5) * j);
  }
  attr.needsUpdate = true;
}

/**
 * A 256×256 sheet of terminal text: left-aligned lines of 5×7 pseudo-glyphs with ragged lengths, a few indented,
 * a few bright "headers" — the floating datastream readouts of the vision frame. Built from bits (no canvas).
 */
export function holoPanelMaterial(text: THREE.Texture, tint: N, gain: N | number = 1) {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const pu: N = uv();
  const lines: N = texture(text, vec2(pu.x.mul(1.08).sub(0.04), fract(pu.y.mul(0.6).add(worldTime.mul(0.045)))));
  const flicker: N = sin(worldTime.mul(9).add(pu.y.mul(40))).mul(0.1).add(0.9);
  const fadeY: N = smoothstep(0, 0.1, pu.y).mul(smoothstep(1, 0.9, pu.y));
  // thin bracket frame on the left and top edges, a faint glass fill
  const frame: N = smoothstep(0.012, 0, pu.x).add(smoothstep(0.988, 1, pu.y).mul(smoothstep(0.35, 0, pu.x)));
  const ink: N = lines.r.mul(fadeY).mul(flicker);
  m.colorNode = mix(tint, color(0xe8fffb), 0.35).mul(ink.mul(2.2).add(frame.mul(1.5)).add(0.05));
  m.opacityNode = ink.mul(0.95).add(frame.mul(0.8)).add(0.05).clamp(0, 1).mul(gain);
  glow(m);
  return m;
}

export function textPanelTexture(seed: number) {
  const W = 256, H = 256, cw = 6, ch = 11;
  const rng = new Rng(seed * 7919 + 13);
  const data = new Uint8Array(W * H * 4);
  for (let row = 0; row < Math.floor(H / ch); row++) {
    if (rng.chance(0.12)) continue; // paragraph gap
    const header = rng.chance(0.14);
    const indent = header ? 0 : rng.chance(0.3) ? 2 : 0;
    const len = Math.floor(rng.range(header ? 8 : 14, W / cw - 2));
    const lvl = header ? 255 : Math.round(rng.range(120, 200));
    for (let col = indent; col < len; col++) {
      if (rng.chance(0.16)) continue; // word gap
      for (let gy = 0; gy < 7; gy++)
        for (let gx = 0; gx < 5; gx++) {
          if (!rng.chance(header ? 0.6 : 0.45)) continue;
          const x = col * cw + 2 + gx, y = H - 1 - (row * ch + 2 + gy);
          if (x >= W || y < 0) continue;
          const k = (y * W + x) * 4;
          data[k] = data[k + 1] = data[k + 2] = lvl;
          data[k + 3] = 255;
        }
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Datastream Contact (side missions): a machined dais throwing a thin beam of datastream light skyward, a ring
 * of light climbing the beam and a readout panel hanging beside it — the "Datastream Contact" callout of the
 * vision frame. Purely visual; the mission logic lives in the game.
 */
export class DatastreamDais {
  readonly group = new THREE.Group();
  private u = heroUniforms();
  private ring: THREE.Mesh;
  private panel: THREE.Mesh;
  private disposables: { dispose(): void }[] = [];

  private tint: THREE.Color;

  constructor(x: number, y: number, z: number, tint: THREE.Color, seed: number) {
    this.tint = tint.clone();
    this.group.position.set(x, y, z);
    const u = this.u;
    applyLook(u, { body: 0x3a4048, armor: 0x56626e, vein: tint.getHex(), accent: 0x8a7bff, dark: 0x161a20 });
    u.cGlow.value.copy(tint).multiplyScalar(0.9);
    const mat = sculptMaterial(u, { mottle: 1.6, crackGlow: 0.3, rim: 0.15 });
    const dais = new THREE.Mesh(loadedModel('datastreamDais')?.geometry ?? datastreamDaisGeometry(), mat);
    dais.receiveShadow = true;
    this.group.add(dais);

    const tintU = uniform(tint.clone());
    // the beam: an open cylinder fading up and toward its edges
    const beamMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const bu: N = uv();
    const streak: N = texture(textPanelTexture(seed + 77), vec2(bu.x.mul(2), fract(bu.y.mul(3).sub(worldTime.mul(0.25)))));
    const up: N = smoothstep(1, 0, bu.y).pow(1.6);
    beamMat.colorNode = tintU.mul(streak.r.mul(0.8).add(0.5)).mul(0.9).mul(up);
    beamMat.opacityNode = up.mul(0.6);
    glow(beamMat);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, 22, 10, 1, true).translate(0, 11.4, 0), beamMat);
    beam.frustumCulled = false;
    this.group.add(beam);
    // a ring climbing the beam
    const ringMat = glowBasic({ color: tint.clone().multiplyScalar(1.6), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 32).rotateX(-Math.PI / 2), ringMat);
    this.group.add(this.ring);
    // the readout
    const text = textPanelTexture(seed);
    const panelMat = holoPanelMaterial(text, tintU);
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.3), panelMat);
    this.panel.position.set(-2.2, 2.8, 0);
    this.group.add(this.panel);
    this.disposables.push(mat, beamMat, ringMat, panelMat, text, beam.geometry, this.ring.geometry, this.panel.geometry);
  }

  update(t: number, camPos: THREE.Vector3) {
    this.u.uT.value = t;
    const k = (t * 0.35) % 1;
    this.ring.position.y = 0.5 + k * 12;
    this.ring.scale.setScalar(1 + k * 1.6);
    (this.ring.material as MeshBasicNodeMaterial).color.copy(this.tint).multiplyScalar(1.6 * (1 - k));
    const a = Math.atan2(camPos.x - this.group.position.x, camPos.z - this.group.position.z);
    // keep the readout to the camera's left of the beam, facing it
    this.panel.position.set(-Math.cos(a) * 2.6, 3.2, Math.sin(a) * 2.6);
    this.panel.rotation.y = a;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
