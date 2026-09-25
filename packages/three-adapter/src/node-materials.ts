/**
 * Phase 17.2: the node-material (TSL) side of the project shading, used when
 * the renderer is three's `WebGPURenderer` (its WebGPU and WebGL 2 backends).
 * `WebGPURenderer` ignores `onBeforeCompile`/`customProgramCacheKey`, so every
 * shader hook of the legacy path has a node equivalent here:
 *
 * - `toNodeMaterial`: the node-material version of a plain three material
 *   (same values; what `WebGPURenderer` would convert it to, but as an object
 *   we own so node hooks can go on it).
 * - `withoutAmbientLight`: a lightmapped copy whose bake holds the ambient /
 *   hemisphere light ignores those lights (the legacy no-ambient hook).
 * - `cloneMaterial`: a per-mesh copy that keeps the hooks (both kinds).
 * - `instanceOrigin`: the instance's translation in an `InstancedMesh`
 *   (the kit's world-X UV shift works per instance).
 * - `setEmissiveLook` / `setSelectionHighlight`: the checkpoint glow and the
 *   editor's selection tint — per-mesh overrides that never change a shared
 *   project material (phase 9.4 rule).
 *
 * Pure three.js (`three/webgpu`, `three/tsl`); nothing here needs a GPU until
 * a renderer builds the nodes.
 */
import * as THREE from 'three';
import { buffer, Fn, instancedBufferAttribute, instanceIndex, mat4, OnBeforeFrameUpdate, vec3, vec4 } from 'three/tsl';
import {
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshPhongNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  MeshToonNodeMaterial,
  type NodeBuilder,
} from 'three/webgpu';

type AnyNodeMaterial = THREE.Material & { isNodeMaterial?: boolean };

/** True for a node material (three's `isNodeMaterial`). */
export function isNodeMaterial(m: unknown): boolean {
  return (m as AnyNodeMaterial | null)?.isNodeMaterial === true;
}

/**
 * The node-material classes for the plain materials the project uses, with
 * the plain class whose `copy` carries the values over (the node classes
 * have the same properties).
 */
const NODE_CLASSES: readonly [string, new () => THREE.Material, (target: THREE.Material, source: THREE.Material) => void][] = [
  ['MeshPhysicalMaterial', MeshPhysicalNodeMaterial as unknown as new () => THREE.Material, (t, s) => THREE.MeshPhysicalMaterial.prototype.copy.call(t as THREE.MeshPhysicalMaterial, s as THREE.MeshPhysicalMaterial)],
  ['MeshStandardMaterial', MeshStandardNodeMaterial as unknown as new () => THREE.Material, (t, s) => THREE.MeshStandardMaterial.prototype.copy.call(t as THREE.MeshStandardMaterial, s as THREE.MeshStandardMaterial)],
  ['MeshLambertMaterial', MeshLambertNodeMaterial as unknown as new () => THREE.Material, (t, s) => THREE.MeshLambertMaterial.prototype.copy.call(t as THREE.MeshLambertMaterial, s as THREE.MeshLambertMaterial)],
  ['MeshPhongMaterial', MeshPhongNodeMaterial as unknown as new () => THREE.Material, (t, s) => THREE.MeshPhongMaterial.prototype.copy.call(t as THREE.MeshPhongMaterial, s as THREE.MeshPhongMaterial)],
  ['MeshToonMaterial', MeshToonNodeMaterial as unknown as new () => THREE.Material, (t, s) => THREE.MeshToonMaterial.prototype.copy.call(t as THREE.MeshToonMaterial, s as THREE.MeshToonMaterial)],
  ['MeshBasicMaterial', MeshBasicNodeMaterial as unknown as new () => THREE.Material, (t, s) => THREE.MeshBasicMaterial.prototype.copy.call(t as THREE.MeshBasicMaterial, s as THREE.MeshBasicMaterial)],
];

/**
 * A node material with `material`'s values (a new object; the textures are
 * shared). A node material is cloned. Null for a material type without a
 * node version here (it keeps three's automatic conversion).
 */
