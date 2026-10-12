/**
 * Trees grown as one continuous mesh each. A recursive branching process builds the skeleton:
 * - each branch is walked in short steps that bend under tropism (toward the light, or drooping) and a little noise;
 * - at its end it forks into children around the parent on the golden angle, with radii from da Vinci's rule
 *   (r^Δ = Σ r_child^Δ, Δ ≈ 2.4, so the cross-section is roughly conserved through every fork);
 * - apical dominance: in excurrent species one child carries on almost straight and the others splay out.
 * The skeleton is swept into tubes (tube.ts) and its terminal twigs carry foliage: leaf cards, rosettes of blades
 * (dragon trees) or nothing (the blight's dead thorns). Several seeded variants per species are instanced.
 */
import { Rng } from '../../../util/rng';
import { MeshBuilder, type MeshArrays, type V3, add, cross, norm, perp, rotate, scale } from './geo';
import { addNode, newSkeleton, sweepSkeleton, type Skeleton } from './tube';

export interface TreeSpecies {
  name: string;
  trunkLen: [number, number];
  trunkR: number;
  /** Fraction of the trunk length left as the first fork's branch length. */
  lenK: number;
  depth: number;
  kids: [number, number];
  /** Fork angle (rad) range from the parent direction. */
  angle: [number, number];
  /** Angle of the dominant (leader) child, or -1 for equal (decurrent) forks. */
  leader: number;
  /** Upward pull per step (negative droops). */
  tropism: number;
  wobble: number;
  /** da Vinci exponent. */
  delta: number;
  /** Metres per skeleton step. */
  step: number;
  foliage: 'leaves' | 'blades' | 'none';
  leafSize: number;
  leafCount: number;
  /** Extra droop applied to branches by depth (weeping). */
  weep: number;
}

/** Broad deliquescent canopy: a short trunk splitting into sinuous limbs and a cloud of fine twigs. */
export const CANOPY: TreeSpecies = {
  name: 'canopy', trunkLen: [3.2, 4.6], trunkR: 0.42, lenK: 0.78, depth: 6, kids: [2, 3], angle: [0.45, 0.85], leader: -1,
  tropism: 0.1, wobble: 0.22, delta: 2.3, step: 0.9, foliage: 'leaves', leafSize: 0.3, leafCount: 9, weep: 0.02,
};
/** Dragon's blood tree: a straight bole, repeated forks of nearly equal limbs, an umbrella of blade rosettes. */
export const DRAGON: TreeSpecies = {
  name: 'dragon', trunkLen: [3.4, 4.8], trunkR: 0.5, lenK: 0.66, depth: 4, kids: [2, 3], angle: [0.5, 0.8], leader: -1,
  tropism: 0.16, wobble: 0.08, delta: 2.6, step: 0.8, foliage: 'blades', leafSize: 1.2, leafCount: 13, weep: 0,
};
/** Excurrent spire: a leader that keeps going, whorls of short drooping side limbs. */
export const SPIRE: TreeSpecies = {
  name: 'spire', trunkLen: [7, 10], trunkR: 0.34, lenK: 0.42, depth: 4, kids: [3, 4], angle: [1.0, 1.35], leader: 0.08,
  tropism: 0.02, wobble: 0.1, delta: 2.2, step: 1.0, foliage: 'leaves', leafSize: 0.36, leafCount: 5, weep: 0.08,
};
/** Low coral shrub: many stems from the root, fanning up, dense luminous buds. */
export const SHRUB: TreeSpecies = {
  name: 'shrub', trunkLen: [0.5, 0.9], trunkR: 0.16, lenK: 0.95, depth: 4, kids: [2, 3], angle: [0.4, 0.7], leader: -1,
  tropism: 0.2, wobble: 0.25, delta: 2.0, step: 0.45, foliage: 'leaves', leafSize: 0.26, leafCount: 5, weep: 0,
};
/** The Blight's dead tree: twisted, drooping, thorn-tipped, no leaves. */
export const BLIGHT: TreeSpecies = {
  name: 'blight', trunkLen: [2.6, 4], trunkR: 0.3, lenK: 0.7, depth: 5, kids: [2, 3], angle: [0.6, 1.1], leader: -1,
  tropism: -0.06, wobble: 0.38, delta: 2.1, step: 0.7, foliage: 'none', leafSize: 0, leafCount: 0, weep: 0.06,
};

export const TREE_SPECIES = [CANOPY, DRAGON, SPIRE, SHRUB, BLIGHT];

