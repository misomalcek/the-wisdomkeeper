import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, clamp, float, materialEmissive, mix, positionGeometry, sin, smoothstep, vec3 } from 'three/tsl';
import { fbm2, fresnel, type N } from '../engine/materials';
import type { HeroUniforms } from './heroModel';

export interface SculptLookOpts {
  /** Glow living in the surface cracks (cavities from the baked occlusion): 0 none … 1 strong. */
  crackGlow?: number;
  /** World-scale of the colour mottling (higher = finer). */
  mottle?: number;
  /** Rim light gain. */
  rim?: number;
}

/**
 * Material for the sculpted creatures (Void-Root Fiends, the Null's machines). Shares the hero's palette uniforms
 * and per-vertex material weights (`aMat`: armour, glow, dark, blade; skin is the remainder) and adds the
 * field-baked occlusion (`aAO`): cavities darken and take on the creature's vein light, so carved bark cracks,
 * sinew grooves and panel seams read as depth and glow instead of painted stripes.
 */
export function sculptMaterial(u: HeroUniforms, o: SculptLookOpts = {}) {
  const m = new MeshStandardNodeMaterial();
  const mw: N = attribute('aMat', 'vec4');
  const ao: N = attribute('aAO', 'float');
  const wA: N = mw.x, wG: N = mw.y, wD: N = mw.z, wB: N = mw.w;
  const wS: N = clamp(float(1).sub(wA).sub(wG).sub(wD).sub(wB), 0, 1);
  const p: N = positionGeometry;
  const k = o.mottle ?? 2.2;
  const n1: N = fbm2(p.xz.mul(k).add(p.y.mul(k * 0.77)));
  const n2: N = fbm2(p.zy.mul(k * 4.1).add(p.x.mul(3.1)));
  const mott = n1.mul(0.55).add(n2.mul(0.3)).add(0.55);
  const occ = ao.mul(ao);
  const base = u.cSkin.mul(wS).add(u.cArmor.mul(wA)).add(u.cGlow.mul(wG)).add(u.cDark.mul(wD)).add(u.cBlade.mul(wB));
  m.colorNode = base.mul(mott).mul(mix(float(0.28), float(1), occ));
  m.aoNode = mix(float(0.4), float(1), ao);
  m.roughnessNode = clamp(wS.mul(0.5).add(wA.mul(0.62)).add(wG.mul(0.25)).add(wD.mul(0.78)).add(wB.mul(0.14)).add(n2.sub(0.5).mul(0.25)).sub(ao.sub(0.7).mul(0.2)), 0.08, 1);
  m.metalnessNode = wA.mul(0.18).add(wB.mul(0.55)).add(wS.mul(0.04));
  const crack = smoothstep(0.62, 0.3, ao).mul(smoothstep(0.45, 0.7, n2));
  const flow = sin(p.y.mul(6).sub(u.uT.mul(3.4)).add(n1.mul(9))).mul(0.5).add(0.5);
  const pulse = sin(u.uT.mul(1.5 * 6.283).sub(p.y.mul(3))).mul(0.5).add(0.5);
  m.emissiveNode = materialEmissive
    .add(u.cGlow.mul(crack.mul(flow.mul(0.9).add(0.3)).mul((o.crackGlow ?? 0.6) * 1.1).mul(wS.add(wA).add(wD))))
    .add(u.cGlow.mul(wG.mul(pulse.mul(1.4).add(1.1))))
    .add(u.cBlade.mul(wB.mul(0.4)))
    .add(u.cGlow.mul(fresnel(3).mul((o.rim ?? 0.25)).mul(occ)))
    .add(vec3(1, 0.25, 0.35).mul(u.uHurt));
  return m;
}
