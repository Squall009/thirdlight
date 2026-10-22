/**
 * Fading by a per-pixel dither: a pixel is discarded where a screen-space
 * threshold is below the fade, so an opaque material thins to a stipple
 * without sorting, blending or a program per fade value. The fade is a
 * uniform (per object, per view …); the keep test is ANDed into the
 * material's `maskNode`, which every node material kind honours (standard,
 * trim, layered surface, graph, terrain, skinned, instanced, decals).
 *
 * Every fade compares with the one threshold pattern ({@link ditherThreshold}),
 * so several keep terms ANDed into one mask thin a pixel as the largest of
 * their fades would (`t >= a && t >= b` is `t >= max(a, b)`), never more.
 *
 * Three ways to wear a fade:
 * - in place: {@link andMask} a keep term into a material when it is made
 *   (its program then holds the term for good; a fade of 0 keeps every pixel);
 * - as a variant: {@link FadeVariants} makes one masked copy per source
 *   material (again only when the source changes), held by the meshes that
 *   draw it, for fades that must leave the source's own program alone;
 * - at build, for every material a renderer draws: see-through
 *   (`see-through.ts`) adds its keep term where three builds each program,
 *   for the renderers a view armed (the shadow pass's material never).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { LIGHT_LAYERS_KEY } from './light-layers';
import { DECAL_LAYERS_KEY } from './projected-decals';
import { SEE_THROUGH_KEY } from './see-through';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { uniform, screenCoordinate, vec2, float } = TSL;

/** The screen-space threshold every fade compares with (interleaved gradient noise, 0 … 1 per pixel). */
export const ditherThreshold: N = float(52.9829189).mul(screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715)).fract()).fract();

/** Keep a pixel while the threshold is at least `fade` (0 every pixel kept … 1 every pixel gone). */
export function ditherKeep(fade: N): N {
  return ditherThreshold.greaterThanEqual(fade);
}

/** A fade read from each drawn object's `userData[key]` (absent: 0), set per draw: one node serves every object. */
export function objectFade(key: string): N {
  return uniform(0).onObjectUpdate(({ object }: { object: THREE.Object3D }) => (object.userData[key] as number | undefined) ?? 0);
}

/**
 * AND a keep term into a node material's mask, keeping its own. It changes
 * the material's program: do it where the material is made, never per fade
 * value (the value is the term's uniform).
 */
export function andMask(material: THREE.NodeMaterial, keep: N): void {
  const m = material as { maskNode?: N };
  const own = m.maskNode;
  m.maskNode = own !== null && own !== undefined ? TSL.bool(own).and(keep) : keep;
  material.needsUpdate = true;
}

/** The node material class three draws a classic material with. */
const NODE_CLASSES: Record<string, new () => THREE.NodeMaterial> = {
  MeshBasicMaterial: THREE.MeshBasicNodeMaterial,
  MeshLambertMaterial: THREE.MeshLambertNodeMaterial,
  MeshPhongMaterial: THREE.MeshPhongNodeMaterial,
  MeshStandardMaterial: THREE.MeshStandardNodeMaterial,
  MeshPhysicalMaterial: THREE.MeshPhysicalNodeMaterial,
  MeshToonMaterial: THREE.MeshToonNodeMaterial,
  MeshMatcapMaterial: THREE.MeshMatcapNodeMaterial,
  MeshNormalMaterial: THREE.MeshNormalNodeMaterial,
};

/** Keys never carried to a copy: its identity, listeners and version are its own. */
const OWN_KEYS = new Set(['uuid', 'id', '_listeners', 'version']);

/** A node material of its own that draws as `src` does (null: a material three draws no node material for). */
export function nodeMaterialCopy(src: THREE.Material): THREE.NodeMaterial | null {
  if ((src as { isNodeMaterial?: boolean }).isNodeMaterial === true) return (src as THREE.NodeMaterial).clone();
  const Cls = NODE_CLASSES[src.type];
  if (Cls === undefined) return null;
  const v = new Cls();
  // As three converts a classic material for its node renderer (every field taken over).
  for (const key in src) if (!OWN_KEYS.has(key)) (v as unknown as Record<string, unknown>)[key] = (src as unknown as Record<string, unknown>)[key];
  v.userData = { ...src.userData };
  return v;
}