const UP: V3 = [0, 1, 0];
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function growSkeleton(sp: TreeSpecies, seed: number): { s: Skeleton; tips: number[] } {
  const rng = new Rng(seed);
  const s = newSkeleton();
  const tips: number[] = [];
  const shrubStems = sp === SHRUB ? rng.int(3, 5) : 1;
  const root = addNode(s, [0, -0.4, 0], sp.trunkR * 1.25, -1, 0);
  for (let st = 0; st < shrubStems; st++) {
    const lean = sp === SHRUB ? 0.5 : 0.08;
    const dir = norm([rng.range(-lean, lean), 1, rng.range(-lean, lean)]);
    branch(s, rng, sp, root, [0, -0.4, 0], dir, rng.range(sp.trunkLen[0], sp.trunkLen[1]), sp.trunkR / Math.sqrt(shrubStems), 0, rng.range(0, 6.28), tips);
  }
  return { s, tips };
}

/** da Vinci's rule: child radii with r^Δ = Σ rcᵢ^Δ, each child's share of r^Δ proportional to its weight. */
export function daVinci(r: number, shares: number[], delta: number) {
  const sum = shares.reduce((a, b) => a + b, 0);
  return shares.map((s) => r * Math.pow(s / sum, 1 / delta));
}

function branch(s: Skeleton, rng: Rng, sp: TreeSpecies, parent: number, p0: V3, dir: V3, length: number, r0: number, depth: number, roll: number, tips: number[]) {
  const steps = Math.max(2, Math.round(length / sp.step));
  const rEnd = r0 * (depth === 0 ? 0.78 : 0.7);
  let p = p0;
  let d = dir;
  let node = parent;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const pull = sp.tropism - sp.weep * depth * t;
    d = norm(add(add(d, scale(UP, pull)), [rng.gauss() * sp.wobble * 0.35, rng.gauss() * sp.wobble * 0.15, rng.gauss() * sp.wobble * 0.35]));
    p = add(p, scale(d, length / steps));
    node = addNode(s, p, r0 + (rEnd - r0) * t, node, depth);
  }
  if (depth >= sp.depth || rEnd < 0.012) {
    tips.push(node);
    return;
  }
  const n = rng.int(sp.kids[0], sp.kids[1]);
  // with a leader, it takes the larger share of the cross-section
  const shares: number[] = [];
  for (let i = 0; i < n; i++) shares.push(sp.leader >= 0 && i === 0 ? 2.2 : rng.range(0.7, 1.3));
  const radii = daVinci(rEnd, shares, sp.delta);
  const side = perp(d);
  for (let i = 0; i < n; i++) {
    const rc = radii[i];
    const leader = sp.leader >= 0 && i === 0;
    const ang = leader ? sp.leader : rng.range(sp.angle[0], sp.angle[1]);
    const az = roll + (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const axis = rotate(side, d, az);
    let cd = rotate(d, norm(axis), ang);
    // keep forks from boring into the ground
    if (cd[1] < -0.35) cd = norm([cd[0], -0.35, cd[2]]);
    const cl = length * sp.lenK * (leader ? 0.9 : rng.range(0.75, 1.05)) * (depth === 0 && sp === SPIRE && !leader ? 0.5 : 1);
    branch(s, rng, sp, node, s.p[node], cd, cl, rc, depth + 1, roll + GOLDEN * (i + 1), tips);
  }
}

