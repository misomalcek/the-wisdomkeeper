import * as THREE from 'three';
import { buildFloraSet, buildFormationSet, type ProtoSet } from './gen/meshgen/index';
import type { MeshArrays } from './gen/meshgen/geo';

/**
 * The generated prototype meshes (gen/meshgen), built once per session in a module worker and kept as GPU
 * geometries. Pools ask for a key and get notified when the set lands; headless builds (tests) never need them.
 */
let started = false;
const geos = new Map<string, THREE.BufferGeometry>();
const arrays: ProtoSet = {};
/** Callbacks per batch: 0 flora and stone, 1 fractal formations. */
const done = [false, false];
const waiters: (() => void)[][] = [[], []];

const toGeometry = (m: MeshArrays) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
  g.setAttribute('aAux', new THREE.BufferAttribute(m.aux, 4));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, m.height * 0.5, 0), Math.hypot(m.radius, m.height * 0.5));
  return g;
};

function land(set: ProtoSet, batch: number) {
  for (const [k, m] of Object.entries(set)) {
    arrays[k] = m;
    geos.set(k, toGeometry(m));
  }
  done[batch] = true;
  for (const w of waiters[batch].splice(0)) w();
}

export function loadProtos() {
  if (started) return;
  started = true;
  if (typeof document === 'undefined') return;
  if (typeof Worker !== 'undefined') {
    try {
      const w = new Worker(new URL('./meshgen.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ set: ProtoSet; last: boolean }>) => {
        land(e.data.set, e.data.last ? 1 : 0);
        if (e.data.last) w.terminate();
      };
      w.postMessage(0);
      return;
    } catch {
      /* fall through to a synchronous build */
    }
  }
  land(buildFloraSet(), 0);
  land(buildFormationSet(), 1);
}

/** Calls back once a batch exists (at once if it already does): 0 flora and stone, 1 fractal formations. */
export function whenProtos(cb: () => void, batch = 0) {
  if (done[batch]) cb();
  else waiters[batch].push(cb);
}

export const protoGeometry = (key: string) => geos.get(key) ?? null;
/** Raw arrays (for colliders built from the same mesh). */
export const protoArrays = (key: string) => arrays[key] ?? null;
