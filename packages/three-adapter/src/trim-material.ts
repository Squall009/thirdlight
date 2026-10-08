/**
 * The trim material's nodes (shader type `trim`; the row table is
 * project-model `trim-sheet.ts`).
 *
 * Three texture reads a pixel — albedo, normal, ORM, each once — and
 * nothing else read from memory: grime, wetness and occlusion come from the
 * mesh's COLOR_0 (R occlusion, G grime, B wetness; a mesh without it is
 * clean and dry) and blend into what the three reads gave:
 * - grime covers the albedo with the grime colour and roughens it, the
 *   ORM's crevices (low occlusion) taking it first;
 * - wetness (the vertex's or the material's, the larger, plus the scene's)
 *   darkens the albedo, smooths the surface and flattens the normal map, as
 *   the layered template does;
 * - occlusion darkens the indirect light with the ORM's own.
 *
 * Every read samples with the screen-space derivatives shortened to the
 * sheet's safe footprint (`trimMaxFootprint`): the GPU then never picks a
 * mip level deep enough for a texel to straddle two rows. Textures sample
 * without anisotropy (the engine's default), so the footprint is the level.
 * The texture coordinates are interpolated at the centroid, so a strip that
 * covers only part of a multisampled pixel never reads past its row.
 *
 * The file's own maps (a model's material it starts from) are dropped: the
 * sheet is the only texture set, and three would otherwise read them too.
 */
import { trimMaxFootprint, WET_ALBEDO_SCALE, WET_ROUGHNESS, type TrimSheet } from '@thirdlight/runtime';
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import type { MeshStandardNodeMaterial } from 'three/webgpu';

/** The roughness grime moves toward (dust and soot are matte). */
const GRIME_ROUGHNESS = 0.95;

type Node = ReturnType<typeof TSL.float>;
type Vec4Node = ReturnType<typeof TSL.vec4>;
type Vec2Node = ReturnType<typeof TSL.vec2>;

export interface TrimNodeInputs {
  /** The material's params (`MATERIAL_PARAMS.trim`). */
  readonly params: Readonly<Record<string, number | boolean | string | readonly [number, number]>>;
  /** The row table (absent on a malformed material: the full mip chain, no cap). */
  readonly trim: TrimSheet | undefined;
  /** COLOR_0 as data ((0, 0, 0, 1) without the attribute). */
  readonly vertexData: () => unknown;
  /** The scene's wetness (0–1), shared by every material. */
  readonly sceneWetness: unknown;
}

/** The trim textures a material draws with (set as they load; null: not there yet or none). */
export interface TrimTextures {
  map: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  ormMap: THREE.Texture | null;
}

const numOf = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const colourOf = (v: unknown, d: string): THREE.Color => new THREE.Color(typeof v === 'string' ? v : d);

/**
 * Put the trim nodes on `m` and return the refresh that rebuilds them once
 * a texture arrives (the reads are explicit nodes, so a new texture means new
 * nodes).
 */
