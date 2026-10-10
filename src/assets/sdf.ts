import * as THREE from 'three';

/**
 * Procedural sculpting kernel: characters are authored as signed-distance primitives attached to bones,
 * blended with smooth unions (organic muscle transitions), polygonised with Naive Surface Nets and skinned
 * automatically from each primitive's bone. The result is one watertight SkinnedMesh per creature —
 * the "procedural SDF fallback" of the asset pipeline when no GLB is available.
 */

export type MatId = 0 | 1 | 2 | 3 | 4;
/** 0 skin / suit, 1 armour plate, 2 bioluminescent node, 3 dark under-layer, 4 blade crystal. */
export const MAT = { skin: 0, armor: 1, glow: 2, dark: 3, blade: 4 } as const;

/**
 * Materials travel as a vec4 of blend weights (armour, glow, dark, blade; skin is the remainder) so that
 * interpolation across a border only mixes the two materials that meet there.
 */
export function matWeights(id: number, out: Float32Array, o: number, armor = 1) {
  out[o] = id === MAT.armor ? armor : 0;
  out[o + 1] = id === MAT.glow ? 1 : 0;
  out[o + 2] = id === MAT.dark ? 1 : 0;
  out[o + 3] = id === MAT.blade ? 1 : 0;
}

export interface Prim {
  bone: number;
  /** Round cone from a (radius ra) to b (radius rb), in the bone's bind space; ellipsoid; or rounded box
   * centred on a with half extents `radii`, corner radius `ra` and rotation `rot`. */
  kind: 'cone' | 'ellipsoid' | 'box';
  a: THREE.Vector3;
  b?: THREE.Vector3;
  ra: number;
  rb?: number;
  /** Ellipsoid radii and rotation (Euler, bone space). */
  radii?: THREE.Vector3;
  rot?: THREE.Euler;
  /** Smooth-union radius with everything before it (0 = hard union). */
  k: number;
  mat: MatId;
  /** Subtractive primitive (carves grooves / definition). */
  sub?: boolean;
}

interface Baked {
  kind: 0 | 1 | 2;
  bone: number;
  k: number;
  mat: number;
  sub: boolean;
  // cone
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  ra: number; rb: number;
  // ellipsoid: inverse rotation (3x3, row-major) + radii
  m: number[];
  rx: number; ry: number; rz: number;
  // conservative world AABB
  min: THREE.Vector3;
  max: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/** Inigo Quilez' round cone. */
function sdRoundCone(px: number, py: number, pz: number, p: Baked) {
  const bax = p.bx - p.ax, bay = p.by - p.ay, baz = p.bz - p.az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = p.ra - p.rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - p.ax, pay = py - p.ay, paz = pz - p.az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - p.rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - p.ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - p.ra;
}

/** Bound-corrected ellipsoid distance (iq). */
function sdEllipsoid(px: number, py: number, pz: number, p: Baked) {
  const dx = px - p.ax, dy = py - p.ay, dz = pz - p.az;
  const m = p.m;
  const lx = m[0] * dx + m[1] * dy + m[2] * dz;
  const ly = m[3] * dx + m[4] * dy + m[5] * dz;
  const lz = m[6] * dx + m[7] * dy + m[8] * dz;
  const k0 = Math.hypot(lx / p.rx, ly / p.ry, lz / p.rz);
  const k1 = Math.hypot(lx / (p.rx * p.rx), ly / (p.ry * p.ry), lz / (p.rz * p.rz));
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(p.rx, p.ry, p.rz);
}

/** Rounded box: half extents rx/ry/rz (already shrunk by the rounding radius ra) in the primitive frame. */
function sdRoundBox(px: number, py: number, pz: number, p: Baked) {
  const dx = px - p.ax, dy = py - p.ay, dz = pz - p.az;
  const m = p.m;
  const qx = Math.abs(m[0] * dx + m[1] * dy + m[2] * dz) - p.rx;
  const qy = Math.abs(m[3] * dx + m[4] * dy + m[5] * dz) - p.ry;
  const qz = Math.abs(m[6] * dx + m[7] * dy + m[8] * dz) - p.rz;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - p.ra;
}

const smin = (a: number, b: number, k: number) => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

export interface SculptResult {
  geometry: THREE.BufferGeometry;
  /** Vertex count (debug). */
  vertices: number;
}

/**
 * Surface detail: displacement (metres, positive carves inward) for a point near the surface, given the
 * material of the nearest primitive. Evaluated only inside a thin band around the zero set.
 */
export type DetailFn = (x: number, y: number, z: number, mat: number) => number;
export interface SculptOptions {
  detail?: DetailFn;
  /** Half-width of the band where detail applies (default 0.06 m). */
  band?: number;
}

const EMPTY: Baked[] = [];

export class Sculpt {
  private prims: Baked[] = [];
  private detail: DetailFn | null;
  private band: number;

