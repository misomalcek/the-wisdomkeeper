import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, float, mix, sin, vec3 } from 'three/tsl';
import { fresnel, glowBasic, type N } from '../engine/materials';
import { loadedModel } from '../assets/pipeline';
import { LASHER_THROAT, LB, SB, bloaterGeometry, buildLasherRig, buildStalkerRig, lasherGeometry, shardGeometry, sierpinskiGeometry, stalkerGeometry } from '../assets/broodModels';
import type { Enemy } from './enemies';
import type { Game } from '../game';
import { TAU, angleDiff, clamp } from '../util/math';

/**
 * The Null's second brood (Task 1 of the variety pass): four procedurally sculpted foes with their own roles, so a
 * fight asks for more than circle-strafing.
 *  - Lattice Stalker: a six-legged crystal hunter that circles, crouches and pounces; it is open while airborne
 *    and while it recovers from the landing.
 *  - Spore Bloater: a drifting gas-sac that swells and bursts near the hero; burst it early and the blast tears
 *    through the Null around it instead.
 *  - Fractal Prism: a hovering Sierpinski crystal that refracts its shield onto two allies (they take far less
 *    damage while linked) and throws fans of slow bolts. Kill it first.
 *  - Root Lasher: a burrowing bloom that surfaces near the hero, sends a travelling line of root spikes along
 *    the ground (jump, dash or fly over it), then burrows to a new spot.
 */

