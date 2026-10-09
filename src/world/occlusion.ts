import * as THREE from 'three';

/** Screen-space position (px) + view depth of the player; shared by every fading material. */
export const occ = {
  player: { value: new THREE.Vector3(-1e5, -1e5, 1e5) },
  radius: { value: 150 },
};

const _v = new THREE.Vector3();
const _size = new THREE.Vector2();

/** Call once per frame with the player's world position. */
export function updateOcclusion(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, p: THREE.Vector3) {
  renderer.getDrawingBufferSize(_size);
  _v.copy(p).applyMatrix4(camera.matrixWorldInverse);
  const depth = -_v.z;
  _v.copy(p).project(camera);
  occ.player.value.set((_v.x * 0.5 + 0.5) * _size.x, (_v.y * 0.5 + 0.5) * _size.y, depth);
  occ.radius.value = _size.y * 0.14;
}

/**
 * Dithers away fragments that sit between the camera and the player, so tall
 * trees and mushrooms never hide the hero in the top-down view.
 */
export function occlusionFade<T extends THREE.Material>(m: T): T {
  const prev = m.onBeforeCompile;
  const prevSrc = prev ? prev.toString() : '';
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    shader.uniforms.uOccPlayer = occ.player;
    shader.uniforms.uOccRadius = occ.radius;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vOccView;\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vOccView = mvPosition.xyz;');
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      `varying vec3 vOccView; uniform vec3 uOccPlayer; uniform float uOccRadius;
void main() {
  {
    float dpx = distance(gl_FragCoord.xy, uOccPlayer.xy);
    float ahead = uOccPlayer.z - (-vOccView.z);
    float f = (1.0 - smoothstep(uOccRadius * 0.4, uOccRadius, dpx)) * smoothstep(0.6, 3.0, ahead);
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (n < f * 0.94) discard;
  }`,
    );
  };
  m.customProgramCacheKey = () => 'occ|' + prevSrc;
  return m;
}
