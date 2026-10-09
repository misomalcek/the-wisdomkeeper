import * as THREE from 'three';
import { clamp, damp } from '../util/math';

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Over-the-shoulder third-person camera. yaw: forward = (sin yaw, ., cos yaw);
 * pitch > 0 looks down. Ducks above terrain so it never clips into hills.
 */
export class ThirdPersonCam {
  yaw = Math.PI;
  pitch = 0.22;
  sens = 0.0022;
  dist = 6.2;
  shoulder = 0.85;
  readonly pos = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private shake = 0;
  private fov = 62;
  private curDist = 6.2;
  private curShoulder = 0.85;
  /** Transition hooks: scale distance / add FOV, and optionally look at another point. */
  zoom = 1;
  zoomTarget = 1;
  zoomRate = 3;
  fovBoost = 0;
  fovTarget = 0;
  override: THREE.Vector3 | null = null;
  private calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  terrainH: (x: number, z: number) => number = () => 0;

  constructor(private camera: THREE.PerspectiveCamera) {}

  addShake(a: number) {
    this.shake = Math.min(this.shake + a * (this.calm ? 0.25 : 1), 1.6);
  }

  look(dx: number, dy: number) {
    this.yaw -= dx * this.sens;
    this.pitch = clamp(this.pitch + dy * this.sens, -0.55, 1.2);
  }

  /** Direction the camera looks (unit). */
  forward3D(out: THREE.Vector3) {
    const c = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * c, -Math.sin(this.pitch), Math.cos(this.yaw) * c);
  }
  forwardXZ(out: THREE.Vector2) {
    return out.set(Math.sin(this.yaw), Math.cos(this.yaw));
  }

  snap(target: THREE.Vector3) {
    this.pivot.copy(target);
    this.curDist = this.dist * this.zoom;
    this.place(0);
  }

  private place(dt: number) {
    this.forward3D(_f);
    _r.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const d = this.curDist;
    _p.copy(this.pivot).addScaledVector(_f, -d).addScaledVector(_r, this.curShoulder * (d / this.dist > 0.5 ? 1 : 0));
    // keep the lens above the ground and pull the camera in if terrain blocks the line of sight
    let t = 1;
    for (let i = 1; i <= 6; i++) {
      const k = i / 6;
      const x = this.pivot.x + (_p.x - this.pivot.x) * k;
      const z = this.pivot.z + (_p.z - this.pivot.z) * k;
      const y = this.pivot.y + (_p.y - this.pivot.y) * k;
      if (y < this.terrainH(x, z) + 0.45) {
        t = Math.min(t, (i - 1) / 6);
        break;
      }
    }
    if (t < 1) _p.lerpVectors(this.pivot, _p, Math.max(t, 0.5));
    _p.y = Math.max(_p.y, this.terrainH(_p.x, _p.z) + 0.7);
    this.pos.copy(_p);
    const s = this.shake * this.shake;
    this.camera.position.set(_p.x + (Math.random() - 0.5) * s, _p.y + (Math.random() - 0.5) * s, _p.z + (Math.random() - 0.5) * s);
    this.camera.lookAt(this.camera.position.x + _f.x * 12, this.camera.position.y + _f.y * 12, this.camera.position.z + _f.z * 12);
    void dt;
  }

  update(dt: number, target: THREE.Vector3, opts: { aim: boolean; flight: boolean; sprint: boolean }) {
    this.zoom = damp(this.zoom, this.zoomTarget, this.zoomRate, dt);
    this.fovBoost = damp(this.fovBoost, this.fovTarget, this.zoomRate, dt);
    const tgt = this.override ?? target;
    const k = this.override ? 4 : 22;
    this.pivot.x = damp(this.pivot.x, tgt.x, k, dt);
    this.pivot.y = damp(this.pivot.y, tgt.y, this.override ? 4 : 12, dt);
    this.pivot.z = damp(this.pivot.z, tgt.z, k, dt);
    this.shake = Math.max(0, this.shake - dt * 2.8);
    const wantDist = (opts.aim ? 3.6 : opts.flight ? 8.2 : this.dist) * this.zoom;
    this.curDist = damp(this.curDist, wantDist, 9, dt);
    this.curShoulder = damp(this.curShoulder, opts.aim ? 1.15 : this.shoulder, 9, dt);
    const wantFov = (opts.aim ? 46 : opts.flight ? 74 : opts.sprint ? 68 : 62) + this.fovBoost;
    this.fov = damp(this.fov, wantFov, 8, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.place(dt);
  }
}
