import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform, positionGeometry, max, normalize, cross, select, abs, vec3, sin, cos, mix, float, varying } from 'three/tsl';
import { glow, type N } from '../engine/materials';
import type { TetherAnchor } from '../world/traversal';

const SEG = 48;

/**
 * The Mycelial Tether: a living hypha the Wisdomkeeper fires at an anchor (or any solid surface) and reels
 * along. Physically it is a stiff spring-damper with a shrinking rest length, which gives both a pull and a
 * pendulum swing. The beam is a tube whose vertex shader wiggles it until it pulls taut.
 */
export class Tether {
  readonly mesh: THREE.Mesh;
  active = false;
  /** Fixed anchor point (when latched onto a surface) or the live anchor of a moving platform. */
  readonly point = new THREE.Vector3();
  private follow: TetherAnchor | null = null;
  restLen = 0;
  t = 0;
  /** 0 → slack/wiggly, 1 → taut */
  private taut = 0;
  private shoot = 0;
  private u: Record<'uA' | 'uB' | 'uTime' | 'uSlack' | 'uReach' | 'uColor', N>;
  private from = new THREE.Vector3();

  constructor(color: THREE.Color) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, SEG, true).translate(0, 0.5, 0);
    this.u = {
      uA: uniform(new THREE.Vector3()),
      uB: uniform(new THREE.Vector3()),
      uTime: uniform(0),
      uSlack: uniform(1),
      uReach: uniform(0),
      uColor: uniform(color.clone()),
    };
    const u = this.u;
    const g: N = positionGeometry;
    const t = g.y.mul(u.uReach);
    const d = u.uB.sub(u.uA);
    const L = d.length();
    const f = d.div(max(L, 1e-3));
    const s = normalize(cross(f, select(abs(f.y).greaterThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0))));
    const up = cross(s, f);
    const env = sin(t.mul(Math.PI));
    // sag under gravity + travelling wiggle while slack
    const wig = s.mul(sin(t.mul(22).sub(u.uTime.mul(18)))).add(up.mul(cos(t.mul(17).sub(u.uTime.mul(14)))));
    const r = mix(float(0.07), float(0.035), t).mul(sin(t.mul(60).sub(u.uTime.mul(30))).mul(0.4).add(1));
    const p = u.uA.add(d.mul(t)).add(vec3(0, -1, 0).mul(env).mul(L).mul(0.08).mul(u.uSlack))
      .add(wig.mul(env).mul(0.35).mul(u.uSlack))
      .add(s.mul(g.x).add(up.mul(g.z)).mul(r));
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // the tube is built in world space; the mesh itself stays at the origin with an identity transform
    mat.positionNode = p;
    const pulse = sin((varying(t) as N).mul(40).sub(u.uTime.mul(26))).mul(0.45).add(0.55);
    mat.colorNode = u.uColor.mul(pulse.mul(1.6).add(1.2));
    mat.opacityNode = float(0.85);
    glow(mat);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 3;
  }

  attach(from: THREE.Vector3, point: THREE.Vector3, anchor: TetherAnchor | null) {
    this.active = true;
    this.follow = anchor;
    this.point.copy(anchor ? anchor.pos : point);
    this.restLen = Math.max(2.5, from.distanceTo(this.point) * 0.92);
    this.t = 0;
    this.taut = 0;
    this.shoot = 0;
    this.mesh.visible = true;
  }

  release() {
    this.active = false;
    this.follow = null;
  }

  /** Current anchor (tracks moving platforms). */
  get anchor() {
    if (this.follow) this.point.copy(this.follow.pos);
    return this.point;
  }

  update(dt: number, time: number, hand: THREE.Vector3, tension: number) {
    if (this.active) {
      this.t += dt;
      this.shoot = Math.min(1, this.shoot + dt * 7);
      this.taut += (Math.min(1, tension) - this.taut) * Math.min(1, dt * 8);
      this.from.copy(hand);
    } else {
      this.shoot = Math.max(0, this.shoot - dt * 6);
      if (this.shoot <= 0) this.mesh.visible = false;
    }
    this.u.uA.value.copy(this.from);
    this.u.uB.value.copy(this.anchor);
    this.u.uReach.value = this.shoot;
    this.u.uSlack.value = Math.max(0.05, 1 - this.taut);
    this.u.uTime.value = time;
  }

  setColor(c: THREE.Color) {
    (this.u.uColor.value as THREE.Color).copy(c);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
