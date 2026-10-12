import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as THREE from 'three';
import {
  texture, positionGeometry, positionWorld, normalWorld, float, vec2, vec3, mix, smoothstep, abs, sin, max, pow, clamp,
  materialColor, diffuseColor, cameraPosition, normalize, atan, positionView, color, attribute,
} from 'three/tsl';
import { proceduralBump, worldTime, floraGlow, type N } from './materials';
import { flag } from './flags';
import { instanceIndex, positionLocal, hash } from 'three/tsl';
import { fractalTexture, surfaceDetail, surfaces } from './proctex';

/**
 * World surface materials built on the procedural textures (engine/proctex): bark, stone with fractal inlays,
 * fibrous stems, spotted caps, grass, and crystal with a Julia set refracting inside it. All sample in world
 * space (biplanar), so instanced scaling never stretches them, and all multiply into the instance colour so the
 * flora keeps its per-instance tints. `surfaceDetail` (from the render quality) decides whether micro-relief is
 * bump-mapped: the low tier skips the derivative work entirely.
 */

/**
 * World-space triplanar sample: ZY, XZ and XY projections blended by the sharpened normal, so walls, tops and
 * tilted branches all read the texture at its true scale. `sy` scales the vertical axis on the side projections.
 */
export function biplanar(tex: THREE.Texture, p: N, n: N, sx: number, sy: number): N {
  const an: N = pow(abs(n), vec3(4));
  const wsum: N = an.x.add(an.y).add(an.z).add(1e-4);
  const a: N = texture(tex, vec2(p.z.mul(sx), p.y.mul(sy)));
  const t: N = texture(tex, vec2(p.x.mul(sx), p.z.mul(sx)));
  const b: N = texture(tex, vec2(p.x.mul(sx), p.y.mul(sy)));
  return a.mul(an.x).add(t.mul(an.y)).add(b.mul(an.z)).div(wsum);
}

/** Fade (1 near → 0 far) for detail that only matters close to the camera. */
export const nearFade = (a: number, b: number): N => float(1).sub(smoothstep(a, b, positionView.length()));

/** Bump-map micro relief, faded out with distance (minified relief only sparkles). Skipped on the low tier. */
const bump = (m: MeshStandardNodeMaterial, h: N, k: number) => {
  if (surfaceDetail > 0) m.normalNode = proceduralBump(h.mul(nearFade(12, 40)), k);
};

/** Bark: fibres and furrowed plates, moss settling on the upper sides. */
export function barkMaterial(o: { roughness?: number; side?: THREE.Side; moss?: number } = {}) {
  const m = new MeshStandardNodeMaterial({ roughness: o.roughness ?? 0.78, metalness: 0.04, side: o.side ?? THREE.FrontSide });
  const b: N = biplanar(surfaces.bark, positionWorld, normalWorld, 0.55, 0.22);
  const up: N = smoothstep(0.1, 0.7, normalWorld.y);
  const moss: N = b.a.mul(up).mul(o.moss ?? 0.8);
  const tone: N = float(0.6).add(b.r.mul(0.35)).add(b.b.sub(0.5).mul(0.5)).mul(float(1).sub(b.g.mul(0.6)));
  m.colorNode = materialColor.mul(tone).mul(mix(vec3(1), vec3(0.55, 1.15, 0.7), moss));
  m.roughnessNode = clamp(float(o.roughness ?? 0.78).add(b.g.mul(0.15)).add(moss.mul(0.1)), 0, 1);
  bump(m, b.r.mul(0.35).sub(b.g.mul(0.9)).add(moss.mul(0.3)), 0.05);
  return m;
}

/**
 * Cut stone: coursed blocks with chipped arrises, fissures and lichen, and a fractal glyph inlaid in each face
 * (the Mandelbrot set or a Julia set, picked per block row), its boundary lit in `glyph` and breathing slowly.
 */
