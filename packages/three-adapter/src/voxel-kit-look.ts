/**
 * What a voxel kit's pieces wear: the kit's one texture set (owner B5), read
 * from its pieces' GLB material, the way an artist's export carries it —
 * base colour, normal map, occlusion / roughness / metalness (glTF's
 * channels: occlusion R, roughness G, metal B) and their factors. A model
 * import extracts the file's images into KTX2 texture assets (streamed by
 * mip, counted in the texture budget); the loader draws those in their
 * place, so a kit's sheet is a texture like any model's.
 *
 * - **A kit with a trim layout** (a named one or its own `sheetLayout`)
 *   samples every map at the world-anchored U (`voxel-trim-u.ts`): the
 *   strips run on from piece to piece along the world. The normal map's
 *   tangent frame is made from that U's screen derivatives (as three does
 *   for a mesh without tangents, from its own UV), so a run drawn with U
 *   growing the other way (a mirrored or turned piece) is lit the right way
 *   round.
 * - **A kit without a layout** keeps its authored UVs (own bakes, sculpted
 *   pieces): the material as three's GLTFLoader made it, node-built.
 * - **A kit whose material has no image** draws a stand-in colour a kit;
 *   the labelled debug sets (`voxelKitDebugTexture`, a layout's
 *   `trimDebugTexture`) draw only when the page asks for them.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';
import { cameraRelative } from './camera-relative';
import { pieceWetLook, trimRunUv } from './voxel-trim-u';

const { float, materialColor, materialNormal, materialRoughness, mix, normalView, positionView, texture, uniform, vec3 } = TSL;

/** The parts of a GLB material a kit piece draws: its maps (null: none) and factors. */
export interface VoxelKitLook {
  readonly map: THREE.Texture | null;
  readonly normalMap: THREE.Texture | null;
  readonly roughnessMap: THREE.Texture | null;
  readonly metalnessMap: THREE.Texture | null;
  readonly aoMap: THREE.Texture | null;
  readonly color: THREE.Color;
  readonly roughness: number;
  readonly metalness: number;
  /** As three's GLTFLoader set it (its y negated for a mesh without tangents: glTF's V runs down). */
  readonly normalScale: THREE.Vector2;
  readonly aoMapIntensity: number;
}

/** The textures a look samples (each once). */
export function kitLookTextures(look: VoxelKitLook): THREE.Texture[] {
  return [...new Set([look.map, look.normalMap, look.roughnessMap, look.metalnessMap, look.aoMap].filter((t): t is THREE.Texture => t !== null))];
}

/** The look of a GLB material, or null when it has no image (a placeholder material: the kit draws its stand-in). */
export function kitLookOf(material: THREE.Material): VoxelKitLook | null {
  const m = material as Partial<THREE.MeshStandardMaterial>;
  const look: VoxelKitLook = {
    map: m.map ?? null,
    normalMap: m.normalMap ?? null,
    roughnessMap: m.roughnessMap ?? null,
    metalnessMap: m.metalnessMap ?? null,
    aoMap: m.aoMap ?? null,
    color: m.color?.clone() ?? new THREE.Color(0xffffff),
    roughness: m.roughness ?? 1,
    metalness: m.metalness ?? 0,
    normalScale: m.normalScale?.clone() ?? new THREE.Vector2(1, 1),
    aoMapIntensity: m.aoMapIntensity ?? 1,
  };
  return kitLookTextures(look).length === 0 ? null : look;
}

/**
 * The material a kit's pieces draw with: its look as a lit node material placed camera-relative; `trim`: every
 * map read at the world-anchored U of the pieces' run faces (the draw gives each instance its `pieceU`). Each
 * piece wears its cell's wetness as the voxel surface does: darker, smoother, its normal detail flatter.
 */
export function kitLookMaterial(look: VoxelKitLook, trim: boolean): THREE.Material {
  const m = new MeshStandardNodeMaterial({ color: look.color, roughness: look.roughness, metalness: look.metalness });
  const wet = pieceWetLook();
  if (!trim) {
    if (look.map !== null) m.map = look.map;
    if (look.normalMap !== null) {
      m.normalMap = look.normalMap;
      m.normalScale.copy(look.normalScale);
    }
    if (look.roughnessMap !== null) m.roughnessMap = look.roughnessMap;
    if (look.metalnessMap !== null) m.metalnessMap = look.metalnessMap;
    if (look.aoMap !== null) {
      m.aoMap = look.aoMap;
      m.aoMapIntensity = look.aoMapIntensity;
    }
    // The material's own colour, roughness and normal (its maps at the authored UV), as wetness changes them.
    m.colorNode = materialColor.mul(wet.albedo);
    m.roughnessNode = materialRoughness.mul(wet.roughness);
    if (look.normalMap !== null) m.normalNode = mix(materialNormal, normalView, wet.flatten).normalize();
    return cameraRelative(m);
  }
  const st = trimRunUv();
  // The maps stay on the material for whoever reads which textures it draws; the nodes are what sample them.
  if (look.map !== null) m.map = look.map;
  m.colorNode = (look.map !== null ? texture(look.map, st).mul(uniform(look.color)) : uniform(look.color)).mul(wet.albedo);
  if (look.roughnessMap !== null) m.roughnessMap = look.roughnessMap;
  m.roughnessNode = (look.roughnessMap !== null ? texture(look.roughnessMap, st).g.mul(look.roughness) : float(look.roughness)).mul(wet.roughness);
  if (look.metalnessMap !== null) {
    m.metalnessMap = look.metalnessMap;
    m.metalnessNode = texture(look.metalnessMap, st).b.mul(look.metalness);
  }
  if (look.aoMap !== null) {
    m.aoMap = look.aoMap;
    m.aoNode = float(1).add(texture(look.aoMap, st).r.sub(1).mul(look.aoMapIntensity));
  }
  if (look.normalMap !== null) {
    m.normalMap = look.normalMap;
    // The tangent frame from the run U's screen derivatives (three's frame for a mesh without tangents, read from
    // the U the maps are sampled at, not the authored one).
    const q0 = positionView.dFdx();
    const q1 = positionView.dFdy();
    const st0 = st.dFdx();
    const st1 = st.dFdy();
    const n = normalView;
    const q1perp = q1.cross(n);
    const q0perp = n.cross(q0);
    const t = q1perp.mul(st0.x).add(q0perp.mul(st1.x));
    const b = q1perp.mul(st0.y).add(q0perp.mul(st1.y));
    const det = t.dot(t).max(b.dot(b));
    const scale = det.equal(0).select(float(0), det.inverseSqrt());
    const tex = texture(look.normalMap, st).xyz.mul(2).sub(1);
    const tn = vec3(tex.x.mul(look.normalScale.x), tex.y.mul(look.normalScale.y), tex.z);
    m.normalNode = mix(t.mul(scale).mul(tn.x).add(b.mul(scale).mul(tn.y)).add(n.mul(tn.z)).normalize(), n, wet.flatten).normalize();
  }
  return cameraRelative(m);
}
