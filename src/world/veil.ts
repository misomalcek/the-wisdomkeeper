import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { texture, uv, vec2, vec3, float, sin, pow, abs, positionWorld, positionLocal, mix, color, smoothstep, attribute } from 'three/tsl';
import { fbm2, floraGlow, glow, proceduralBump, standard, worldTime, type N } from '../engine/materials';
import type { Palette } from '../story/strata';
import type { Rng } from '../util/rng';
import type { Terrain } from './terrain';
import type { Cap, TetherAnchor } from './traversal';

/**
 * Act IV set piece from the final-vision frame: an Elder Tree whose trunk carries a spiral of shelf-mushroom
 * platforms, glowing mushroom bridges arcing from its trunk to the Resonance Contacts and the Central Pylon,
 * and columns of scrolling datastream glyphs rising through the fog.
 *
 * The caps are handed to MushroomGroves (one instanced draw for every cap in the region, physics included); this
 * module owns the tree, the bridge cords and the datastreams — three draw calls in total.
 */

export interface VeilLayout {
  tree: { x: number; z: number; y: number; r: number; h: number };
  caps: Cap[];
  /** Cap centre chains, one per bridge (for the mycelial cord under each bridge). */
  bridges: THREE.Vector3[][];
  anchors: TetherAnchor[];
}

const TRUNK_R = 5.2;
const TRUNK_H = 30;
const trunkRadius = (h: number) => TRUNK_R * (1 - (h / TRUNK_H) * 0.32);

/** Lay out the tree's spiral of shelf caps and the bridges from its trunk to each target. */
export function layoutVeil(terrain: Terrain, rng: Rng, tx: number, tz: number, targets: { x: number; z: number }[]): VeilLayout {
  const y0 = terrain.heightAt(tx, tz);
  const caps: Cap[] = [];
  const anchors: TetherAnchor[] = [];
  // spiral stair of shelf fungi up the trunk: every step is a short hop (rise 1.35 m, 0.6 rad)
  let a = rng.range(0, Math.PI * 2);
  const ring: { a: number; h: number; c: Cap }[] = [];
  for (let h = 1.6; h < TRUNK_H - 3; h += 1.35) {
    const r = rng.range(1.7, 2.3);
    const d = trunkRadius(h) + r * 0.62;
    const c: Cap = { x: tx + Math.cos(a) * d, y: y0 + h, z: tz + Math.sin(a) * d, r, bounce: false, crown: false, stalk: false };
    caps.push(c);
    ring.push({ a, h, c });
    a += 0.6;
  }
  // crown cap on top of the trunk, a lookout over the stratum
  const top: Cap = { x: tx, y: y0 + TRUNK_H + 0.4, z: tz, r: 4.6, bounce: false, crown: true, stalk: false };
  caps.push(top);
  anchors.push({ pos: new THREE.Vector3(tx, top.y + 2, tz), label: 'Elder Tree' });

  // bridges: leave the trunk from the spiral step that faces the target, then step down to it
  const bridges: THREE.Vector3[][] = [];
  for (const t of targets) {
    const ta = Math.atan2(t.z - tz, t.x - tx);
    const dist = Math.hypot(t.x - tx, t.z - tz);
    if (dist < 25 || dist > 110) continue;
    // the highest spiral step facing the target whose bridge stays walkable
    const maxH = Math.min(TRUNK_H - 6, (dist - 10) / 3.1);
    let start = ring[0];
    for (const s of ring) {
      const da = Math.abs(Math.atan2(Math.sin(s.a - ta), Math.cos(s.a - ta)));
      if (da < 0.6 && s.h <= maxH && s.h > start.h) start = s;
    }
    const sx = start.c.x;
    const sz = start.c.z;
    const sy = start.c.y;
    const ex = t.x - Math.cos(ta) * 6;
    const ez = t.z - Math.sin(ta) * 6;
    const ey = terrain.heightAt(ex, ez) + 1.2;
    const L = Math.hypot(ex - sx, ez - sz);
    const n = Math.max(3, Math.ceil(L / 3.1));
    const chain: THREE.Vector3[] = [new THREE.Vector3(sx, sy, sz)];
    const side = rng.range(-1, 1);
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      // a slight S-curve and a gentle arch so the bridge reads as grown, not placed
      const lat = Math.sin(k * Math.PI * 2) * 2.2 * side;
      const x = sx + (ex - sx) * k - Math.sin(ta) * lat;
      const z = sz + (ez - sz) * k + Math.cos(ta) * lat;
      const ground = terrain.heightAt(x, z);
      const y = Math.max(ground + 1.0, sy + (ey - sy) * k + Math.sin(k * Math.PI) * 2.2);
      const r = rng.range(1.5, 1.95);
      caps.push({ x, y, z, r, bounce: false, crown: false, stalk: y - ground < 3.5 });
      chain.push(new THREE.Vector3(x, y, z));
      if (i % 5 === 0) anchors.push({ pos: new THREE.Vector3(x, y + 2.2, z), label: 'Mushroom bridge' });
    }
    bridges.push(chain);
  }
  return { tree: { x: tx, z: tz, y: y0, r: TRUNK_R, h: TRUNK_H }, caps, bridges, anchors };
}

