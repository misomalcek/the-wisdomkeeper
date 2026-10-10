import * as THREE from 'three';
import type { NodeMaterial, WebGPURenderer } from 'three/webgpu';
import type { N } from '../engine/materials';
import { uniform, screenCoordinate, positionView, distance, smoothstep, fract, dot, vec2, bool, float } from 'three/tsl';

/** Screen-space position (px, top-left origin) + view depth of the player; shared by every fading material. */
export const occ = {
  player: uniform(new THREE.Vector3(-1e5, -1e5, 1e5)),
  radius: uniform(150),
};

const _v = new THREE.Vector3();
const _size = new THREE.Vector2();

/** Call once per frame with the player's world position. */
export function updateOcclusion(renderer: WebGPURenderer, camera: THREE.PerspectiveCamera, p: THREE.Vector3) {
  renderer.getDrawingBufferSize(_size);
  _v.copy(p).applyMatrix4(camera.matrixWorldInverse);
  const depth = -_v.z;
  _v.copy(p).project(camera);
  occ.player.value.set((_v.x * 0.5 + 0.5) * _size.x, (0.5 - _v.y * 0.5) * _size.y, depth);
  occ.radius.value = _size.y * 0.14;
}

/** Interleaved-gradient dither threshold in [0,1) for the current pixel. */
export const ditherNoise = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))));

/** Mask (true = keep) that dithers away fragments between the camera and the player. */
export const occlusionMask = (() => {
  const dpx = distance(screenCoordinate.xy, occ.player.xy);
  const ahead = occ.player.z.sub(positionView.z.negate());
  const f = float(1).sub(smoothstep(occ.radius.mul(0.4), occ.radius, dpx)).mul(smoothstep(0.6, 3.0, ahead));
  return ditherNoise.greaterThanEqual(f.mul(0.94));
})();

/**
 * Dithers away fragments that sit between the camera and the player, so tall
 * trees and mushrooms never hide the hero in the top-down view. Shadows stay whole.
 */
export function occlusionFade<T extends NodeMaterial>(m: T): T {
  m.maskNode = m.maskNode ? bool(m.maskNode as N).and(occlusionMask) : occlusionMask;
  m.maskShadowNode = bool(true);
  return m;
}
