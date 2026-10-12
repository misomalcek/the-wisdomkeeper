/**
 * Growable mesh buffers for the generated geometry (trees, rocks, fractal formations). Pure typed arrays, so they
 * build in a worker and transfer back without copies.
 *
 * Every vertex carries `aux` (vec4) for the shaders: x = kind (0 bark/stone, 1 leaf/glow), y = a per-element random
 * (hue pick), z = height in the object 0..1 (wind sway, tone), w = depth/trap (branch order or fractal orbit trap).
 */
export interface MeshArrays {
  pos: Float32Array;
  nor: Float32Array;
  aux: Float32Array;
  idx: Uint32Array;
  /** Bounding radius about the origin (xz) and height. */
  radius: number;
  height: number;
}

export class MeshBuilder {
  private p: number[] = [];
  private n: number[] = [];
  private a: number[] = [];
  private i: number[] = [];
  get vertexCount() {
    return this.p.length / 3;
  }
  get triangleCount() {
    return this.i.length / 3;
  }
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, a0: number, a1: number, a2: number, a3: number) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.a.push(a0, a1, a2, a3);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.i.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.i.push(a, b, c, a, c, d);
  }
  /** Finish: normalises aux.z to the object's height and computes bounds. */
  build(normaliseHeight = true): MeshArrays {
    const pos = new Float32Array(this.p);
    const aux = new Float32Array(this.a);
    let r = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < pos.length; k += 3) {
      r = Math.max(r, Math.hypot(pos[k], pos[k + 2]));
      lo = Math.min(lo, pos[k + 1]);
      hi = Math.max(hi, pos[k + 1]);
    }
    if (normaliseHeight && hi > lo) for (let k = 0; k < aux.length; k += 4) aux[k + 2] = Math.max(0, pos[(k / 4) * 3 + 1]) / hi;
    return { pos, nor: new Float32Array(this.n), aux, idx: new Uint32Array(this.i), radius: r, height: Math.max(0, hi) };
  }
}

export const meshTransfer = (m: MeshArrays): ArrayBuffer[] => [m.pos.buffer, m.nor.buffer, m.aux.buffer, m.idx.buffer] as ArrayBuffer[];

// --------------------------------------------------------------------------------------------- small vector kit
export type V3 = [number, number, number];
export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Any unit vector perpendicular to t. */
export const perp = (t: V3): V3 => norm(Math.abs(t[1]) < 0.9 ? cross(t, [0, 1, 0]) : cross(t, [1, 0, 0]));
/** Rotate v about unit axis k by angle a (Rodrigues). */
export function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const d = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}