/** Orient a unit cylinder (y-up, base at origin) from a to b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, radial: number, depth: number) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, Math.max(2, Math.round(len / 2)), true).translate(0, len / 2, 0);
  // gnarl: wobble the surface so limbs aren't perfect cones
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const ang = Math.atan2(z, x);
    const w = 1 + 0.12 * Math.sin(ang * 5 + y * 0.35) + 0.06 * Math.sin(ang * 11 - y * 0.9);
    p.setXYZ(i, x * w, y, z * w);
  }
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q).translate(a.x, a.y, a.z);
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(new Float32Array(p.count).fill(depth), 1));
  return g;
}

export class VeilSetPiece {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  readonly tips: THREE.Vector3[] = [];
  readonly tree: VeilLayout['tree'];

  constructor(layout: VeilLayout, pal: Palette, rng: Rng, columns: { x: number; z: number; y: number }[]) {
    const T = layout.tree;
    this.tree = T;
    const parts: THREE.BufferGeometry[] = [];
    // trunk in three tapering sections with a lean, then flared roots
    const base = new THREE.Vector3(T.x, T.y - 1.5, T.z);
    let prev = base;
    const lean = new THREE.Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).multiplyScalar(0.6);
    for (let s = 1; s <= 3; s++) {
      const h = (T.h * s) / 3;
      const next = new THREE.Vector3(T.x + lean.x * s, T.y + h, T.z + lean.z * s);
      parts.push(limb(prev, next, trunkRadius(Math.max(0, h - T.h / 3)) * (s === 1 ? 1.12 : 1), trunkRadius(h), 18, 0));
      prev = next;
    }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const out = new THREE.Vector3(T.x + Math.cos(a) * T.r * 2.6, T.y - 1.2, T.z + Math.sin(a) * T.r * 2.6);
      parts.push(limb(new THREE.Vector3(T.x + Math.cos(a) * T.r * 0.5, T.y + 3.5, T.z + Math.sin(a) * T.r * 0.5), out, 2.0, 0.5, 9, 0));
    }
    // fractal crown: each limb splits in 2-3, shrinking by the golden-ish ratio (phyto-fractal branching)
    const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
      const to = from.clone().addScaledVector(dir, len);
      parts.push(limb(from, to, r, r * 0.66, depth < 2 ? 10 : 6, depth));
      if (depth >= 4) {
        this.tips.push(to);
        return;
      }
      const kids = depth === 0 ? 4 : rng.chance(0.4) ? 3 : 2;
      const spin = rng.range(0, Math.PI * 2);
      for (let k = 0; k < kids; k++) {
        const az = spin + (k / kids) * Math.PI * 2;
        const tilt = depth === 0 ? 0.95 : rng.range(0.45, 0.8);
        const nd = dir.clone().applyAxisAngle(new THREE.Vector3(Math.cos(az), 0, Math.sin(az)), tilt);
        nd.y = Math.max(nd.y, -0.1) + 0.12;
        grow(to, nd.normalize(), len * 0.7, r * 0.62, depth + 1);
      }
    };
    grow(prev, new THREE.Vector3(0, 1, 0), 9, trunkRadius(T.h) * 0.95, 0);
    const treeGeo = mergeGeometries(parts, false)!;
    parts.forEach((g) => g.dispose());

    // bark: dark violet-black with data-river veins climbing toward the crown
    const bark = standard({ color: new THREE.Color(pal.groundBase).lerp(new THREE.Color(0x1a1226), 0.6), roughness: 0.85, metalness: 0.05 });
    const w: N = positionWorld;
    const grain: N = fbm2(vec2(w.x.add(w.z).mul(0.35), w.y.mul(0.12)));
    const veins: N = pow(float(1).sub(abs(grain.mul(2).sub(1))), float(14));
    const climb: N = sin(w.y.mul(0.45).sub(worldTime.mul(2.2)).add(grain.mul(6))).mul(0.5).add(0.5);
    const depth: N = attribute('aDepth', 'float');
    const vein = mix(color(pal.accent), color(pal.accent2), smoothstep(1, 4, depth));
    // fibrous bark: long vertical ridges over knotted grain, carved into the shading by procedural bump
    const fibre: N = fbm2(vec2(w.x.add(w.z.mul(0.7)).mul(2.4), w.y.mul(0.18)));
    const fine: N = fbm2(vec2(w.x.sub(w.z).mul(7), w.y.mul(1.1)));
    const ridge: N = pow(abs(fibre.mul(2).sub(1)), float(0.6));
    bark.normalNode = proceduralBump(ridge.mul(0.8).add(fine.mul(0.25)).add(grain.mul(0.5)), 0.09);
    bark.colorNode = vec3(bark.color.r, bark.color.g, bark.color.b).mul(grain.mul(0.6).add(0.6)).mul(ridge.mul(0.7).add(0.55));
    bark.emissiveNode = vein.mul(veins.mul(climb.mul(2.6).add(0.4))).mul(floraGlow);
    const tree = new THREE.Mesh(treeGeo, bark);
    tree.castShadow = tree.receiveShadow = true;
    this.group.add(tree);

    // canopy glow: bioluminescent spore clusters at every branch tip
    const tipGeo = new THREE.IcosahedronGeometry(1, 1);
    const tipMat = glow(new MeshBasicNodeMaterial({ vertexColors: false }), floraGlow.mul(1.2));
    const tips = new THREE.InstancedMesh(tipGeo, tipMat, this.tips.length * 3);
    tips.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.tips.length * 9), 3);
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    let n = 0;
    for (const t of this.tips) {
      for (let k = 0; k < 3; k++) {
        o.position.set(t.x + rng.range(-1.5, 1.5), t.y + rng.range(-1, 1), t.z + rng.range(-1.5, 1.5));
        o.scale.setScalar(rng.range(0.35, 0.9));
        o.updateMatrix();
        tips.setMatrixAt(n, o.matrix);
        tips.setColorAt(n, c.set(rng.chance(0.6) ? pal.accent : pal.accent2).multiplyScalar(rng.range(1.6, 2.8)));
        n++;
      }
    }
    tips.frustumCulled = false;
    this.group.add(tips);

    // mycelial cords: a glowing spine running under every bridge
    const cordParts: THREE.BufferGeometry[] = [];
    for (const chain of layout.bridges) {
      const pts = chain.map((p) => p.clone().setY(p.y - 0.45));
      if (pts.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(pts);
      cordParts.push(new THREE.TubeGeometry(curve, pts.length * 6, 0.16, 5, false));
    }
    if (cordParts.length) {
      const cordGeo = mergeGeometries(cordParts, false)!;
      cordParts.forEach((g) => g.dispose());
      const cordMat = new MeshBasicNodeMaterial();
      const flow: N = sin(positionLocal.x.add(positionLocal.z).mul(0.6).sub(worldTime.mul(5))).mul(0.5).add(0.5);
      cordMat.colorNode = color(pal.accent).mul(flow.mul(2.2).add(0.6)).mul(floraGlow);
      glow(cordMat);
      const cords = new THREE.Mesh(cordGeo, cordMat);
      cords.frustumCulled = false;
      this.group.add(cords);
      this.disposables.push(cordGeo, cordMat);
    }

    // datastreams: columns of scrolling glyphs (one merged mesh, one draw)
    const glyphs = glyphTexture(rng);
    const colParts: THREE.BufferGeometry[] = [];
    columns.forEach((p, i) => {
      const h = 16 + (i % 3) * 5;
      const g = new THREE.CylinderGeometry(1.1, 1.1, h, 14, 1, true).translate(p.x, p.y + h / 2 - 0.5, p.z);
      // shift each column's glyph lane so no two read the same
      const uvA = g.attributes.uv as THREE.BufferAttribute;
      const shift = rng.next();
      for (let k = 0; k < uvA.count; k++) uvA.setXY(k, uvA.getX(k) * 3 + shift, uvA.getY(k) * (h / 8) + shift * 7);
      colParts.push(g);
    });
    if (colParts.length) {
      const colGeo = mergeGeometries(colParts, false)!;
      colParts.forEach((g) => g.dispose());
      const colMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const st: N = uv();
      const g1: N = texture(glyphs, vec2(st.x, st.y.sub(worldTime.mul(0.35))));
      const fade: N = smoothstep(0, 0.15, positionLocal.y.sub(columns[0]?.y ?? 0).div(6).clamp(0, 1));
      colMat.colorNode = color(pal.accent).mul(g1.r.mul(1.7));
      colMat.opacityNode = g1.r.mul(0.55).mul(fade.add(0.4).min(1));
      glow(colMat);
      const cols = new THREE.Mesh(colGeo, colMat);
      cols.frustumCulled = false;
      cols.renderOrder = 2;
      this.group.add(cols);
      this.disposables.push(colGeo, colMat);
    }
    this.disposables.push(treeGeo, bark, tipGeo, tipMat, glyphs);
    this.tipsMesh = tips;
  }

  private tipsMesh: THREE.InstancedMesh;

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.tipsMesh.dispose();
  }
}

/**
 * A 128×512 glyph sheet: rows of 5×7 pseudo-characters (hex digits, runes, binary) with trailing fades, like the
 * datastream text in the vision frame. Built from bits so it works without a canvas (tests run in Node).
 */
function glyphTexture(rng: Rng) {
  const W = 128;
  const H = 512;
  const data = new Uint8Array(W * H * 4);
  const cw = 8;
  const ch = 10;
  for (let col = 0; col < W / cw; col++) {
    // each lane is a falling "message": runs of glyphs separated by gaps, bright head, dimming tail
    let run = 0;
    let bright = 0;
    for (let row = H / ch - 1; row >= 0; row--) {
      if (run <= 0) {
        run = rng.chance(0.55) ? -Math.floor(rng.range(4, 14)) : Math.floor(rng.range(3, 12));
        bright = 1;
      }
      if (run < 0) {
        run++;
        continue;
      }
      run--;
      bright *= 0.9;
      const lvl = Math.round(255 * (0.35 + 0.65 * bright));
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (!rng.chance(0.42)) continue;
          const x = col * cw + 1 + gx;
          const y = row * ch + 1 + gy;
          const k = (y * W + x) * 4;
          data[k] = data[k + 1] = data[k + 2] = lvl;
          data[k + 3] = 255;
        }
      }
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