/** Foliage at the twig tips: leaf cards (two triangles, folded along the midrib) or rosettes of long blades. */
function foliage(sp: TreeSpecies, sk: Skeleton, tips: number[], b: MeshBuilder, rng: Rng, keep: number, grow: number) {
  if (sp.foliage === 'none') return;
  for (const t of tips) {
    if (rng.next() > keep) continue;
    const at = sk.p[t];
    const par = sk.p[sk.parent[t]];
    const tdir = norm([at[0] - par[0], at[1] - par[1], at[2] - par[2]]);
    const hue = rng.next();
    const count = Math.max(2, Math.round(sp.leafCount * (sp.foliage === 'blades' ? 1 : 1 / Math.sqrt(keep))));
    for (let k = 0; k < count; k++) {
      let dir: V3;
      let size = sp.leafSize * grow * rng.range(0.7, 1.25);
      let base = at;
      if (sp.foliage === 'blades') {
        // rosette: blades radiate from the tip, mostly sideways and up, on the golden angle
        const az = k * GOLDEN + rng.range(-0.2, 0.2);
        const el = rng.range(-0.15, 0.85);
        dir = norm([Math.cos(az) * Math.cos(el), Math.sin(el) + 0.2, Math.sin(az) * Math.cos(el)]);
      } else {
        // leaves along the last stretch of the twig, turned outward
        base = add(at, scale(tdir, -rng.range(0, 0.6)));
        dir = norm(add(scale(tdir, 0.6), [rng.gauss() * 0.7, rng.gauss() * 0.5 + 0.2, rng.gauss() * 0.7]));
        size *= 0.9;
      }
      const w = sp.foliage === 'blades' ? size * 0.09 : size * 0.42;
      const side = norm(cross(dir, Math.abs(dir[1]) > 0.95 ? [1, 0, 0] : UP));
      const fold = norm(cross(side, dir)); // leaf normal
      const tipP = add(base, scale(dir, size));
      const midP = add(base, scale(dir, size * 0.45));
      const lP = add(add(midP, scale(side, w)), scale(fold, -w * 0.35));
      const rP = add(add(midP, scale(side, -w)), scale(fold, -w * 0.35));
      // blades droop at the end like Dracaena leaves
      const tipD = sp.foliage === 'blades' ? add(tipP, [0, -size * 0.18, 0]) : tipP;
      const hv = hue;
      const i0 = b.vertex(base[0], base[1], base[2], fold[0], fold[1], fold[2], 1, hv, 0, 0.2);
      const i1 = b.vertex(lP[0], lP[1], lP[2], fold[0], fold[1], fold[2], 1, hv, 0, 0.6);
      const i2 = b.vertex(tipD[0], tipD[1], tipD[2], fold[0], fold[1], fold[2], 1, hv, 0, 1);
      const i3 = b.vertex(rP[0], rP[1], rP[2], fold[0], fold[1], fold[2], 1, hv, 0, 0.6);
      b.tri(i0, i1, i2);
      b.tri(i0, i2, i3);
    }
  }
}

export interface TreeLod {
  /** Ring sides scale (1 full). */
  sides: number;
  minR: number;
  /** Fraction of tips that keep foliage (the rest is folded into bigger leaves). */
  keep: number;
}
export const TREE_LODS: TreeLod[] = [
  { sides: 1, minR: 0.012, keep: 1 },
  { sides: 0.5, minR: 0.035, keep: 0.4 },
];

export function buildTree(sp: TreeSpecies, seed: number, lod: TreeLod): MeshArrays {
  const { s, tips } = growSkeleton(sp, seed);
  const b = new MeshBuilder();
  sweepSkeleton(s, b, {
    sides: (r) => Math.max(3, Math.round((r > 0.3 ? 9 : r > 0.12 ? 7 : r > 0.05 ? 5 : 3) * lod.sides)),
    minR: lod.minR,
    maxDepth: sp.depth,
  });
  foliage(sp, s, tips, b, new Rng(seed ^ 0x51a7), lod.keep, lod.keep < 1 ? 1.45 : 1);
  return b.build();
}

/**
 * A grass clump: 7–11 blades, each a tapered strip bent along a quadratic arc (leaning out from the root and
 * drooping toward the tip), on the golden angle. Two-sided; aux.w runs 0 → 1 up each blade.
 */
export function buildTuft(seed: number): MeshArrays {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const n = rng.int(7, 11);
  const SEG = 4;
  for (let k = 0; k < n; k++) {
    const az = k * GOLDEN + rng.range(-0.25, 0.25);
    const out: V3 = [Math.cos(az), 0, Math.sin(az)];
    const side: V3 = [-out[2], 0, out[0]];
    const h = rng.range(0.45, 0.95);
    const lean = rng.range(0.15, 0.55);
    const w = rng.range(0.035, 0.06);
    const r0 = rng.range(0, 0.08);
    let prevL = -1;
    let prevR = -1;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      // arc: up with a lean that grows as t², the tip drooping a little
      const p: V3 = add(scale(out, r0 + lean * h * t * t), [0, h * (t - 0.18 * lean * t * t * t), 0]);
      const ww = w * (1 - t * 0.92);
      const L = add(p, scale(side, ww));
      const R = add(p, scale(side, -ww));
      const nrm = norm(add(scale(out, 1 - t * 0.5), [0, 0.35 + t * 0.5, 0]));
      const iL = b.vertex(L[0], L[1], L[2], nrm[0], nrm[1], nrm[2], 1, k / n, 0, t);
      const iR = b.vertex(R[0], R[1], R[2], nrm[0], nrm[1], nrm[2], 1, k / n, 0, t);
      if (prevL >= 0) b.quad(prevL, prevR, iR, iL);
      prevL = iL;
      prevR = iR;
    }
  }
  return b.build();
}