export function toNodeMaterial(material: THREE.Material): THREE.Material | null {
  if (isNodeMaterial(material)) return cloneMaterial(material);
  const row = NODE_CLASSES.find(([type]) => material.type === type);
  if (row === undefined) return null;
  const m = new row[1]();
  row[2](m, material);
  return m;
}

/** The standard node material for a (plain or node) standard source, keeping a physical source physical. */
export function standardNodeMaterialFrom(source: THREE.Material | null): MeshStandardNodeMaterial {
  if (source !== null && (source as THREE.MeshStandardMaterial).isMeshStandardMaterial === true) {
    const m = toNodeMaterial(source);
    if (m !== null) return m as unknown as MeshStandardNodeMaterial;
  }
  return new MeshStandardNodeMaterial();
}

const NO_AMBIENT_KEY = 'tl-lightmap-no-ambient';
const OWN_HOOKS = ['setupLighting', 'customProgramCacheKey', 'onBeforeCompile'] as const;

interface LightsNodeLike {
  getLights(): THREE.Light[];
}
interface BuilderLightsLike {
  lightsNode: LightsNodeLike | null;
  renderer: { lighting: { createNode(lights: THREE.Light[]): LightsNodeLike } };
}

/**
 * The node version of the lightmap's no-ambient hook: while this material
 * builds its lighting, the scene's ambient and hemisphere lights are left out
 * (the bake holds them). The program cache key says so, or three would share
 * the program of an identical material that keeps them.
 */
export function withoutAmbientLight(material: THREE.Material): void {
  const m = material as THREE.Material & { setupLighting: (builder: NodeBuilder) => unknown };
  const base = m.setupLighting;
  const baseKey = m.customProgramCacheKey;
  m.setupLighting = function setupLightingWithoutAmbient(builder: NodeBuilder) {
    const b = builder as unknown as BuilderLightsLike;
    const all = b.lightsNode;
    if (all === null || all === undefined) return base.call(this, builder);
    const kept = all.getLights().filter((l) => (l as THREE.AmbientLight).isAmbientLight !== true && (l as THREE.HemisphereLight).isHemisphereLight !== true);
    b.lightsNode = b.renderer.lighting.createNode(kept);
    try {
      return base.call(this, builder);
    } finally {
      b.lightsNode = all;
    }
  };
  m.customProgramCacheKey = function cacheKeyWithoutAmbient() {
    return `${baseKey.call(this)}|${NO_AMBIENT_KEY}`;
  };
}

/**
 * `material.clone()` keeping the instance's own hooks: `Material.clone()`
 * drops them (the legacy project shaders and the no-ambient hook live there).
 */
export function cloneMaterial<T extends THREE.Material>(material: T): T {
  const c = material.clone() as T;
  const src = material as unknown as Record<string, unknown>;
  const dst = c as unknown as Record<string, unknown>;
  for (const hook of OWN_HOOKS) {
    if (Object.prototype.hasOwnProperty.call(src, hook)) dst[hook] = src[hook];
  }
  return c;
}

/** Copy `source`'s values onto `copy` keeping `copy`'s own hooks (a lightmapped copy follows its source). */
export function copyMaterialKeepingHooks(copy: THREE.Material, source: THREE.Material): void {
  const dst = copy as unknown as Record<string, unknown>;
  const own = OWN_HOOKS.filter((h) => Object.prototype.hasOwnProperty.call(dst, h)).map((h) => [h, dst[h]] as const);
  if (isNodeMaterial(copy) && !isNodeMaterial(source)) {
    const row = NODE_CLASSES.find(([type]) => source.type === type);
    if (row !== undefined) row[2](copy, source);
  } else copy.copy(source);
  for (const [h, v] of own) dst[h] = v;
}

// ---- the instance origin (kit world-X UV per instance) -------------------------------

const interleavedMatrices = new WeakMap<THREE.InstancedBufferAttribute, THREE.InstancedInterleavedBuffer>();