  /**
   * Bake primitives into model space. With `bones`, each primitive is given in its bone's bind space;
   * without, primitives are already in model space and `bone` only selects skinning.
   */
  constructor(prims: Prim[], bones?: THREE.Object3D[], opts: SculptOptions = {}) {
    this.detail = opts.detail ?? null;
    this.band = opts.band ?? 0.06;
    const ident = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const pos = new THREE.Vector3();
    for (const p of prims) {
      const mw = bones ? bones[p.bone].matrixWorld : ident;
      mw.decompose(pos, q, s);
      const b: Baked = {
        kind: p.kind === 'cone' ? 0 : p.kind === 'ellipsoid' ? 1 : 2, bone: p.bone, k: p.k, mat: p.mat, sub: !!p.sub,
        ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, ra: p.ra, rb: p.rb ?? p.ra, m: [], rx: 0, ry: 0, rz: 0,
        min: new THREE.Vector3(), max: new THREE.Vector3(),
      };
      _v.copy(p.a).applyMatrix4(mw);
      b.ax = _v.x; b.ay = _v.y; b.az = _v.z;
      const pad = Math.max(p.k, 0.004) + 0.02;
      if (p.kind === 'cone') {
        _w.copy(p.b!).applyMatrix4(mw);
        b.bx = _w.x; b.by = _w.y; b.bz = _w.z;
        const r = Math.max(b.ra, b.rb) + pad;
        b.min.set(Math.min(_v.x, _w.x) - r, Math.min(_v.y, _w.y) - r, Math.min(_v.z, _w.z) - r);
        b.max.set(Math.max(_v.x, _w.x) + r, Math.max(_v.y, _w.y) + r, Math.max(_v.z, _w.z) + r);
      } else {
        const rq = new THREE.Quaternion().setFromEuler(p.rot ?? new THREE.Euler());
        const wq = q.clone().multiply(rq);
        const inv = new THREE.Matrix4().makeRotationFromQuaternion(wq).invert().elements;
        // Matrix4 is column-major; row-major 3x3 of the inverse rotation
        b.m = [inv[0], inv[4], inv[8], inv[1], inv[5], inv[9], inv[2], inv[6], inv[10]];
        b.rx = p.radii!.x; b.ry = p.radii!.y; b.rz = p.radii!.z;
        if (p.kind === 'box') {
          b.rx -= p.ra; b.ry -= p.ra; b.rz -= p.ra;
        }
        const r = (p.kind === 'box' ? Math.hypot(p.radii!.x, p.radii!.y, p.radii!.z) : Math.max(b.rx, b.ry, b.rz)) + pad;
        b.min.set(_v.x - r, _v.y - r, _v.z - r);
        b.max.set(_v.x + r, _v.y + r, _v.z + r);
      }
      this.prims.push(b);
    }
  }

  private dist(p: Baked, x: number, y: number, z: number) {
    return p.kind === 0 ? sdRoundCone(x, y, z, p) : p.kind === 1 ? sdEllipsoid(x, y, z, p) : sdRoundBox(x, y, z, p);
  }

  /** Field value at a point; skips primitives whose padded bounds miss it. */
  /** Coarse bucket grid over the primitives' bounds so dense sculpts only test the primitives nearby. */
  private grid: { lo: THREE.Vector3; cs: number; nx: number; ny: number; nz: number; cells: Baked[][] } | null = null;

