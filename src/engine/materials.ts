/* TSL node graphs are dynamically typed; the `N` alias keeps graph-building code readable under strict TS. */
import * as THREE from 'three';
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial, LineBasicNodeMaterial, type NodeMaterial } from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, color, mix, sin, fract, floor, dot, pow, max, smoothstep, abs, clamp,
  positionWorld, normalWorld, cameraPosition, diffuseColor, output, mrt, uv, exp, positionView, emissive,
  normalView, faceDirection,
} from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any;

/**
 * Game clock shared by every animated material. Driven by the game loop (not the renderer's wall clock)
 * so pausing, slow-motion and hit-stop freeze shaders together with the simulation.
 */
export const worldTime: N = uniform(0);

/**
 * Bioluminescence gain of the living world (flora tips, mycelial cords, wild glow), driven by the Mycelial Mind's
 * `floraGlowIntensity` directive: the network brightens or dims as the hero's play style feeds it.
 */
export const floraGlow: N = uniform(1);

// ---------------------------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------------------------

/** Dave Hoskins' hash without sine: stable on every GPU. vec2 → [0,1). */
export const hash21: N = Fn(([p]: [N]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, (p3 as N).yzx.add(33.33)));
  const q: N = p3;
  return fract(q.x.add(q.y).mul(q.z));
});

/** Smooth value noise in [0,1]. */
export const valueNoise: N = Fn(([p]: [N]) => {
  const i = floor(p);
  const f = fract(p);
  const u: N = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1, 0)));
  const c = hash21(i.add(vec2(0, 1)));
  const d = hash21(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** Four-octave fractal value noise, rotated each octave to avoid axis artefacts. */
export const fbm2: N = Fn(([p0]: [N]) => {
  const p = vec2(p0).toVar();
  const sum = float(0).toVar();
  const amp = float(0.5).toVar();
  for (let i = 0; i < 4; i++) {
    sum.addAssign(valueNoise(p).mul(amp));
    p.assign(vec2(p.x.mul(1.6).sub(p.y.mul(1.2)), p.x.mul(1.2).add(p.y.mul(1.6))));
    amp.mulAssign(0.5);
  }
  return sum;
});

/** View-dependent rim term, the blueprint's `pow(1 - N·V, 3)`. */
export const fresnel = (power = 3): N => {
  const v = cameraPosition.sub(positionWorld).normalize();
  return pow(float(1).sub(max(dot(normalWorld, v), 0)), float(power));
};

// ---------------------------------------------------------------------------------------------
// Bloom routing
// ---------------------------------------------------------------------------------------------

/**
 * Marks an unlit material as light-emitting: its colour is written into the emissive MRT target,
 * which is the only buffer the bloom pass reads. Lit materials route through `emissiveNode` instead.
 */
export function glow<T extends NodeMaterial>(m: T, k: number | N = 1): T {
  m.mrtNode = mrt({ output, emissive: vec4(output.rgb.mul(k).mul(fogKeep), output.a) });
  return m;
}

/** Scene fog density (FogExp2), mirrored here so the bloom buffer fades with distance like the lit image does. */
export const fogDensity: N = uniform(0.01);
/** Fraction of light that survives the fog to the camera (1 = none fogged). */
export const fogKeep: N = exp(fogDensity.mul(fogDensity).mul(positionView.length().pow(2)).negate());

/** What every fragment writes into the bloom target: its emissive light, fogged. */
export const bloomEmissive: N = vec4(emissive.mul(fogKeep), 1);

// ---------------------------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------------------------

/** Lit PBR surface that also glows in its own (instance/vertex) colour: emissive = albedo × k. */
export function selfLit(k: number, params: THREE.MeshStandardMaterialParameters = {}) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0, ...params });
  m.emissiveNode = diffuseColor.rgb.mul(k);
  return m;
}

export function standard(params: THREE.MeshStandardMaterialParameters = {}) {
  return new MeshStandardNodeMaterial(params);
}

export function basic(params: THREE.MeshBasicMaterialParameters = {}) {
  return new MeshBasicNodeMaterial(params);
}

export interface DataStreamOpts {
  albedo?: THREE.ColorRepresentation;
  emission?: THREE.ColorRepresentation;
  pulseSpeed?: number;
  noiseScale?: number;
  intensity?: number;
  /** Use world xz instead of mesh uv for the flow field (terrain, floors). */
  worldSpace?: boolean;
}

/**
 * Blueprint "Mycelium Data-Stream PBR": blue-green albedo (roughness 0.8, metalness 0.1), cyan emission that
 * flows along the surface. Emission = Cyan · (stream·2.5 + fresnel·1.5) · pulse.
 */
export function dataStreamMaterial(o: DataStreamOpts = {}) {
  const u = {
    albedo: uniform(new THREE.Color(o.albedo ?? 0x00aaff)),
    emission: uniform(new THREE.Color(o.emission ?? 0x00ffff)),
    pulseSpeed: uniform(o.pulseSpeed ?? 2.5),
    noiseScale: uniform(o.noiseScale ?? 12),
    intensity: uniform(o.intensity ?? 1),
  };
  const m = new MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.1 });
  const st: N = o.worldSpace ? positionWorld.xz.mul(u.noiseScale.mul(0.05)) : uv().mul(u.noiseScale);
  const stream = valueNoise(vec2(st.x, st.y.sub(worldTime.mul(u.pulseSpeed))));
  const pulse = sin(worldTime.mul(u.pulseSpeed).add(stream.mul(6.28))).mul(0.5).add(0.5);
  m.colorNode = mix(u.albedo.mul(0.2), u.albedo, stream);
  m.emissiveNode = u.emission.mul(stream.mul(2.5).add(fresnel(3).mul(1.5))).mul(pulse).mul(u.intensity);
  return { material: m, uniforms: u };
}