/**
 * The instance's translation (object space) when the mesh drawn is an
 * `InstancedMesh`, else (0,0,0). Reads the instance matrices the way three's
 * instancing does (a uniform buffer while they fit, else an instanced
 * attribute kept in step with the matrices), so moving an instance moves its
 * UV shift. Vertex stage.
 */
export const instanceOrigin = Fn((builder: NodeBuilder) => {
  const o = (builder as unknown as { object: THREE.Object3D }).object as THREE.InstancedMesh;
  const im = o !== null && o !== undefined && o.isInstancedMesh === true ? o.instanceMatrix : null;
  if (im === null || im.isInstancedBufferAttribute !== true) return vec3(0, 0, 0);
  const count = Math.max(im.count, 1);
  const limit = (builder as unknown as { getUniformBufferLimit(): number }).getUniformBufferLimit();
  if (count * 16 * 4 <= limit) {
    const matrices = buffer(im.array as Float32Array, 'mat4', count) as unknown as { element(i: unknown): ReturnType<typeof mat4> };
    return matrices.element(instanceIndex).mul(vec4(0, 0, 0, 1)).xyz;
  }
  let ib = interleavedMatrices.get(im);
  if (ib === undefined) {
    ib = new THREE.InstancedInterleavedBuffer(im.array as Float32Array, 16, 1);
    interleavedMatrices.set(im, ib);
  }
  const shared = ib;
  OnBeforeFrameUpdate(() => {
    if (shared.version !== im.version) shared.version = im.version;
  });
  return (instancedBufferAttribute(shared as unknown as THREE.InstancedBufferAttribute, 'vec4', 16, 12) as unknown as ReturnType<typeof vec4>).xyz;
});

// ---- per-mesh looks (never a shared material) ---------------------------------------

/** The selection tint of the editor's Scene view (emissive, on the entity's own material). */
export const SELECTION_HIGHLIGHT_EMISSIVE = 0x2a4a80;

type EmissiveCapable = THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number };

/**
 * The selection tint on a mesh's own (unshared) material: emissive on or
 * back to none. Works on both renderers (the node renderer reads `emissive`
 * each frame).
 */
export function setSelectionHighlight(material: THREE.Material | THREE.Material[] | undefined, on: boolean): void {
  if (material === undefined || Array.isArray(material)) return;
  const m = material as EmissiveCapable;
  if (m.emissive !== undefined) m.emissive.setHex(on ? SELECTION_HIGHLIGHT_EMISSIVE : 0x000000);
}

/** The key the library marks meshes with while a project material is on them. */
const SOURCE_KEY = '__tlSourceMaterial';
const OWN_KEY = '__tlOwnMaterial';

/**
 * An emissive look on every mesh under `root` (the checkpoint glow), or back
 * to each material's own emissive (`look` null). A mesh wearing a shared
 * project material first gets its own copy (hooks included), so no other
 * mesh glows.
 */
export function setEmissiveLook(root: THREE.Object3D, look: { emissive: string; emissiveIntensity: number } | null): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh === true && mesh.userData[SOURCE_KEY] !== undefined && mesh.userData[OWN_KEY] !== true && !Array.isArray(mesh.material)) {
      mesh.material = cloneMaterial(mesh.material);
      mesh.userData[OWN_KEY] = true;
    }
    const mat = mesh.material as EmissiveCapable | EmissiveCapable[] | undefined;
    if (mat === undefined || Array.isArray(mat) || mat.emissive === undefined) return;
    if (mat.userData['baseEmissive'] === undefined) {
      mat.userData['baseEmissive'] = mat.emissive.getHex();
      mat.userData['baseEmissiveIntensity'] = mat.emissiveIntensity ?? 1;
    }
    if (look === null) {
      mat.emissive.setHex(mat.userData['baseEmissive'] as number);
      mat.emissiveIntensity = mat.userData['baseEmissiveIntensity'] as number;
    } else {
      mat.emissive.set(look.emissive);
      mat.emissiveIntensity = look.emissiveIntensity;
    }
  });
}