export function stoneMaterial(glyph: THREE.ColorRepresentation, o: { roughness?: number; metalness?: number; scale?: number; inlay?: number; flatShading?: boolean } = {}) {
  const m = new MeshStandardNodeMaterial({ roughness: o.roughness ?? 0.6, metalness: o.metalness ?? 0.15, flatShading: o.flatShading ?? false });
  const k = o.scale ?? 0.45;
  const s: N = biplanar(surfaces.stone, positionWorld, normalWorld, k, k);
  const tone: N = s.g.mul(0.6).add(0.55).mul(float(1).sub(s.r.mul(0.55))).mul(float(1).sub(s.b.mul(0.5)));
  const lichen: N = s.a.mul(smoothstep(-0.2, 0.6, normalWorld.y)).mul(0.6);
  m.colorNode = materialColor.mul(tone).mul(mix(vec3(1), vec3(0.75, 1.1, 0.8), lichen));
  m.roughnessNode = clamp(float(o.roughness ?? 0.6).add(s.r.mul(0.25)).sub(s.g.sub(0.5).mul(0.2)), 0, 1);
  bump(m, s.g.mul(0.3).sub(s.r.mul(0.8)).sub(s.b.mul(0.6)), 0.06);
  const inlay = o.inlay ?? 1;
  if (inlay > 0) {
    // glyphs repeat every ~4.5 m along each face, rotated per projection so neighbours differ
    const w: N = abs(normalWorld.x).div(abs(normalWorld.x).add(abs(normalWorld.z)).add(1e-4));
    const fu: N = mix(positionWorld.x, positionWorld.z, w);
    const g: N = texture(fractalTexture(), vec2(fu.mul(0.22), positionWorld.y.mul(0.22)));
    const pick: N = smoothstep(0.4, 0.6, sin(positionWorld.y.mul(0.7).add(fu.mul(0.3))));
    const line: N = mix(g.r, g.g, pick);
    const breathe: N = sin(worldTime.mul(1.1).add(fu.mul(0.4)).add(positionWorld.y.mul(0.3))).mul(0.35).add(0.65);
    const glyphC: N = color(new THREE.Color(glyph));
    const side: N = smoothstep(0.75, 0.35, abs(normalWorld.y));
    m.emissiveNode = glyphC.mul(pow(line, float(1.5)).mul(breathe).mul(side).mul(0.55 * inlay)).mul(floraGlow).mul(nearFade(40, 110));
  }
  return m;
}

/** Mushroom stem: vertical fibres and a ring of darker gill-shadow under the cap. */
export function stemMaterial() {
  const m = new MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  const b: N = biplanar(surfaces.bark, positionWorld.mul(vec3(2.2, 0.8, 2.2)), normalWorld, 1, 0.6);
  const top: N = smoothstep(0.75, 1, positionGeometry.y);
  m.colorNode = materialColor.mul(float(0.75).add(b.r.mul(0.35)).sub(b.g.mul(0.2))).mul(float(1).sub(top.mul(0.45)));
  bump(m, b.r, 0.02);
  return m;
}

/**
 * Mushroom cap (unit hemisphere): Voronoi spots that glow a little brighter than the hide, radial gills on the
 * underside, a lit rim. `k` is the overall self-light as in `selfLit`.
 */
export function capMaterial(k: number) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
  const p: N = positionGeometry;
  const spots: N = texture(surfaces.ground, p.xz.mul(0.45).add(p.y.mul(0.2))).g;
  const ang: N = atan(p.z, p.x);
  const gills: N = abs(sin(ang.mul(42))).oneMinus().pow(float(3)).mul(smoothstep(0.25, 0.02, p.y));
  const rim: N = smoothstep(0.12, 0.0, p.y);
  m.colorNode = materialColor.mul(float(0.82).add(spots.mul(0.4)).sub(gills.mul(0.35)));
  m.emissiveNode = diffuseColor.rgb.mul(float(k).mul(float(0.7).add(spots.mul(1.6)).add(rim.mul(0.9)))).mul(floraGlow.mul(0.5).add(0.5));
  return m;
}

/** Grass tufts: dark at the root, lit at the tip, with blade striations. */
export function tuftMaterial(k: number, side: THREE.Side = THREE.FrontSide) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0, side });
  const h: N = clamp(positionGeometry.y.mul(1.3), 0, 1);
  const streak: N = abs(sin(atan(positionGeometry.z, positionGeometry.x).mul(6).add(positionWorld.x.mul(3)))).mul(0.25).add(0.75);
  m.colorNode = materialColor.mul(mix(float(0.35), float(1.15), h)).mul(streak);
  m.emissiveNode = diffuseColor.rgb.mul(float(k).mul(pow(h, float(2.5)).mul(1.8).add(0.15))).mul(floraGlow);
  if (flag('wind')) {
    // wind: blades bend with the square of their height, each instance on its own phase, under slow gusts
    const ph: N = hash(instanceIndex).mul(6.283);
    const gust: N = sin(worldTime.mul(0.7).add(ph.mul(0.3))).mul(0.5).add(0.8);
    const sway: N = sin(worldTime.mul(2.3).add(ph)).mul(gust).mul(h.mul(h)).mul(0.12);
    m.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6)));
  }
  return m;
}

/**
 * Crystal: a Julia set seen through the facets. The glyph is sampled along the view ray with a parallax offset,
 * so the fractal seems to hang inside the stone and shifts as the camera moves.
 */