  private buildGrid() {
    if (this.prims.length < 24) return;
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of this.prims) {
      lo.min(p.min);
      hi.max(p.max);
    }
    const ext = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);
    const cs = Math.max(ext / 24, 0.05);
    const nx = Math.ceil((hi.x - lo.x) / cs) + 1, ny = Math.ceil((hi.y - lo.y) / cs) + 1, nz = Math.ceil((hi.z - lo.z) / cs) + 1;
    const cells: Baked[][] = Array.from({ length: nx * ny * nz }, () => []);
    for (const p of this.prims) {
      const i0 = Math.floor((p.min.x - lo.x) / cs), i1 = Math.floor((p.max.x - lo.x) / cs);
      const j0 = Math.floor((p.min.y - lo.y) / cs), j1 = Math.floor((p.max.y - lo.y) / cs);
      const k0 = Math.floor((p.min.z - lo.z) / cs), k1 = Math.floor((p.max.z - lo.z) / cs);
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[i + nx * (j + ny * k)].push(p);
    }
    // order matters for smooth unions and carving: keep each cell in authoring order
    const order = new Map(this.prims.map((p, i) => [p, i]));
    for (const c of cells) c.sort((a, b) => order.get(a)! - order.get(b)!);
    this.grid = { lo, cs, nx, ny, nz, cells };
  }

  private near(x: number, y: number, z: number): Baked[] {
    const g = this.grid;
    if (!g) return this.prims;
    const i = Math.floor((x - g.lo.x) / g.cs), j = Math.floor((y - g.lo.y) / g.cs), k = Math.floor((z - g.lo.z) / g.cs);
    if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return EMPTY;
    return g.cells[i + g.nx * (j + g.ny * k)];
  }

  sample(x: number, y: number, z: number): number {
    let d = 1e9;
    let near = 1e9;
    let mat = 0;
    for (const p of this.near(x, y, z)) {
      if (x < p.min.x || y < p.min.y || z < p.min.z || x > p.max.x || y > p.max.y || z > p.max.z) continue;
      const e = this.dist(p, x, y, z);
      d = p.sub ? smax(d, -e, p.k) : smin(d, e, p.k);
      if (!p.sub && e < near) {
        near = e;
        mat = p.mat;
      }
    }
    if (this.detail && d < this.band && d > -this.band) d += this.detail(x, y, z, mat);
    return d;
  }

  /**
   * Polygonise with Naive Surface Nets on a `cell`-sized grid, then compute per-vertex SDF-gradient normals,
   * material ids (nearest primitive) and four-bone skin weights (inverse-distance to each bone's primitives).
   */
  mesh(cell: number): SculptResult {
    if (!this.grid) this.buildGrid();
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of this.prims) {
      if (p.sub) continue;
      lo.min(p.min);
      hi.max(p.max);
    }
    const nx = Math.ceil((hi.x - lo.x) / cell) + 2;
    const ny = Math.ceil((hi.y - lo.y) / cell) + 2;
    const nz = Math.ceil((hi.z - lo.z) / cell) + 2;
    const F = new Float32Array(nx * ny * nz);
    const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
    // sample in 4³ bricks; a brick whose centre is far from the surface (field is ~1-Lipschitz) is filled
    // with that value, which keeps every sign right and skips ~85% of the evaluations
    const BR = 4;
    const skip = cell * (BR * 0.5 * Math.sqrt(3) + 1.5);
    for (let bk = 0; bk < nz; bk += BR) {
      for (let bj = 0; bj < ny; bj += BR) {
        for (let bi = 0; bi < nx; bi += BR) {
          const c = this.sample(lo.x + (bi + BR / 2 - 1.5) * cell, lo.y + (bj + BR / 2 - 1.5) * cell, lo.z + (bk + BR / 2 - 1.5) * cell);
          const far = Math.abs(c) > skip;
          for (let k = bk; k < Math.min(nz, bk + BR); k++) {
            const z = lo.z + (k - 1) * cell;
            for (let j = bj; j < Math.min(ny, bj + BR); j++) {
              const y = lo.y + (j - 1) * cell;
              for (let i = bi; i < Math.min(nx, bi + BR); i++) F[idx(i, j, k)] = far ? c : this.sample(lo.x + (i - 1) * cell, y, z);
            }
          }
        }
      }
    }
    // one vertex per sign-changing cell, at the mean of its edge crossings
    const vid = new Int32Array(nx * ny * nz).fill(-1);
    const P: number[] = [];
    const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const cv = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) {
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            const [a, b, d] = corners[c];
            cv[c] = F[idx(i + a, j + b, k + d)];
            if (cv[c] < 0) mask |= 1 << c;
          }
          if (mask === 0 || mask === 255) continue;
          let sx = 0, sy = 0, sz = 0, n = 0;
          for (const [e0, e1] of edges) {
            const v0 = cv[e0], v1 = cv[e1];
            if (v0 < 0 === v1 < 0) continue;
            const t = v0 / (v0 - v1);
            const c0 = corners[e0], c1 = corners[e1];
            sx += c0[0] + (c1[0] - c0[0]) * t;
            sy += c0[1] + (c1[1] - c0[1]) * t;
            sz += c0[2] + (c1[2] - c0[2]) * t;
            n++;
          }
          vid[idx(i, j, k)] = P.length / 3;
          P.push(lo.x + (i - 1 + sx / n) * cell, lo.y + (j - 1 + sy / n) * cell, lo.z + (k - 1 + sz / n) * cell);
        }
      }
    }
    // quads across every sign-changing grid edge
    const I: number[] = [];
    const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) I.push(a, b, c, a, c, d);
      else I.push(a, c, b, a, d, c);
    };
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const f0 = F[idx(i, j, k)] < 0;
          if (f0 !== F[idx(i + 1, j, k)] < 0) quad(vid[idx(i, j - 1, k - 1)], vid[idx(i, j, k - 1)], vid[idx(i, j, k)], vid[idx(i, j - 1, k)], f0);
          if (f0 !== F[idx(i, j + 1, k)] < 0) quad(vid[idx(i - 1, j, k - 1)], vid[idx(i - 1, j, k)], vid[idx(i, j, k)], vid[idx(i, j, k - 1)], f0);
          if (f0 !== F[idx(i, j, k + 1)] < 0) quad(vid[idx(i - 1, j - 1, k)], vid[idx(i, j - 1, k)], vid[idx(i, j, k)], vid[idx(i - 1, j, k)], f0);
        }
      }
    }
    const nv = P.length / 3;
    const pos = new Float32Array(P);
    const nor = new Float32Array(nv * 3);
    const mat = new Float32Array(nv * 4);
    const ao = new Float32Array(nv);
    const si = new Uint16Array(nv * 4);
    const sw = new Float32Array(nv * 4);
    const e = cell * 0.5;
    const boneW = new Map<number, number>();
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      // one Newton step onto the true surface sharpens the net
      let d = this.sample(x, y, z);
      let gx = this.sample(x + e, y, z) - this.sample(x - e, y, z);
      let gy = this.sample(x, y + e, z) - this.sample(x, y - e, z);
      let gz = this.sample(x, y, z + e) - this.sample(x, y, z - e);
      let gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      const px = x - gx * d, py = y - gy * d, pz = z - gz * d;
      pos[v * 3] = px; pos[v * 3 + 1] = py; pos[v * 3 + 2] = pz;
      d = 0;
      gx = this.sample(px + e, py, pz) - this.sample(px - e, py, pz);
      gy = this.sample(px, py + e, pz) - this.sample(px, py - e, pz);
      gz = this.sample(px, py, pz + e) - this.sample(px, py, pz - e);
      gl = Math.hypot(gx, gy, gz) || 1;
      nor[v * 3] = gx / gl; nor[v * 3 + 1] = gy / gl; nor[v * 3 + 2] = gz / gl;
      // ambient occlusion straight from the field: how much closer than expected the surface is along the normal
      let occ = 0;
      for (let s = 1, w = 0.5; s <= 5; s++, w *= 0.6) {
        const h = s * Math.max(cell * 1.5, 0.018);
        occ += w * (h - this.sample(px + (nor[v * 3] * h), py + nor[v * 3 + 1] * h, pz + nor[v * 3 + 2] * h)) / h;
      }
      ao[v] = Math.min(1, Math.max(0.15, 1 - occ * 0.9));
      // material: nearest additive primitive; skin and armour (ids 0/1) blend softly across their border
      let best = 1e9;
      let bm = 0;
      let dS = 1e9;
      let dA = 1e9;
      boneW.clear();
      for (const p of this.near(px, py, pz)) {
        if (p.sub) continue;
        if (px < p.min.x - 0.08 || py < p.min.y - 0.08 || pz < p.min.z - 0.08 || px > p.max.x + 0.08 || py > p.max.y + 0.08 || pz > p.max.z + 0.08) continue;
        const di = this.dist(p, px, py, pz);
        if (p.mat === MAT.skin) dS = Math.min(dS, di);
        else if (p.mat === MAT.armor) dA = Math.min(dA, di);
        // detail materials sit on top of the skin; give them priority within a hair
        const bias = p.mat === MAT.skin || p.mat === MAT.armor ? 0.0015 : 0;
        if (di + bias < best) {
          best = di + bias;
          bm = p.mat;
        }
        const w = 1 / Math.pow(Math.max(di, 0) + 0.012, 4);
        boneW.set(p.bone, (boneW.get(p.bone) ?? 0) + w);
      }
      if (bm === MAT.skin || bm === MAT.armor) {
        const t = Math.min(1, Math.max(0, (dS - dA + 0.014) / 0.028));
        matWeights(MAT.armor, mat, v * 4, t * t * (3 - 2 * t));
      } else matWeights(bm, mat, v * 4);
      const top = [...boneW.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, t) => s + t[1], 0) || 1;
      for (let k = 0; k < 4; k++) {
        si[v * 4 + k] = top[k]?.[0] ?? 0;
        sw[v * 4 + k] = top[k] ? top[k][1] / sum : 0;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
    g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    g.setIndex(I);
    g.computeBoundingSphere();
    return { geometry: g, vertices: nv };
  }
}