export interface CorrosionOpts {
  base?: THREE.ColorRepresentation;
  pulseRate?: number;
  corruption?: number;
  intensity?: number;
  /** Optional per-fragment corruption mask (0 = purified, 1 = void), multiplied with the uniform. */
  mask?: N;
}

/**
 * Blueprint "Multi-Channel Mycelium-Null-Corrosion PBR": one material that interpolates albedo, emission,
 * roughness (0.8→0.4) and metalness (0.1→0.6) between purified mycelium (cyan 0x00ffff) and Null void
 * (red 0xff0033) by the Corruption_Mask uniform.
 */
export function corrosionMaterial(o: CorrosionOpts = {}) {
  const u = {
    base: uniform(new THREE.Color(o.base ?? 0x0b1a20)),
    pulseRate: uniform(o.pulseRate ?? 2.5),
    corruption: uniform(o.corruption ?? 0),
    intensity: uniform(o.intensity ?? 1),
  };
  const m = new MeshStandardNodeMaterial();
  const c: N = o.mask ? clamp(u.corruption.add(o.mask), 0, 1) : u.corruption;
  const pulse = sin(worldTime.mul(u.pulseRate)).mul(0.5).add(0.5);
  const grain = fbm2(positionWorld.xz.mul(1.7).add(positionWorld.y));
  const cyan = color(0x00ffff).mul(pulse).mul(2.0);
  const red = color(0xff0033).mul(pulse.mul(1.5)).mul(2.5);
  const veins = pow(float(1).sub(abs(grain.mul(2).sub(1))), float(10));
  m.colorNode = mix(diffuseColor.rgb.mul(u.base.mul(4)), color(0x0a0003), c);
  m.emissiveNode = mix(cyan, red, c).mul(veins.mul(0.8).add(0.04)).mul(u.intensity);
  m.roughnessNode = mix(float(0.8), float(0.4), c).add(grain.mul(0.15));
  m.metalnessNode = mix(float(0.1), float(0.6), c);
  return { material: m, uniforms: u };
}

export interface NeuralOpts {
  base?: THREE.ColorRepresentation;
  cyan?: THREE.ColorRepresentation;
  harmonic?: THREE.ColorRepresentation;
  intensity?: number;
}

/** World-space contact point (xyz) + age in seconds (w) of the hero's last footfall. */
export const footContact: N = uniform(new THREE.Vector4(0, -9999, 0, 99));

/**
 * Blueprint "Mycelium-Fractal-Neural PBR": cyan mycelium pulse plus a blue harmonic wave that conducts
 * outward from the hero's footfalls ("Terrain Conduction Interface").
 */
export function neuralMaterial(o: NeuralOpts = {}) {
  const u = {
    base: uniform(new THREE.Color(o.base ?? 0x16222a)),
    cyan: uniform(new THREE.Color(o.cyan ?? 0x00ffff)),
    harmonic: uniform(new THREE.Color(o.harmonic ?? 0x3a6bff)),
    intensity: uniform(o.intensity ?? 1),
  };
  const m = new MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.15 });
  const n = fbm2(positionWorld.xz.mul(0.9));
  const fil = pow(float(1).sub(abs(n.mul(2).sub(1))), float(14));
  m.colorNode = mix(u.base, u.base.mul(1.8), n);
  m.emissiveNode = conduction(u.cyan, u.harmonic, fil).mul(u.intensity);
  m.roughnessNode = float(0.6).add(n.mul(0.35));
  return { material: m, uniforms: u };
}

/** Cyan mycelium pulse along `filament` plus a ring of blue harmonic light radiating from the last footfall. */
export function conduction(cyan: N, harmonic: N, filament: N): N {
  const d = positionWorld.xz.sub(footContact.xz).length();
  const age = footContact.w;
  const ring = smoothstep(1.4, 0, abs(d.sub(age.mul(9)))).mul(smoothstep(1.6, 0, age));
  const near = smoothstep(3, 0, d).mul(smoothstep(0.8, 0, age));
  const pulse = sin(worldTime.mul(2.5).sub(d.mul(0.6))).mul(0.5).add(0.5);
  return cyan.mul(filament).mul(pulse.mul(0.6).add(0.2)).add(harmonic.mul(ring.add(near).mul(filament.mul(3).add(0.35))));
}

/** Unlit light-emitting surface (rings, beams, cores, sparks): MeshBasic routed into bloom. */
export function glowBasic(params: THREE.MeshBasicMaterialParameters = {}, k: number | N = 1) {
  return glow(new MeshBasicNodeMaterial(params), k);
}

/** Light-emitting line material. */
export function glowLine(params: THREE.LineBasicMaterialParameters = {}, k = 1) {
  return glow(new LineBasicNodeMaterial(params), k);
}

/**
 * Procedural bump mapping for surfaces without UVs (Mikkelsen, "Bump Mapping Unparametrized Surfaces"):
 * the screen-space derivatives of any scalar height field perturb the view-space normal. Assign the result
 * to a lit material's `normalNode`.
 */
export const proceduralBump = (height: N, scale: number | N): N => {
  const h: N = float(height).mul(scale);
  const dHdx: N = h.dFdx();
  const dHdy: N = h.dFdy();
  const sx: N = positionView.dFdx();
  const sy: N = positionView.dFdy();
  const n: N = normalView;
  const r1: N = sy.cross(n);
  const r2: N = n.cross(sx);
  const det: N = sx.dot(r1).mul(faceDirection);
  const grad: N = det.sign().mul(dHdx.mul(r1).add(dHdy.mul(r2)));
  return det.abs().mul(n).sub(grad).normalize();
};