export function crystalMaterial(k: number, o: { roughness?: number; metalness?: number; flatShading?: boolean } = {}) {
  const m = new MeshStandardNodeMaterial({ roughness: o.roughness ?? 0.1, metalness: o.metalness ?? 0.2, flatShading: o.flatShading ?? true });
  const v: N = normalize(cameraPosition.sub(positionWorld));
  const uv: N = positionWorld.xz.add(positionWorld.y.mul(0.6)).mul(0.25).add(v.xz.mul(0.35));
  const g: N = texture(fractalTexture(), uv);
  const inner: N = max(g.g, g.r.mul(0.6));
  m.emissiveNode = diffuseColor.rgb.mul(float(k).mul(float(0.55).add(inner.mul(1.4)))).mul(floraGlow.mul(0.4).add(0.6));
  return m;
}

/**
 * Generated trees (world/gen/meshgen): one mesh holds bark tubes (aux.x = 0) and foliage (aux.x = 1). Bark is the
 * world-space bark texture, lightening toward the twigs; leaves and blades take the region's two accents, darker at
 * the stalk and glowing toward the tip. Wind bends the whole tree with the square of its height and flutters leaves.
 */
export function treeMaterial(trunk: THREE.ColorRepresentation, leafA: THREE.ColorRepresentation, leafB: THREE.ColorRepresentation, k: number, twigGlow = 0) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.02, side: THREE.DoubleSide });
  const aux: N = attribute('aAux', 'vec4');
  const leaf: N = aux.x;
  const b: N = biplanar(surfaces.bark, positionWorld, normalWorld, 0.9, 0.35);
  const up: N = smoothstep(0.1, 0.7, normalWorld.y);
  const moss: N = b.a.mul(up).mul(0.6);
  const tone: N = float(0.6).add(b.r.mul(0.35)).add(b.b.sub(0.5).mul(0.5)).mul(float(1).sub(b.g.mul(0.6)));
  const barkC: N = color(new THREE.Color(trunk)).mul(tone).mul(mix(vec3(1), vec3(0.55, 1.15, 0.7), moss)).mul(aux.w.mul(0.5).add(0.85));
  const leafC: N = mix(color(new THREE.Color(leafA)), color(new THREE.Color(leafB)), aux.y);
  const along: N = aux.w; // 0 at the stalk, 1 at the tip
  m.colorNode = mix(barkC, leafC.mul(mix(float(0.25), float(0.7), along)), leaf);
  // twigGlow: bare twig ends smoulder in the leaf colour (the Blight's thorns)
  const twig: N = float(twigGlow).mul(pow(aux.w, float(4))).mul(float(1).sub(leaf));
  m.emissiveNode = leafC.mul(leaf.mul(k).mul(pow(along, float(2.2)).mul(0.45).add(0.05)).add(twig)).mul(floraGlow);
  m.roughnessNode = mix(float(0.82), float(0.5), leaf);
  if (surfaceDetail > 0) m.normalNode = proceduralBump(b.r.mul(0.35).sub(b.g.mul(0.9)).mul(float(1).sub(leaf)).mul(nearFade(12, 40)), 0.05);
  if (flag('wind')) {
    const ph: N = hash(instanceIndex).mul(6.283);
    const h: N = aux.z;
    const gust: N = sin(worldTime.mul(0.5).add(ph.mul(0.3))).mul(0.5).add(0.7);
    const sway: N = sin(worldTime.mul(1.3).add(ph)).mul(gust).mul(h.mul(h)).mul(0.22);
    const flutter: N = sin(worldTime.mul(7).add(positionLocal.x.mul(3)).add(positionLocal.z.mul(2))).mul(leaf).mul(along).mul(0.06);
    m.positionNode = positionLocal.add(vec3(sway.add(flutter), flutter.mul(0.5), sway.mul(0.6)));
  }
  return m;
}

/**
 * Natural rock for the generated boulders and hoodoos: the stone texture's grain and fissures sampled in world
 * space, lichen on the tops, darker crevices from the field's own noise (aux.y). Hoodoos add sediment bands from
 * their bed phase and a paler caprock.
 */
export function rockMaterial(banded = false) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0.02 });
  const aux: N = attribute('aAux', 'vec4');
  const s: N = biplanar(surfaces.stone, positionWorld, normalWorld, 0.35, 0.35);
  const lichen: N = s.a.mul(smoothstep(0.2, 0.8, normalWorld.y)).mul(0.7);
  let tone: N = float(0.55).add(s.g.mul(0.45)).mul(float(1).sub(s.b.mul(0.45))).mul(aux.y.mul(0.5).add(0.75));
  if (banded) tone = tone.mul(mix(float(0.7), float(1.25), aux.y)).mul(mix(float(1), float(1.35), smoothstep(0.92, 1, aux.w)));
  m.colorNode = materialColor.mul(tone).mul(mix(vec3(1), vec3(0.7, 1.1, 0.75), lichen));
  m.roughnessNode = clamp(float(0.85).add(s.r.mul(0.1)), 0, 1);
  bump(m, s.g.mul(0.4).sub(s.r.mul(0.6)).sub(s.b.mul(0.5)), 0.05);
  return m;
}