/** `src` with `keep` ANDed into its mask, named `<src> (<label>)` (null: a material three draws no node material for). */
export function fadeVariant(src: THREE.Material, keep: N, label: string): THREE.NodeMaterial | null {
  const v = nodeMaterialCopy(src);
  if (v === null) return null;
  andMask(v, keep);
  v.name = `${src.name} (${label})`;
  return v;
}

interface Variant<U> {
  version: number;
  variant: THREE.Material | null;
  readonly users: Set<U>;
}

/**
 * One fade variant per source material, made once (again only after the
 * source itself changed) and held by its users; it is disposed with the
 * last of them, so no fade makes a material per frame or per fade.
 */
export class FadeVariants<U> {
  private readonly variants = new Map<THREE.Material, Variant<U>>();
  private readonly held = new Map<U, THREE.Material>();

  constructor(private readonly make: (src: THREE.Material) => THREE.Material | null) {}

  /**
   * `user` holds the variant of `src` (dropping any other it held). `made`:
   * the variant is new (made now, or again for a changed source), so it has
   * not been compiled yet. Null variant: `src` cannot fade.
   */
  hold(user: U, src: THREE.Material): { variant: THREE.Material | null; made: boolean } {
    let known = this.variants.get(src);
    let made = false;
    if (known !== undefined && known.version !== src.version) {
      known.variant?.dispose();
      known.variant = this.make(src);
      known.version = src.version;
      made = true;
    }
    if (known === undefined) {
      this.variants.set(src, (known = { version: src.version, variant: this.make(src), users: new Set() }));
      made = true;
    }
    if (this.held.get(user) !== src) {
      this.release(user);
      this.held.set(user, src);
      known.users.add(user);
    }
    return { variant: known.variant, made };
  }

  /** `user` lets go of its variant (disposed if it was the last holder). */
  release(user: U): void {
    const src = this.held.get(user);
    if (src === undefined) return;
    this.held.delete(user);
    const v = this.variants.get(src);
    if (v === undefined) return;
    v.users.delete(user);
    if (v.users.size > 0) return;
    v.variant?.dispose();
    this.variants.delete(src);
  }

  /** Variants alive (diagnostics, tests). */
  get size(): number {
    return this.variants.size;
  }

  dispose(): void {
    for (const v of this.variants.values()) v.variant?.dispose();
    this.variants.clear();
    this.held.clear();
  }
}

/**
 * A mesh drawing `mesh`'s geometry with `material` where `mesh` is, casting
 * no shadow and lit as `mesh` (its light and decal layers, its see-through opt-out): a fade's copy
 * over the mesh, or a compile probe of a variant. Placed once; the caller
 * keeps it where the mesh is.
 */
export function fadeCopy(mesh: THREE.Mesh, material: THREE.Material, name: string): THREE.Mesh {
  const copy = new THREE.Mesh(mesh.geometry, material);
  copy.name = name;
  copy.castShadow = false;
  copy.receiveShadow = mesh.receiveShadow;
  copy.frustumCulled = mesh.frustumCulled;
  copy.renderOrder = mesh.renderOrder;
  const ll = mesh.userData[LIGHT_LAYERS_KEY] as number | undefined;
  if (ll !== undefined) copy.userData[LIGHT_LAYERS_KEY] = ll;
  const dl = mesh.userData[DECAL_LAYERS_KEY] as number | undefined;
  if (dl !== undefined) copy.userData[DECAL_LAYERS_KEY] = dl;
  if (mesh.userData[SEE_THROUGH_KEY] === false) copy.userData[SEE_THROUGH_KEY] = false;
  copy.matrixAutoUpdate = false;
  copy.matrixWorldAutoUpdate = false;
  copy.matrixWorld.copy(mesh.matrixWorld);
  return copy;
}
