/** OKLab in TSL: the shader twins of `color.ts` (linear sRGB in and out). */
import { Fn, vec3, dot, pow, mix, sign, abs } from 'three/tsl';
import type { N } from './materials';

/** Row-vector product (explicit rows: no column-major ambiguity between backends). */
const rows = (v: N, r0: number[], r1: number[], r2: number[]): N => vec3(dot(v, vec3(...r0)), dot(v, vec3(...r1)), dot(v, vec3(...r2)));
const cbrt = (v: N): N => sign(v).mul(pow(abs(v), vec3(1 / 3)));
/** Linear sRGB → OKLab (TSL). */
export const toOklabNode = Fn(([c]: [N]) => {
  const lms = cbrt(rows(c, [0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]));
  return rows(lms, [0.2104542553, 0.793617785, -0.0040720468], [1.9779984951, -2.428592205, 0.4505937099], [0.0259040371, 0.7827717662, -0.808675766]);
});
/** OKLab → linear sRGB (TSL). */
export const fromOklabNode = Fn(([lab]: [N]) => {
  const q: N = rows(lab, [1, 0.3963377774, 0.2158037573], [1, -0.1055613458, -0.0638541728], [1, -0.0894841775, -1.291485548]);
  const lms: N = q.mul(q).mul(q);
  return rows(lms, [4.0767416621, -3.3077115913, 0.2309699292], [-1.2684380046, 2.6097574011, -0.3413193965], [-0.0041960863, -0.7034186147, 1.707614701]);
});
/** Perceptual blend of two linear colours (TSL). */
export const mixOklabNode = (a: N, b: N, t: N | number): N => fromOklabNode(mix(toOklabNode(a), toOklabNode(b), t));
