import * as THREE from 'three';
import type { Rng } from '../../util/rng';

/** Parallel string rewriting (Lindenmayer, "The Algorithmic Beauty of Plants"). */
const memo = new Map<string, string>();

export function expand(axiom: string, rules: Record<string, string>, iterations: number, maxLen = 20000) {
  const key = `${axiom}|${JSON.stringify(rules)}|${iterations}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let s = axiom;
  for (let i = 0; i < iterations; i++) {
    let out = '';
    for (const ch of s) out += rules[ch] ?? ch;
    if (out.length > maxLen) break;
    s = out;
  }
  memo.set(key, s);
  return s;
}

export interface Segment {
  /** Base of the segment (world). */
  a: THREE.Vector3;
  /** Unit growth direction. */
  dir: THREE.Vector3;
  len: number;
  radius: number;
  /** Branch order (0 = trunk). */
  depth: number;
}

export interface Leaf {
  p: THREE.Vector3;
  depth: number;
}

export interface Species {
  axiom: string;
  rules: Record<string, string>;
  iterations: number;
  /** Turn angle (radians) for + - & ^; roll angle for \ /. */
  angle: number;
  roll: number;
  length: number;
  radius: number;
  /** Per '!' scale factors. */
  lengthDecay: number;
  radiusDecay: number;
  /** Random angle jitter (fraction of `angle`). */
  jitter: number;
  /** Upward bias applied after each segment (gravitropism; negative droops). */
  tropism: number;
}

/** Monopodial canopy tree with three-way whorled branching (ABOP fig. 1.25 family). */
export const CANOPY_TREE: Species = {
  axiom: 'FFA',
  rules: { A: '!F[&FLA]/////[&FLA]///////[&FLA]' },
  iterations: 5,
  angle: 0.42,
  roll: 0.4,
  length: 2.4,
  radius: 0.5,
  lengthDecay: 0.8,
  radiusDecay: 0.66,
  jitter: 0.35,
  tropism: 0.12,
};

/** Bracketed fractal plant (ABOP fig. 1.24f) — fern-like undergrowth, rolled into 3D. */
export const FERN_BUSH: Species = {
  axiom: 'X',
  rules: { X: 'F+[[X]-X]-F[-FX]+X', F: 'FF' },
  iterations: 3,
  angle: 0.39,
  roll: 1.2,
  length: 0.5,
  radius: 0.05,
  lengthDecay: 1,
  radiusDecay: 1,
  jitter: 0.3,
  tropism: 0.05,
};

/** Withered Null-blight tree: sparse, drooping, thorned. */
export const BLIGHT_TREE: Species = {
  axiom: 'FA',
  rules: { A: '!F[&&FA]////[^&FLA]/////[&FA]' },
  iterations: 4,
  angle: 0.62,
  roll: 0.9,
  length: 2.1,
  radius: 0.36,
  lengthDecay: 0.78,
  radiusDecay: 0.62,
  jitter: 0.6,
  tropism: -0.14,
};

const _q = new THREE.Quaternion();
const AX_H = new THREE.Vector3();
const AX_L = new THREE.Vector3();
const AX_U = new THREE.Vector3();

/**
 * 3D turtle: F draws a segment, + - yaw, & ^ pitch, \ / roll, [ ] push/pop, ! shrinks, L marks a leaf.
 * Heading H, left L and up U are an orthonormal frame rotated in place.
 */
export function interpret(sp: Species, base: THREE.Vector3, rng: Rng, scale = 1, onSeg: (s: Segment) => void, onLeaf: (l: Leaf) => void) {
  const str = expand(sp.axiom, sp.rules, sp.iterations);
  type State = { p: THREE.Vector3; h: THREE.Vector3; l: THREE.Vector3; u: THREE.Vector3; len: number; rad: number; depth: number };
  let st: State = {
    p: base.clone(),
    h: new THREE.Vector3(0, 1, 0),
    l: new THREE.Vector3(-1, 0, 0),
    u: new THREE.Vector3(0, 0, 1),
    len: sp.length * scale,
    rad: sp.radius * scale,
    depth: 0,
  };
  // random initial roll so neighbouring plants differ
  const r0 = rng.range(0, Math.PI * 2);
  _q.setFromAxisAngle(st.h, r0);
  st.l.applyQuaternion(_q);
  st.u.applyQuaternion(_q);
  const stack: State[] = [];
  const turn = (axis: THREE.Vector3, a: number) => {
    const j = a * (1 + (rng.next() * 2 - 1) * sp.jitter);
    _q.setFromAxisAngle(axis, j);
    st.h.applyQuaternion(_q).normalize();
    st.l.applyQuaternion(_q).normalize();
    st.u.applyQuaternion(_q).normalize();
  };
  for (const ch of str) {
    switch (ch) {
      case 'F': {
        const len = st.len * (0.85 + rng.next() * 0.3);
        onSeg({ a: st.p.clone(), dir: st.h.clone(), len, radius: st.rad, depth: st.depth });
        st.p.addScaledVector(st.h, len);
        // tropism: bend the heading toward (or away from) the sky
        if (sp.tropism) {
          st.h.y += sp.tropism;
          st.h.normalize();
          AX_L.copy(st.u).cross(st.h).normalize();
          st.l.copy(AX_L);
          st.u.copy(AX_H.copy(st.h).cross(st.l)).normalize();
        }
        break;
      }
      case '+': turn(AX_U.copy(st.u), sp.angle); break;
      case '-': turn(AX_U.copy(st.u), -sp.angle); break;
      case '&': turn(AX_L.copy(st.l), sp.angle); break;
      case '^': turn(AX_L.copy(st.l), -sp.angle); break;
      case '\\': turn(AX_H.copy(st.h), sp.roll); break;
      case '/': turn(AX_H.copy(st.h), -sp.roll); break;
      case '!':
        st.len *= sp.lengthDecay;
        st.rad *= sp.radiusDecay;
        break;
      case '[':
        stack.push({ p: st.p.clone(), h: st.h.clone(), l: st.l.clone(), u: st.u.clone(), len: st.len, rad: st.rad, depth: st.depth });
        st.depth++;
        break;
      case ']':
        if (stack.length) st = stack.pop()!;
        break;
      case 'L':
        onLeaf({ p: st.p.clone(), depth: st.depth });
        break;
      case 'A':
      case 'X':
        onLeaf({ p: st.p.clone(), depth: st.depth });
        break;
    }
  }
}