/**
 * Fractal formations: dark stone whose colour and light follow the orbit trap stored per vertex (aux.w, and its
 * banding in aux.y), so the glowing veins run along the fractal's own structure. A slow pulse climbs the formation.
 */
export function formationMaterial(accent: THREE.ColorRepresentation, accent2: THREE.ColorRepresentation, ground: THREE.ColorRepresentation) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.15 });
  const aux: N = attribute('aAux', 'vec4');
  const a: N = color(new THREE.Color(accent));
  const b2: N = color(new THREE.Color(accent2));
  const s: N = biplanar(surfaces.stone, positionWorld, normalWorld, 0.12, 0.12);
  const base: N = mix(color(new THREE.Color(ground)).mul(0.9), vec3(0.09, 0.085, 0.1), 0.5);
  const trap: N = aux.w;
  const band: N = aux.y;
  m.colorNode = mix(base, mix(a, b2, band).mul(0.35), smoothstep(0.35, 0.0, trap).mul(0.6)).mul(float(0.6).add(s.g.mul(0.5)));
  const vein: N = pow(clamp(float(1).sub(abs(band.sub(0.5)).mul(2)), 0, 1), float(14));
  const pulse: N = sin(aux.z.mul(18).sub(worldTime.mul(1.4))).mul(0.5).add(0.5);
  m.emissiveNode = mix(a, b2, smoothstep(0.1, 0.6, trap)).mul(vein.mul(pulse.mul(0.7).add(0.3)).mul(0.9).add(smoothstep(0.12, 0.0, trap).mul(0.25))).mul(floraGlow);
  bump(m, s.g.mul(0.4).sub(s.r.mul(0.6)), 0.04);
  return m;
}

/**
 * Atlas Stations (gen/meshgen/stations): members carry their own structural analysis. aAux = (part, signed axial
 * stress −1 compression … +1 tension, height 0..1, utilisation 0..1). Struts are oiled timber; a member glows cyan
 * in tension and amber in compression, brighter the harder it works, with light running along the load path (up
 * the ties, down the struts to the ground). Joints are dark bronze nodes; panels are frosted, faintly lit glass.
 */
export function structureMaterial(accent: THREE.ColorRepresentation, accent2: THREE.ColorRepresentation) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.2 });
  const aux: N = attribute('aAux', 'vec4');
  const part: N = aux.x;
  const st: N = aux.y;
  const util: N = aux.w;
  const b: N = biplanar(surfaces.bark, positionWorld, normalWorld, 1.4, 0.5);
  const timber: N = vec3(0.3, 0.2, 0.12).mul(b.b.mul(0.5).add(0.7)).mul(float(1).sub(b.g.mul(0.35)));
  const bronze: N = vec3(0.16, 0.12, 0.08);
  const glass: N = color(new THREE.Color(accent)).mul(0.12).add(vec3(0.03, 0.04, 0.05));
  const isJoint: N = smoothstep(0.5, 0.6, part).mul(smoothstep(1.6, 1.4, part));
  const isPanel: N = smoothstep(1.5, 1.6, part);
  m.colorNode = mix(mix(timber, bronze, isJoint), glass, isPanel);
  m.metalnessNode = mix(mix(float(0.05), float(0.85), isJoint), float(0.5), isPanel);
  m.roughnessNode = mix(mix(float(0.62), float(0.32), isJoint), float(0.22), isPanel);
  const tension: N = color(new THREE.Color(accent));
  const compression: N = color(new THREE.Color(0xffa040));
  const sc: N = mix(compression, tension, smoothstep(-0.15, 0.15, st));
  // light runs up the ties and down the struts, faster in the members that carry more
  const flow: N = sin(positionWorld.y.mul(2.2).sub(worldTime.mul(st.sign().mul(util.mul(2).add(0.6))))).mul(0.5).add(0.5);
  const load: N = util.mul(util).mul(flow.mul(0.6).add(0.4));
  const strutGlow: N = sc.mul(load.mul(0.9).add(0.03)).mul(float(1).sub(isPanel)).mul(float(1).sub(isJoint.mul(0.6)));
  const panelGlow: N = mix(color(new THREE.Color(accent)), color(new THREE.Color(accent2)), aux.z).mul(0.06).mul(isPanel);
  m.emissiveNode = strutGlow.add(panelGlow).add(sc.mul(isJoint).mul(0.25).mul(util.add(0.2))).mul(floraGlow);
  bump(m, b.g.mul(0.5).sub(b.r.mul(0.3)).mul(float(1).sub(isPanel)), 0.03);
  m.side = THREE.DoubleSide;
  return m;
}