const _v = new THREE.Vector3();
const HEART = new THREE.IcosahedronGeometry(0.3, 1);
const LINK = new THREE.CylinderGeometry(0.03, 0.03, 1, 5, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
const SPORE = new THREE.Color(0xc8ff4a);
const PRISM = new THREE.Color(0xd8c8ff);
const EMBER = new THREE.Color(0xff6a3b);
const SOIL = new THREE.Color(0x3a2a1e);

/** Hover height above ground for each floating kind (walkers and the burrower use their own rules). */
export const BROOD_HOVER: Partial<Record<Enemy['kind'], number>> = { bloater: 2.4, prism: 4.2 };

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

export function buildStalker(e: Enemy) {
  const mat = e.nullMaterial({ body: 0x2c3448, armor: 0x56627e, vein: 0x7af0ff, accent: 0xb6a0ff, dark: 0x141824 }, 2.4, 0.5);
  const rig = buildStalkerRig();
  const mesh = new THREE.SkinnedMesh(loadedModel('latticeStalker')?.geometry ?? stalkerGeometry(), mat);
  mesh.add(rig.bones[SB.root]);
  mesh.bind(rig.skeleton);
  mesh.frustumCulled = false;
  e.body.add(mesh);
  const core = glowBasic({ color: new THREE.Color(0x7af0ff).multiplyScalar(2.6) });
  e.coreMat = core;
  e.baseEmissive = 1;
  const heart = new THREE.Mesh(HEART, core);
  heart.scale.setScalar(0.45);
  heart.position.set(0, -0.16, -0.8);
  rig.bones[SB.body].add(heart);
  e.rig = rig.bones;
  e.torsoY = 0.95;
  e.makeTele(1.3, 1);
  e.makeBar(2.2);
  e.group.scale.setScalar(0.01);
}

export function buildBloater(e: Enemy) {
  const mat = e.nullMaterial({ body: 0x4a3a52, armor: 0x8a7a5a, vein: 0xc8ff4a, accent: 0xff8ad8, dark: 0x1e1624 }, 3.2, 0.8);
  e.body.add(new THREE.Mesh(loadedModel('sporeBloater')?.geometry ?? bloaterGeometry(), mat));
  const core = glowBasic({ color: SPORE.clone().multiplyScalar(2.4) });
  e.coreMat = core;
  e.baseEmissive = 1;
  const heart = new THREE.Mesh(HEART, core);
  heart.scale.setScalar(0.5);
  heart.position.y = -0.72;
  e.body.add(heart);
  e.group.scale.setScalar(0.01);
}

/** Thin-film crystal: hue sweeps with the view angle, time and each tetra's address in the fractal. */
function prismMaterial(e: Enemy) {
  const m = new MeshStandardNodeMaterial({ metalness: 0.35, roughness: 0.12, flatShading: true });
  const lv: N = attribute('aLevel', 'float');
  const f: N = fresnel(2.6);
  // a narrow cyan-to-violet band, so it reads as one crystal rather than a quilt of colours
  const hue: N = lv.mul(1.6).add(e.uT.mul(0.5)).add(f.mul(2.5)).add(3.6);
  const film: N = mix(vec3(sin(hue), sin(hue.add(2.094)), sin(hue.add(4.188))).mul(0.5).add(0.5), vec3(0.75, 0.8, 1), 0.35);
  m.colorNode = vec3(0.035, 0.03, 0.06).add(film.mul(0.05));
  // a wave of light runs down the generations of the fractal
  const wave: N = sin(lv.mul(25).sub(e.uT.mul(3))).mul(0.5).add(0.5);
  m.emissiveNode = film.mul(f.mul(1.1).add(wave.pow(float(10)).mul(0.6)).add(0.03)).add(vec3(1, 0.25, 0.35).mul(e.uHurt));
  e.extraMats.push(m);
  return m;
}

export function buildPrism(e: Enemy) {
  const mat = prismMaterial(e);
  const crystal = new THREE.Mesh(sierpinskiGeometry(3, 2.3), mat);
  crystal.castShadow = true;
  // stand it on a vertex so its silhouette reads as nested triangles from any side
  crystal.quaternion.setFromUnitVectors(new THREE.Vector3(1, 1, 1).normalize(), new THREE.Vector3(0, 1, 0));
  e.body.add(crystal);
  e.aux.crystal = e.body.children.length - 1;
  const core = glowBasic({ color: PRISM.clone().multiplyScalar(2.6) });
  e.coreMat = core;
  e.baseEmissive = 1;
  const heart = new THREE.Mesh(HEART, core);
  heart.scale.setScalar(0.55);
  e.body.add(heart);
  // three satellite shards on a tilted orbit
  const orbit = new THREE.Group();
  orbit.userData.axis = new THREE.Vector3(0.25, 1, 0.1).normalize();
  orbit.userData.rate = 1.4;
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(shardGeometry(), mat);
    const a = (i / 3) * TAU;
    s.position.set(Math.cos(a) * 1.9, Math.sin(a * 2) * 0.3, Math.sin(a) * 1.9);
    orbit.add(s);
  }
  e.spinners.push(orbit);
  e.body.add(orbit);
  // refraction links to the allies it shields
  const linkMat = glowBasic({ color: new THREE.Color(0x9ae8ff).multiplyScalar(2.2), transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
  e.extraMats.push(linkMat);
  for (let i = 0; i < 2; i++) {
    const l = new THREE.Mesh(LINK, linkMat);
    l.visible = false;
    l.frustumCulled = false;
    e.links.push(l);
    e.group.add(l);
  }
  e.makeBar(2.6);
  e.group.scale.setScalar(0.01);
}

export function buildLasher(e: Enemy) {
  const mat = e.nullMaterial({ body: 0x3e4a2c, armor: 0x5a3a2a, vein: 0xff6a3b, accent: 0xd8ff7a, dark: 0x1e140e }, 1.8, 0.65);
  const rig = buildLasherRig();
  const mesh = new THREE.SkinnedMesh(loadedModel('rootLasher')?.geometry ?? lasherGeometry(), mat);
  mesh.add(rig.bones[LB.root]);
  mesh.bind(rig.skeleton);
  mesh.frustumCulled = false;
  e.body.add(mesh);
  const core = glowBasic({ color: EMBER.clone().multiplyScalar(2.6) });
  e.coreMat = core;
  e.baseEmissive = 1;
  const heart = new THREE.Mesh(HEART, core);
  heart.scale.setScalar(0.5);
  heart.position.copy(LASHER_THROAT);
  rig.bones[LB.head].add(heart);
  e.rig = rig.bones;
  e.makeTele(1.8, 1);
  e.makeBar(4.4);
  e.state = 'rise';
  e.st = 0.9;
  e.aux.emerge = 0;
  e.group.scale.setScalar(0.01);
}

// ---------------------------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------------------------

/** Lattice Stalker: circle at ~10 m, crouch with a telegraphed line, then a ballistic pounce onto the lead point. */
export function stalkerStep(e: Enemy, g: Game, dt: number, rawDt: number, gh: number, dxz: number, toP: number, touch: (r?: number) => void) {
  const p = g.player;
  e.cd -= dt;
  const a = e.aux;
  if (e.state === 'chase') {
    const want = 10;
    let ang = toP;
    let sp = e.speed;
    if (dxz < want - 3) {
      ang = toP + Math.PI * 0.75 * e.strafe;
      sp *= 0.8;
    } else if (dxz < want + 3) {
      ang = toP + (Math.PI / 2) * e.strafe;
      sp *= 0.6;
    } else ang += Math.sin(g.time * 2 + e.id) * 0.4;
    if (Math.random() < rawDt * 0.3) e.strafe *= -1;
    e.x += Math.sin(ang) * sp * dt;
    e.z += Math.cos(ang) * sp * dt;
    e.yawFace += angleDiff(e.yawFace, ang) * Math.min(1, rawDt * 6);
    if (e.cd <= 0 && dxz > 4 && dxz < 17 && Math.abs(p.cy - e.y) < 5) {
      e.state = 'wind';
      e.st = 0.6;
      // land on where the hero will be, but never farther than a pounce reaches
      const lead = 0.55;
      let tx = p.x + p.vx * lead - e.x, tz = p.z + p.vz * lead - e.z;
      const l = Math.hypot(tx, tz) || 1;
      const reach = Math.min(l, 16);
      tx = (tx / l) * reach;
      tz = (tz / l) * reach;
      a.tx = e.x + tx;
      a.tz = e.z + tz;
      e.lockAng = Math.atan2(tx, tz);
      g.audio.sfx('warn');
    }
    touch(e.radius + 0.6);
  } else if (e.state === 'wind') {
    e.st -= dt;
    e.yawFace += angleDiff(e.yawFace, e.lockAng) * Math.min(1, rawDt * 12);
    if (e.tele && e.teleMat) {
      const len = Math.hypot(a.tx - e.x, a.tz - e.z);
      e.tele.visible = true;
      e.tele.position.y = 0.15;
      e.tele.rotation.y = e.lockAng - e.yawFace;
      e.tele.scale.set(1.3, 1, len / Math.max(e.group.scale.x, 0.01));
      e.teleMat.opacity = 0.25 + 0.45 * (1 - e.st / 0.6);
    }
    if (e.st <= 0) {
      if (e.tele) e.tele.visible = false;
      e.state = 'leap';
      a.x0 = e.x;
      a.z0 = e.z;
      a.y0 = e.y;
      a.t = 0;
      a.T = 0.42 + Math.hypot(a.tx - e.x, a.tz - e.z) * 0.018;
      e.airborne = true;
      g.audio.sfx('dash', 0.7);
    }
  } else if (e.state === 'leap') {
    a.t += dt;
    const k = Math.min(1, a.t / a.T);
    e.x = a.x0 + (a.tx - a.x0) * k;
    e.z = a.z0 + (a.tz - a.z0) * k;
    const land = g.world.terrain.heightAt(e.x, e.z) + e.foot;
    e.y = a.y0 + (land - a.y0) * k + Math.sin(k * Math.PI) * (2.4 + a.T * 2);
    e.yawFace = e.lockAng;
    if (k >= 1) {
      e.airborne = false;
      e.y = land;
      g.particles.ring(_v.set(e.x, land - e.foot + 0.3, e.z), new THREE.Color(0x7af0ff).multiplyScalar(2.2), 18, 7, 0.35, 0.4);
      g.world.props.debris.burst('shard', e.x, land - e.foot + 0.4, e.z, 5, 6, new THREE.Color(0x9a8aff), 0.7);
      const d = Math.hypot(p.x - e.x, p.z - e.z);
      if (d < 2.6 && Math.abs(p.y - (land - e.foot)) < 2.2 && g.hurtPlayer(Math.round(e.dmg * 1.3), e.x, e.z)) g.shake(0.35);
      g.audio.sfx('hit', 0.5);
      e.state = 'recover';
      e.st = 0.8;
    }
  } else if (e.state === 'recover' || e.state === 'stun') {
    e.st -= dt;
    if (e.st <= 0) {
      e.state = 'chase';
      e.cd = 1.6 + Math.random() * 1.2;
    }
  }
  void gh;
}

/** Bloater: drift toward the hero; within reach it swells for a second, then bursts. */
export function bloaterStep(e: Enemy, g: Game, dt: number, gh: number, dxz: number, d3: number, toP: number) {
  const p = g.player;
  const targetY = clamp(p.cy + 0.8, gh + 1.6, gh + 10) + Math.sin(g.time * 1.3 + e.id) * 0.3;
  e.y += clamp(targetY - e.y, -2.2 * dt, 2.2 * dt);
  if (e.state === 'chase') {
    const sp = e.speed * (dxz > 12 ? 1.2 : 1);
    const wob = Math.sin(g.time * 0.9 + e.id * 2.1) * 0.6;
    e.x += Math.sin(toP + wob) * sp * dt;
    e.z += Math.cos(toP + wob) * sp * dt;
    if (d3 < 4.4) {
      e.state = 'wind';
      e.st = 1.1;
      g.audio.sfx('warn');
    }
  } else if (e.state === 'wind') {
    e.st -= dt;
    // still drifting in, slower, while it swells
    e.x += Math.sin(toP) * e.speed * 0.4 * dt;
    e.z += Math.cos(toP) * e.speed * 0.4 * dt;
    if (Math.random() < 0.5) g.particles.emit(e.x + (Math.random() - 0.5) * 1.6, e.y + (Math.random() - 0.5) * 1.4, e.z + (Math.random() - 0.5) * 1.6, 0, 0.6, 0, SPORE.clone().multiplyScalar(1.6), 0.25, 0.5, 0);
    if (e.st <= 0) {
      e.aux.self = 1;
      g.combat.killEnemy(e);
    }
  }
}

/** The spore burst, on any Bloater death: hurts the hero inside it, and tears through the Null around it. */
export function bloaterBurst(e: Enemy, g: Game) {
  const R = 5 * e.scale;
  const p = g.player;
  const c = _v.set(e.x, e.y, e.z);
  g.particles.burst(c, SPORE.clone().multiplyScalar(2.6), 46, 10, 0.7, 1.0, 0.1);
  g.particles.ring(c, SPORE.clone().multiplyScalar(2), 36, R * 2.2, 0.55, 0.6);
  g.particles.burst(c, new THREE.Color(0xff8ad8).multiplyScalar(2), 16, 6, 0.5, 1.2, 0.3);
  g.audio.sfx('kill', 0.5);
  g.shake(0.35);
  const dp = Math.hypot(p.x - e.x, p.cy - e.y, p.z - e.z);
  if (dp < R) g.hurtPlayer(Math.round(e.dmg * (1 - (dp / R) * 0.6)), e.x, e.z);
  for (const o of g.enemies) {
    if (o === e || o.dead || o.kind === 'boss' || o.kind === 'pylon') continue;
    const d = Math.hypot(o.x - e.x, o.y - e.y, o.z - e.z);
    if (d < R + o.radius) g.combat.damageEnemy(o, 55 * (1 - (d / (R + o.radius)) * 0.5), o.x - e.x, o.z - e.z, { knock: 9, crit: true });
  }
}

/**
 * Fractal Prism: hold 15-20 m off, sheltering behind its allies; refract its shield onto the two nearest and
 * throw a fan of slow bolts every few seconds.
 */
export function prismStep(e: Enemy, g: Game, dt: number, rawDt: number, gh: number, dxz: number, toP: number) {
  const p = g.player;
  e.cd -= dt;
  const hoverY = clamp(Math.max(gh + 4.2 + Math.sin(g.time * 0.8 + e.id) * 0.6, p.cy + 2), gh + 2.5, gh + 14);
  e.y += clamp(hoverY - e.y, -3 * dt, 3 * dt);
  // pick the two nearest allies (not other prisms) to shelter
  const near: Enemy[] = [];
  for (const o of g.enemies) {
    if (o === e || o.dead || o.kind === 'prism' || o.kind === 'boss' || o.kind === 'pylon' || o.spawnT < 1) continue;
    const d = (o.x - e.x) ** 2 + (o.z - e.z) ** 2;
    if (d > 18 * 18) continue;
    near.push(o);
    o.aux.d = d;
  }
  near.sort((a, b) => a.aux.d - b.aux.d);
  e.linked = near.slice(0, 2);
  for (const o of e.linked) o.shieldT = 0.25;
  // move: behind the first ally, else orbit at range
  let tx: number, tz: number;
  const anchor = e.linked[0];
  if (anchor) {
    const ax = anchor.x - p.x, az = anchor.z - p.z;
    const l = Math.hypot(ax, az) || 1;
    tx = anchor.x + (ax / l) * 6;
    tz = anchor.z + (az / l) * 6;
  } else {
    e.slotAng += 0.3 * dt * e.strafe;
    tx = p.x + Math.sin(e.slotAng) * 18;
    tz = p.z + Math.cos(e.slotAng) * 18;
  }
  if (dxz < 12) {
    tx = e.x - Math.sin(toP) * 6;
    tz = e.z - Math.cos(toP) * 6;
  }
  const hx = tx - e.x, hz = tz - e.z;
  const hd = Math.hypot(hx, hz) || 1;
  const sp = Math.min(e.speed, hd * 1.2);
  e.x += (hx / hd) * sp * dt;
  e.z += (hz / hd) * sp * dt;
  if (e.state === 'chase' && e.cd <= 0 && dxz < 34) {
    e.state = 'wind';
    e.st = 0.7;
    g.audio.sfx('warn');
  } else if (e.state === 'wind') {
    e.st -= dt;
    if (e.st <= 0) {
      const n = g.diff > 1.2 ? 7 : 5;
      for (let i = 0; i < n; i++) {
        const ang = toP + (i / (n - 1) - 0.5) * 1.1;
        const d = Math.min(dxz, 30);
        g.projectiles.fireEnemy(e.x, e.y, e.z, e.x + Math.sin(ang) * d, p.cy, e.z + Math.cos(ang) * d, 15 + g.diff * 1.5, e.dmg, 4);
      }
      g.audio.sfx('spit', 1.3);
      e.state = 'chase';
      e.cd = 3 + Math.random() * 0.8;
    }
  } else if (e.state === 'stun') {
    e.st -= dt;
    if (e.st <= 0) e.state = 'chase';
  }
  void rawDt;
}

/** Point the Prism's refraction links at its sheltered allies. */
export function updatePrismLinks(e: Enemy) {
  const s = Math.max(e.group.scale.x, 0.01);
  e.links.forEach((l, i) => {
    const o = e.linked[i];
    if (!o || o.dead || e.dead) {
      l.visible = false;
      return;
    }
    const dx = o.x - e.x, dy = o.y - e.y, dz = o.z - e.z;
    const len = Math.hypot(dx, dy, dz);
    l.visible = true;
    l.position.set(0, 0, 0);
    l.rotation.set(-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0, 'YXZ');
    l.scale.set(1, 1, len / s);
  });
}

/**
 * Root Lasher: rise near the hero, lash a travelling line of root spikes along the ground twice, then sink and
 * tunnel to a new spot. Untouchable underground.
 */
export function lasherStep(e: Enemy, g: Game, dt: number, gh: number, dxz: number, toP: number, touch: (r?: number) => void) {
  const p = g.player;
  const a = e.aux;
  e.cd -= dt;
  // shielded only while it tunnels and rises (set below), so it wears off once the bloom is up
  e.invuln = Math.max(0, e.invuln - dt);
  if (e.state === 'under') {
    e.invuln = 0.2;
    // tunnel to a spot 7-11 m from the hero
    const want = 9;
    const tx = p.x - Math.sin(toP + a.side) * want, tz = p.z - Math.cos(toP + a.side) * want;
    const hx = tx - e.x, hz = tz - e.z;
    const hd = Math.hypot(hx, hz) || 1;
    const sp = Math.min(11, hd * 2);
    e.x += (hx / hd) * sp * dt;
    e.z += (hz / hd) * sp * dt;
    if (Math.random() < 0.6) g.particles.emit(e.x + (Math.random() - 0.5), gh + 0.2, e.z + (Math.random() - 0.5), (Math.random() - 0.5) * 2, 2.5, (Math.random() - 0.5) * 2, SOIL, 0.3, 0.5, 6);
    e.st -= dt;
    // a hero who keeps moving never lets it settle on the spot: after a while it bursts up wherever it has got to
    if (e.st <= 0 && (hd < 2 || e.st < -2.5)) {
      e.state = 'rise';
      e.st = 0.9;
      g.audio.sfx('warn');
    }
  } else if (e.state === 'rise') {
    e.invuln = 0.2;
    e.st -= dt;
    a.emerge = 1 - Math.max(0, e.st) / 0.9;
    if (Math.random() < 0.8) {
      const r = 1.6 * Math.random();
      const ang = Math.random() * TAU;
      g.particles.emit(e.x + Math.cos(ang) * r, gh + 0.2, e.z + Math.sin(ang) * r, Math.cos(ang) * 2, 3, Math.sin(ang) * 2, SOIL, 0.35, 0.6, 7);
    }
    if (e.st <= 0) {
      a.emerge = 1;
      g.world.props.debris.burst('rubble', e.x, gh + 0.4, e.z, 8, 6, SOIL, 0.9);
      e.state = 'chase';
      e.cd = 0.7;
      a.lashes = 0;
    }
  } else if (e.state === 'sink') {
    e.st -= dt;
    a.emerge = Math.max(0, e.st) / 0.7;
    if (e.st <= 0) {
      e.state = 'under';
      e.st = 1.4 + Math.random();
      a.side = (Math.random() - 0.5) * 2.4;
    }
  } else if (e.state === 'chase') {
    e.yawFace += angleDiff(e.yawFace, toP) * Math.min(1, dt * 3);
    if (dxz > 26 || (a.lashes >= 2 && e.cd <= 0)) {
      e.state = 'sink';
      e.st = 0.7;
      g.audio.sfx('dash', 0.5);
    } else if (e.cd <= 0) {
      e.state = 'wind';
      e.st = 0.85;
      e.lockAng = toP;
      g.audio.sfx('warn');
    }
    touch(e.radius + 0.8);
  } else if (e.state === 'wind') {
    e.st -= dt;
    e.lockAng += angleDiff(e.lockAng, toP) * Math.min(1, dt * 1.5);
    e.yawFace = e.lockAng;
    if (e.tele && e.teleMat) {
      e.tele.visible = true;
      e.tele.position.y = 0.1;
      e.tele.rotation.y = 0;
      e.tele.scale.set(1.8, 1, 16 / Math.max(e.group.scale.x, 0.01));
      e.teleMat.opacity = 0.2 + 0.45 * (1 - e.st / 0.85);
    }
    if (e.st <= 0) {
      if (e.tele) e.tele.visible = false;
      e.state = 'lash';
      a.lashD = 1.2;
      a.hit = 0;
      g.audio.sfx('spit', 0.6);
    }
  } else if (e.state === 'lash') {
    // the spike line runs out along the ground at 24 m/s
    const prev = a.lashD;
    a.lashD = Math.min(16, a.lashD + 24 * dt);
    for (let d = prev; d < a.lashD; d += 0.8) {
      const x = e.x + Math.sin(e.lockAng) * d, z = e.z + Math.cos(e.lockAng) * d;
      const y = g.world.terrain.heightAt(x, z);
      g.particles.emit(x, y + 0.2, z, 0, 7 + Math.random() * 3, 0, EMBER.clone().multiplyScalar(2), 0.35, 0.35, 14);
      g.particles.emit(x, y + 0.1, z, (Math.random() - 0.5) * 3, 4, (Math.random() - 0.5) * 3, SOIL, 0.4, 0.5, 9);
      if (!a.hit && Math.hypot(p.x - x, p.z - z) < 1.5 && p.y - y < 1.8) {
        a.hit = 1;
        if (g.hurtPlayer(Math.round(e.dmg * 1.2), x - Math.sin(e.lockAng), z - Math.cos(e.lockAng))) {
          p.vy = Math.max(p.vy, 7);
          g.shake(0.4);
        }
      }
    }
    if (a.lashD >= 16) {
      e.state = 'recover';
      e.st = 0.7;
      a.lashes++;
    }
  } else if (e.state === 'recover' || e.state === 'stun') {
    e.st -= dt;
    if (e.st <= 0) {
      e.state = 'chase';
      e.cd = 1.1 + Math.random() * 0.8;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------------------------

/** Tripod gait for the Stalker's six legs; a crouch before the pounce, legs tucked in the air. */
export function animateStalker(e: Enemy, g: Game, dt: number) {
  const B = e.rig!;
  const moving = !e.idle && e.state === 'chase' && e.rootT <= 0;
  e.phaseAnim += dt * (moving ? 11 : e.idle ? 2 : 0);
  const k = 1 - Math.exp(-dt * 14);
  const crouch = e.state === 'wind' ? 1 - e.st / 0.6 : e.state === 'recover' ? Math.max(0, e.st / 0.8) * 0.6 : 0;
  const air = e.state === 'leap' ? 1 : 0;
  const body = B[SB.body];
  body.position.y += (0.95 - crouch * 0.32 + air * 0.1 - body.position.y) * k;
  body.rotation.x += ((e.state === 'leap' ? -0.25 : e.state === 'wind' ? 0.12 : 0) - body.rotation.x) * k;
  body.rotation.z = Math.sin(e.phaseAnim * 2) * 0.03 * (moving ? 1 : 0);
  for (let leg = 0; leg < 6; leg++) {
    const side = leg % 2 ? 1 : -1;
    const tripod = leg === 0 || leg === 3 || leg === 4 ? 0 : Math.PI;
    const ph = e.phaseAnim + tripod;
    const swing = moving ? Math.sin(ph) * 0.38 : e.idle ? Math.sin(ph) * 0.05 : 0;
    const lift = moving ? Math.max(0, Math.cos(ph)) * 0.32 : 0;
    const hip = B[SB.hip(leg)], knee = B[SB.knee(leg)];
    const wantY = -side * swing;
    const wantZ = side * (lift + crouch * 0.32 + air * 0.45);
    hip.rotation.y += (wantY - hip.rotation.y) * k;
    hip.rotation.z += (wantZ - hip.rotation.z) * k;
    knee.rotation.z += (side * (air * 0.6 - crouch * 0.1) - knee.rotation.z) * k;
  }
  const head = B[SB.head];
  head.rotation.y = Math.sin(g.time * 3.1 + e.id) * 0.12;
  head.rotation.x += ((e.state === 'wind' ? -0.25 : 0) - head.rotation.x) * k;
}

export function animateBloater(e: Enemy, g: Game, dt: number) {
  e.body.rotation.y += dt * 0.35;
  const swell = e.state === 'wind' ? 1 - e.st / 1.1 : 0;
  const breath = 1 + Math.sin(g.time * 2.2 + e.id) * 0.04;
  const s = breath + swell * 0.4 + (swell > 0.6 ? Math.sin(g.time * 40) * 0.03 : 0);
  e.body.scale.set(s, s * (1 - swell * 0.08), s);
  e.body.rotation.z = Math.sin(g.time * 0.7 + e.id) * 0.12;
}

export function animatePrism(e: Enemy, g: Game, dt: number) {
  const wind = e.state === 'wind';
  e.body.rotation.y += dt * (wind ? 3.5 : 0.6);
  e.body.rotation.x = Math.sin(g.time * 0.5 + e.id) * 0.35;
  for (const s of e.spinners) s.rotateOnAxis(s.userData.axis as THREE.Vector3, dt * (s.userData.rate as number) * (wind ? 3 : 1));
  e.body.position.y = Math.sin(g.time * 1.6 + e.id) * 0.18;
  updatePrismLinks(e);
}

/** Sway in the idle wind, rear back to telegraph, whip forward to lash; the whole bloom sinks to burrow. */
export function animateLasher(e: Enemy, g: Game, dt: number) {
  const B = e.rig!;
  const t = g.time + e.id;
  const k = 1 - Math.exp(-dt * 10);
  const wind = e.state === 'wind' ? 1 - e.st / 0.85 : 0;
  const lash = e.state === 'lash' ? 1 : 0;
  const set = (b: THREE.Object3D, x: number, z: number) => {
    b.rotation.x += (x - b.rotation.x) * k;
    b.rotation.z += (z - b.rotation.z) * k;
  };
  const sway = Math.sin(t * 1.3) * 0.08;
  set(B[LB.s1], -wind * 0.25 + lash * 0.35 + sway * 0.5, Math.sin(t * 0.9) * 0.06);
  set(B[LB.s2], -wind * 0.35 + lash * 0.45 + sway, Math.sin(t * 1.1) * 0.08);
  set(B[LB.s3], -wind * 0.3 + lash * 0.4 + sway * 1.2, Math.sin(t * 1.4) * 0.1);
  set(B[LB.head], -wind * 0.4 + lash * 0.6, 0);
}

/** Ground offset of a Lasher while it rises or sinks (0 when fully up). */
export const lasherDepth = (e: Enemy) => (1 - (e.aux.emerge ?? 1)) * 4;