/** Append a tube (e.g. a tendril or antler tine) rigidly skinned along a bone chain. */
export function skinnedTube(
  points: THREE.Vector3[],
  radius: (t: number) => number,
  bones: number[],
  mat: MatId,
  radial = 6,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const seg = Math.max(4, points.length * 4);
  const g = new THREE.TubeGeometry(curve, seg, 1, radial, false);
  // TubeGeometry has constant radius; rescale ring by ring around the curve
  const pos = g.attributes.position as THREE.BufferAttribute;
  const ring = radial + 1;
  const c = new THREE.Vector3();
  for (let s = 0; s <= seg; s++) {
    const t = s / seg;
    curve.getPointAt(t, c);
    const r = radius(t);
    for (let k = 0; k < ring; k++) {
      const i = s * ring + k;
      _v.fromBufferAttribute(pos, i).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(i, _v.x, _v.y, _v.z);
    }
  }
  g.computeVertexNormals();
  const n = pos.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const m = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) matWeights(mat, m, i * 4);
  // bone k pivots at t = k/n and owns the segment after it; blend into the parent just past each pivot
  const nb = bones.length;
  for (let s = 0; s <= seg; s++) {
    const f = Math.min((s / seg) * nb, nb - 1e-6);
    const b = Math.floor(f);
    const w = b > 0 ? 0.5 + 0.5 * Math.min(1, (f - b) / 0.3) : 1;
    for (let k = 0; k < ring; k++) {
      const i = s * ring + k;
      si[i * 4] = bones[b];
      sw[i * 4] = w;
      si[i * 4 + 1] = bones[Math.max(0, b - 1)];
      sw[i * 4 + 1] = 1 - w;
    }
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setAttribute('aMat', new THREE.BufferAttribute(m, 4));
  g.setAttribute('aAO', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  g.deleteAttribute('uv');
  return g;
}