export function installTrimNodes(m: THREE.MeshStandardMaterial, input: TrimNodeInputs, textures: TrimTextures): () => void {
  const nm = m as unknown as MeshStandardNodeMaterial;
  const p = input.params;
  // The sheet is the only texture set: the file's maps would be read on top of it.
  m.map = null;
  m.normalMap = null;
  m.roughnessMap = null;
  m.metalnessMap = null;
  m.aoMap = null;
  m.emissiveMap = null;
  m.vertexColors = false;
  // Roughness and metalness scale the ORM's (1: the sheet's own), as three's maps do.
  m.roughness = numOf(p['roughness'], 1);
  m.metalness = numOf(p['metalness'], 1);
  const aoIntensity = TSL.uniform(numOf(p['aoIntensity'], 1));
  const occlusion = TSL.uniform(numOf(p['occlusion'], 1));
  const grimeColour = TSL.uniform(colourOf(p['grimeColor'], '#3b3328'));
  const grime = TSL.uniform(numOf(p['grime'], 1));
  const wetness = TSL.uniform(numOf(p['wetness'], 0));
  const wetFlatten = TSL.uniform(numOf(p['wetFlatten'], 0.7));
  const size = input.trim?.size ?? [1, 1];
  const sheetSize = TSL.uniform(new THREE.Vector2(size[0], size[1]));
  const footprint = TSL.uniform(input.trim !== undefined ? trimMaxFootprint(input.trim) : 1e9);

  const refresh = (): void => {
    // Interpolated at a covered sample (centroid): with MSAA a strip far away covers part of a pixel, and at the
    // pixel's centre outside it v would run past the row's bounds into the neighbours.
    const uv = TSL.varying(TSL.uv(0), 'vTrimUv').setInterpolation('perspective', 'centroid') as unknown as ReturnType<typeof TSL.uv>;
    // The derivatives shortened so their longer one spans at most the safe footprint (in level-0 texels).
    const dx = TSL.dFdx(uv);
    const dy = TSL.dFdy(uv);
    const longest = TSL.max(TSL.length(dx.mul(sheetSize)), TSL.length(dy.mul(sheetSize)));
    const k = TSL.min(TSL.float(1), footprint.div(TSL.max(longest, 1e-6)));
    const gx = dx.mul(k);
    const gy = dy.mul(k);
    const read = (t: THREE.Texture | null): Vec4Node | null => (t === null ? null : (TSL.texture(t, uv).grad(gx, gy) as unknown as Vec4Node));
    const albedo = read(textures.map) ?? TSL.vec4(1, 1, 1, 1);
    // Without an ORM: unoccluded, the roughness and metalness values as they are on a dielectric (no metal).
    const orm = read(textures.ormMap) ?? TSL.vec4(1, 1, 0, 1);
    const normal = read(textures.normalMap);

    const vc = input.vertexData() as Vec4Node;
    const wet = TSL.saturate(TSL.max(vc.b, wetness).add(input.sceneWetness as Node));
    // Crevices first: at the ORM's full occlusion grime counts double.
    const grimeMask = TSL.saturate(vc.g.mul(grime).mul(TSL.float(2).sub(orm.r)));
    const albedoRgb = albedo.rgb.mul(TSL.materialColor.rgb);
    const grimed = TSL.mix(albedoRgb, grimeColour, grimeMask);
    const darkened = grimed.mul(TSL.mix(TSL.float(1), TSL.float(WET_ALBEDO_SCALE), wet));
    nm.colorNode = TSL.vec4(darkened, albedo.a) as unknown as MeshStandardNodeMaterial['colorNode'];
    const rough = TSL.materialRoughness.mul(orm.g);
    nm.roughnessNode = TSL.mix(TSL.mix(rough, TSL.float(GRIME_ROUGHNESS), grimeMask), TSL.float(WET_ROUGHNESS), wet) as unknown as MeshStandardNodeMaterial['roughnessNode'];
    nm.metalnessNode = TSL.materialMetalness.mul(orm.b) as unknown as MeshStandardNodeMaterial['metalnessNode'];
    // three's aoMapIntensity rule (r − 1) × intensity + 1, then the vertex occlusion.
    const sheetAo = orm.r.sub(1).mul(aoIntensity).add(1);
    nm.aoNode = sheetAo.mul(TSL.float(1).sub(TSL.saturate(vc.r.mul(occlusion)))) as unknown as MeshStandardNodeMaterial['aoNode'];
    if (normal === null) {
      nm.normalNode = null;
    } else {
      const scale = (TSL.materialReference('normalScale', 'vec2') as unknown as Vec2Node).mul(TSL.float(1).sub(wet.mul(wetFlatten)));
      const n = TSL.normalMap(normal.xyz, scale);
      (n as unknown as { normalMapType: THREE.NormalMapTypes }).normalMapType = THREE.TangentSpaceNormalMap;
      nm.normalNode = n as unknown as MeshStandardNodeMaterial['normalNode'];
    }
  };
  refresh();
  return refresh;
}
