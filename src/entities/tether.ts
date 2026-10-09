import * as THREE from 'three';
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
  private u: Record<string, THREE.IUniform>;
  private from = new THREE.Vector3();

  constructor(color: THREE.Color) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, SEG, true).translate(0, 0.5, 0);
    this.u = {
      uA: { value: new THREE.Vector3() },
      uB: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSlack: { value: 1 },
      uReach: { value: 0 },
      uColor: { value: color.clone() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform vec3 uA, uB; uniform float uTime, uSlack, uReach;
        varying float vT; varying float vEdge;
        void main(){
          float t = position.y * uReach;
          vec3 d = uB - uA;
          float L = length(d);
          vec3 f = d / max(L, 1e-3);
          vec3 s = normalize(cross(f, abs(f.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
          vec3 u = cross(s, f);
          float env = sin(3.14159 * t);
          // sag under gravity + travelling wiggle while slack
          vec3 p = uA + d * t + vec3(0.0, -1.0, 0.0) * env * L * 0.08 * uSlack;
          p += (s * sin(t * 22.0 - uTime * 18.0) + u * cos(t * 17.0 - uTime * 14.0)) * env * 0.35 * uSlack;
          float r = mix(0.07, 0.035, t) * (1.0 + 0.4 * sin(t * 60.0 - uTime * 30.0));
          p += (s * position.x + u * position.z) * r;
          vT = t; vEdge = abs(position.x);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uTime;
        varying float vT; varying float vEdge;
        void main(){
          float pulse = 0.55 + 0.45 * sin(vT * 40.0 - uTime * 26.0);
          gl_FragColor = vec4(uColor * (1.2 + pulse * 1.6), 0.85);
        }`,
    });
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
