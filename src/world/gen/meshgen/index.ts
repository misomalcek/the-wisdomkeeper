/**
 * Every generated prototype mesh the world instances, built in two batches (in a worker when available): the flora
 * and stone set first (trees per species × seeded variant × level of detail, boulders, hoodoos, crystal clusters),
 * then the fractal landmark formations and the Atlas Stations, which take longer. Keys are strings ("tree:canopy:1:0"), so the main thread
 * creates its instanced pools before the meshes arrive.
 */
import type { MeshArrays } from './geo';
import { TREE_LODS, TREE_SPECIES, buildTree, buildTuft } from './trees';
import { buildBoulder, buildCrystalCluster, buildHoodoo } from './rocks';
import { FORMATIONS, buildFormation } from './fractals';
import { STATIONS, buildStation } from './stations';

export type ProtoSet = Record<string, MeshArrays>;
export const TREE_VARIANTS = 3;
export const BOULDER_VARIANTS = 4;
export const HOODOO_VARIANTS = 3;
export const CRYSTAL_VARIANTS = 4;
export const TUFT_VARIANTS = 3;
export const treeKey = (species: string, variant: number, lod: number) => `tree:${species}:${variant}:${lod}`;
export const boulderKey = (v: number, lod: number) => `boulder:${v}:${lod}`;
export const hoodooKey = (v: number, lod: number) => `hoodoo:${v}:${lod}`;
export const crystalKey = (v: number) => `crystal:${v}`;
export const formKey = (i: number, lod: number) => `form:${i}:${lod}`;
export const tuftKey = (v: number) => `tuft:${v}`;
export const stationKey = (i: number, lod: number) => `station:${i}:${lod}`;

export function buildFloraSet(): ProtoSet {
  const out: ProtoSet = {};
  TREE_SPECIES.forEach((sp, si) => {
    for (let v = 0; v < TREE_VARIANTS; v++) {
      for (let l = 0; l < TREE_LODS.length; l++) out[treeKey(sp.name, v, l)] = buildTree(sp, 0x7ee + si * 977 + v * 131, TREE_LODS[l]);
    }
  });
  for (let v = 0; v < BOULDER_VARIANTS; v++) {
    out[boulderKey(v, 0)] = buildBoulder(0xb01d + v * 71, 22);
    out[boulderKey(v, 1)] = buildBoulder(0xb01d + v * 71, 11);
  }
  for (let v = 0; v < HOODOO_VARIANTS; v++) {
    out[hoodooKey(v, 0)] = buildHoodoo(0x400d + v * 53, 22);
    out[hoodooKey(v, 1)] = buildHoodoo(0x400d + v * 53, 12);
  }
  for (let v = 0; v < CRYSTAL_VARIANTS; v++) out[crystalKey(v)] = buildCrystalCluster(0xc4 + v * 37);
  for (let v = 0; v < TUFT_VARIANTS; v++) out[tuftKey(v)] = buildTuft(0x7f + v * 13);
  return out;
}

export function buildFormationSet(): ProtoSet {
  const out: ProtoSet = {};
  FORMATIONS.forEach((f, i) => {
    out[formKey(i, 0)] = buildFormation(f, 56);
    out[formKey(i, 1)] = buildFormation(f, 30);
  });
  // Atlas Stations: domes and gridshells analysed and sized by the truss solver, then meshed (real metres)
  STATIONS.forEach((s, i) => {
    out[stationKey(i, 0)] = buildStation(s, 0);
    out[stationKey(i, 1)] = buildStation(s, 1);
  });
  return out;
}

export const buildProtoSet = (): ProtoSet => ({ ...buildFloraSet(), ...buildFormationSet() });
