/**
 * Projected decals, drawn in the receiving material: a lit node material
 * blends the decals over its pixel into its own surface before it is lit,
 * channel by channel (albedo, normal, roughness, metalness, occlusion,
 * emission), so a wet patch changes roughness only and a crack the normal
 * only, and the light, probes, shadows and rooms stay the surface's own.
 * three.js r186 has no decal buffer, and a depth-normal prepass would draw
 * everything twice on frames that are bound by draws.
 *
 * Only an object a decal can reach draws with the decals: its draw wears a
 * variant of its material (`decalVariant`, swapped in per draw as the
 * local-light modes are, the material itself untouched) whose program has
 * the decal steps; every other object keeps the program it had. So a scene
 * without projected decals builds exactly the programs it built before, a
 * decal placed in the editor builds programs only for what it touches, and
 * an object far from every decal pays nothing per pixel. An object can be
 * reached when its bounds meet a decal's box and its decal layers share one
 * with that decal's (`ProjectedDecals.hits`, on the CPU, kept per object
 * until it or the decals move).
 *
 * The material setup steps (`setupDiffuseColor`, `setupAmbientOcclusion`,
 * `setupVariants` of the standard model, `setupNormal`, `setupLighting`,
 * patched once on three's prototypes) do the blending for a variant and are
 * three's own for everything else.
 *
 * Per pixel (`evaluate`): the pixel's cell of the world grid index
 * (decal-index.ts) lists the decals reaching into it, lowest sort order
 * first; a pixel in a cell under none reads one slot of its hash table
 * (nearly always) and branches. For each
 * listed decal the pixel is tested against its box, the receiver's decal
 * layers (a per-object uniform, as light layers are: no program per mask)
 * and the normal fade; then the edge and distance fades, and its images are
 * read with gradients from the world position's derivatives (correct mips
 * inside the loop), each read's footprint capped at the rectangle's safe
 * level. The channels are composited front to back as `over`:
 * value × (1 − a) + decal × a per channel, `a` the image's alpha × the
 * material's opacity × the channel's opacity × the fades.
 *
 * The normal: the decal's tangent-space normal in a frame built from the
 * surface's facing and the projector's X axis, as a bend from the surface
 * normal, added to the material's own normal (so a crack stays on a
 * normal-mapped wall). The surface's facing is the triangle's (derivatives
 * of the world position, turned to the camera): it is the same for blocks,
 * terrain whose heights come per pixel, generated walls, props, instance
 * copies and merged cells, whose vertex normals may say otherwise.
 *
 * Mesh decal materials (mesh-decals.ts) take no projected decal: they are
 * marks themselves. Unlit materials have nothing to light.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { DECAL_FADE, DECAL_LAYERS_ALL } from '@thirdlight/runtime';

import { DECAL_HASH, DECAL_ROW_TEXELS, DECAL_TEXTURE_WIDTH } from './decal-index';
import type { N } from './effects-tsl';
import { isLit } from './local-lights';
import { makeMaterialVariant, renderCallOf, syncMaterialVariant } from './material-variant';
import { texelTexture, untransformedTexture } from './texel-texture-node';
import { decalDrawOf } from './mesh-decals';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Break, If, Loop, abs, cameraPosition, cameraViewMatrix, cross, dFdx, dFdy, dot, float, int, ivec2, length, max, min, normalize, saturate, select, smoothstep, uint, uniform, uvec3, ivec3, vec2, vec3, vec4, positionView, cameraWorldMatrix, renderGroup } = TSL;
const { diffuseColor, metalness, roughness, ambientOcclusion, diffuseContribution } = TSL;

/** `object.userData[DECAL_LAYERS_KEY]`: the decal layers a drawable is in (absent: every layer; a skinned mesh none). */
export const DECAL_LAYERS_KEY = '__tlDecalLayers';

/**
 * `mesh.userData[DECAL_SURFACE_KEY]`: a level surface clipped decals may be cut from (a block chunk's, a
 * generated architecture chunk's or a spline's mesh; placed models and boxes are known by their batch mark).
 * Terrain carries none: its levels of detail change the surface with distance, so it takes projected decals.
 */
export const DECAL_SURFACE_KEY = '__tlDecalSurface';

/** The decal layers a drawable is in. */
export function objectDecalLayers(o: THREE.Object3D): number {
  const v = o.userData[DECAL_LAYERS_KEY] as number | undefined;
  if (v !== undefined) return v;
  return (o as THREE.SkinnedMesh).isSkinnedMesh === true ? 0 : DECAL_LAYERS_ALL;
}

/** Put `mask` on every mesh under `root` (absent: the key is removed, the default applies). Returns whether any changed. */
export function applyObjectDecalLayers(root: THREE.Object3D, mask: number | undefined): boolean {
  let changed = false;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true) return;
    if (o.userData[DECAL_LAYERS_KEY] === mask) return;
    changed = true;
    if (mask === undefined) delete o.userData[DECAL_LAYERS_KEY];
    else o.userData[DECAL_LAYERS_KEY] = mask;
  });
  return changed;
}

/** A component's `decalLayers` as the renderer keeps it (undefined: absent or not a mask; the default applies). */
export function decalLayersField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DECAL_LAYERS_ALL ? v : undefined;
}

/** The `decalLayers` an entity's drawables carry: its box, model, instance set or terrain's (undefined: absent). */
export function decalLayersOfComponents(components: unknown): number | undefined {
  const c = components as Record<string, { decalLayers?: unknown } | undefined> | undefined;
  return decalLayersField((c?.['box'] ?? c?.['model'] ?? c?.['instances'] ?? c?.['terrain'])?.decalLayers);
}

/**
 * Each texture the light binds gets a version no other had: three's WebGL 2
 * backend rebinds a texture node's new texture only when its version differs
 * from the old one's (probe-atlas.ts says the same). Placeholders and data
 * textures count from far above any decoded texture's few updates.
 */
let textureVersion = 1_000_000;
function fresh<T extends THREE.Texture>(tex: T): T {
  tex.needsUpdate = true;
  tex.version = Math.max(tex.version, ++textureVersion);
  return tex;
}

/** A float RGBA data texture read texel by texel (`load`). */
export function decalDataTexture(data: Float32Array, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, DECAL_TEXTURE_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return fresh(tex);
}

/** A one-texel page array standing in for a set no decal has an image in (never read: its decals' layers are −1). */
function placeholderPages(colour: boolean): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 1);
  tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  return fresh(tex);
}

export type DecalPageSetName = 'albedo' | 'normal' | 'orm';

/** The side of the coarse grid that finds the decals near an object's bounds (m). */
const HIT_CELL = 8;
/** An object (or a decal) spanning more coarse cells than this is tested against every decal box (every object) instead. */
const HIT_CELLS_MAX = 512;
/** The decal changes an object's kept test is brought up to date through (more: it is tested again). */
const HIT_CHANGES_MAX = 128;
/** The changes kept for bringing objects' tests up to date (older ones: tested again). */
const HIT_LOG_MAX = 256;

/** What an object is tested against: a decal's world box and the layers it marks. */
export interface DecalHitBox {
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly layerMask: number;
}

let nextId = 1;

/**
 * The projected decals of a scene: the data texture (table, then index), the
 * page arrays and the grid's placement the receiving materials read, and the
 * decals' boxes the CPU tests objects against. The host
 * (decal-projectors.ts) fills them and attaches them to its scene
 * ({@link attachProjectedDecals}).
 */
export class ProjectedDecals {
  readonly id = nextId++;
  /** The table's lines, then the index's (`indexBase` texels in). */
  data: THREE.DataTexture = decalDataTexture(new Float32Array(DECAL_TEXTURE_WIDTH * 4), 1);
  pages: Record<DecalPageSetName, THREE.Texture> = { albedo: placeholderPages(true), normal: placeholderPages(false), orm: placeholderPages(false) };
  private readonly placeholders = { ...this.pages };
  /** The grid's corner and (w) the hash table's mask; 1 / its cell size and (w) the longest probe; (x) where the index starts in the data, (y) the pages' side. */
  readonly origin = new THREE.Vector4();
  readonly invCell = new THREE.Vector4();
  readonly layout = new THREE.Vector4(0, 1, 0, 0);
  /**
   * Counts the swaps of a bound texture (pages arrived, data grown) and of
   * what the programs blend. It is part of the variants' program key: three's
   * WebGL 2 backend binds a texture node's new texture only for a new program
   * state.
   */
  generation = 0;
  /** The channels the decals change, the page sets they read ({@link DECAL_CHANNEL_BITS}) and the layer test; all of them until the host says. */
  uses = DECAL_USES_ALL;
  /** Draws that wore a decal variant since the host last read it (every pass). */
  draws = 0;
  private nodes: DecalNodes | null = null;
  /** The decals' world boxes and layers by table row, a coarse grid of them, the layers any decal marks. */
  private boxes: (DecalHitBox | undefined)[] = [];
  private live = 0;
  private coarse = new Map<number, number[]>();
  private big = new Set<number>();
  private layerUnion = 0;
  /** Counts every change of the boxes; `base` is the revision of the last whole set, `log` the single changes since. */
  private revision = 0;
  private base = 0;
  private log: { readonly revision: number; readonly row: number; readonly old: DecalHitBox | undefined; readonly now: DecalHitBox | undefined }[] = [];
  /** Each object's last test (a map: a property put on three's objects would give them another shape). */
  private readonly seen = new WeakMap<THREE.Object3D, Seen>();

  /** A set's array (null: none; the placeholder stands in). */
  setPages(set: DecalPageSetName, t: THREE.Texture | null): void {
    const next = t ?? this.placeholders[set];
    if (this.pages[set] === next) return;
    this.pages[set] = next;
    this.generation += 1;
    if (this.nodes !== null) this.nodes[set].value = next;
  }

  /** What the programs blend: a change is a new generation (the variants' programs blend other channels). */
  setUses(uses: number): void {
    if (uses === this.uses) return;
    this.uses = uses;
    this.generation += 1;
  }

  /** Swap in a new data texture (grown); the nodes follow. */
  setData(data: THREE.DataTexture): void {
    if (data === this.data) return;
    this.data = data;
    this.generation += 1;
    if (this.nodes !== null) this.nodes.data.value = data;
  }

  /** The decals' boxes by table row (undefined: a row not in use), all at once. */
  setBoxes(boxes: readonly (DecalHitBox | undefined)[]): void {
    this.boxes = [];
    this.coarse = new Map();
    this.big = new Set();
    this.layerUnion = 0;
    this.live = 0;
    boxes.forEach((b, i) => this.place(i, b));
    this.revision += 1;
    this.base = this.revision;
    this.log = [];
  }

  /** One decal's box now (undefined: gone): objects' kept tests are brought up to date by it, not redone. */
  setBox(i: number, box: DecalHitBox | undefined): void {
    const old = this.boxes[i];
    if (old !== undefined) this.unplace(i, old);
    this.place(i, box);
    this.revision += 1;
    this.log.push({ revision: this.revision, row: i, old, now: box });
    if (this.log.length > HIT_LOG_MAX) {
      this.base = this.revision;
      this.log = [];
    }
  }

  /** Decals whose boxes are held. */
  get count(): number {
    return this.live;
  }

  private place(i: number, b: DecalHitBox | undefined): void {
    this.boxes[i] = b;
    if (b === undefined) return;
    this.live += 1;
    // The layers any decal marks only grow until the next whole set (an object keeps out of them early).
    this.layerUnion |= b.layerMask;
    const cells = coarseCells(b.min, b.max);
    // A decal over many coarse cells is tested against every object instead of listed in each.
    if (cells === null) {
      this.big.add(i);
      return;
    }
    for (const k of cells) {
      const l = this.coarse.get(k);
      if (l === undefined) this.coarse.set(k, [i]);
      else l.push(i);
    }
  }

  private unplace(i: number, b: DecalHitBox): void {
    this.boxes[i] = undefined;
    this.live -= 1;
    if (this.big.delete(i)) return;
    for (const k of coarseCells(b.min, b.max) ?? []) {
      const l = this.coarse.get(k);
      const at = l?.indexOf(i) ?? -1;
      if (at < 0) continue;
      l!.splice(at, 1);
      if (l!.length === 0) this.coarse.delete(k);
    }
  }

  /**
   * Whether a decal can mark `object`: its world bounds meet a decal's box,
   * and its decal layers share one with that decal's. Kept per object: while
   * the object, its bounds and its layers stay as they were, a draw reads
   * the kept answer, brought up to date through the few decals that changed
   * since (a moved or spawned decal does not test every object again). An
   * object without bounds counts as hit.
   */
  hits(object: THREE.Object3D): boolean {
    if (this.live === 0) return false;
    let known = this.seen.get(object);
    const layers = objectDecalLayers(object);
    const sphere = boundsOf(object);
    const e = object.matrixWorld.elements;
    if (known !== undefined && known.layers === layers && known.sphere === sphere && (sphere === null || (known.bounds[0] === sphere.radius && known.bounds[1] === sphere.center.x && known.bounds[2] === sphere.center.y && known.bounds[3] === sphere.center.z))) {
      let same = true;
      for (let k = 0; k < 16 && same; k++) same = known.matrix[k] === e[k];
      if (same) {
        if (known.revision === this.revision) return known.hit;
        const update = this.catchUp(known);
        if (update !== null) {
          known.revision = this.revision;
          known.hit = update;
          return update;
        }
      }
    }
    if (known === undefined) {
      known = { revision: -1, layers: 0, sphere: null, bounds: new Float64Array(4), matrix: new Float64Array(16), lo: [0, 0, 0], hi: [0, 0, 0], hit: false };
      this.seen.set(object, known);
    }
    known.revision = this.revision;
    known.layers = layers;
    known.sphere = sphere;
    if (sphere !== null) known.bounds.set([sphere.radius, sphere.center.x, sphere.center.y, sphere.center.z]);
    known.matrix.set(e);
    known.hit = this.test(object, known);
    return known.hit;
  }

  /**
   * `known` brought up to date through the changes since its test (null:
   * too many, or one that may have taken its hit away and none that gives
   * one back: test again). A decal's last box meeting the object is a hit
   * whatever else changed; a decal that left it may have been its only one.
   */
  private catchUp(known: Seen): boolean | null {
    if (known.revision < this.base || known.sphere === null) return null;
    let from = this.log.length;
    while (from > 0 && this.log[from - 1]!.revision > known.revision) from -= 1;
    if (this.log.length - from > HIT_CHANGES_MAX) return null;
    let lost = false;
    for (let k = this.log.length - 1; k >= from; k--) {
      const c = this.log[k]!;
      // Only a decal's latest box is where it is now.
      const latest = this.boxes[c.row] === c.now;
      if (latest && c.now !== undefined && meets(c.now, known)) return true;
      if (c.old !== undefined && meets(c.old, known)) lost = true;
    }
    return known.hit && !lost ? true : known.hit ? null : false;
  }

  private test(object: THREE.Object3D, known: Seen): boolean {
    const sphere = known.sphere;
    if (sphere !== null) {
      // Its world bounds first: the changes it is brought up to date through are tested against them.
      _centre.copy(sphere.center).applyMatrix4(object.matrixWorld);
      const r = sphere.radius * object.matrixWorld.getMaxScaleOnAxis();
      known.lo = [_centre.x - r, _centre.y - r, _centre.z - r];
      known.hi = [_centre.x + r, _centre.y + r, _centre.z + r];
    }
    if ((known.layers & this.layerUnion) === 0) return false;
    if (sphere === null) return true;
    // The decals too large for the coarse grid first, then the grid's (or every decal, for an object too large for it).
    for (const i of this.big) if (meets(this.boxes[i]!, known)) return true;
    const cells = coarseCells(known.lo, known.hi);
    if (cells === null) {
      for (const b of this.boxes) if (b !== undefined && meets(b, known)) return true;
      return false;
    }
    for (const k of cells) {
      const l = this.coarse.get(k);
      if (l !== undefined) for (const i of l) if (meets(this.boxes[i]!, known)) return true;
    }
    return false;
  }

  /** The nodes every build reads (made once, shared). */
  nodesOf(): DecalNodes {
    if (this.nodes === null) {
      this.nodes = {
        data: dataTextureNode(this.data),
        albedo: pageNode(this.pages.albedo),
        normal: pageNode(this.pages.normal),
        orm: pageNode(this.pages.orm),
        origin: uniform(this.origin).setGroup(renderGroup),
        invCell: uniform(this.invCell).setGroup(renderGroup),
        layout: uniform(this.layout).setGroup(renderGroup),
      };
    }
    return this.nodes;
  }

  dispose(): void {
    this.boxes = [];
    this.coarse.clear();
    this.big.clear();
    this.live = 0;
    this.data.dispose();
    for (const t of Object.values(this.placeholders)) t.dispose();
  }
}

/** Every channel and page set, and the layer test. */
const DECAL_USES_ALL = 1023;

/** The coarse grid's cells per axis a key spans (cell coordinates are offset into 0 … this − 1: ±1 000 km of 8 m cells). */
const HIT_KEY_SPAN = 1 << 18;

/** The coarse cells a world box covers, as numbers (null: more than {@link HIT_CELLS_MAX}). */
function coarseCells(min: readonly number[], max: readonly number[]): number[] | null {
  const h = HIT_KEY_SPAN / 2;
  const x0 = Math.floor(min[0]! / HIT_CELL) + h;
  const y0 = Math.floor(min[1]! / HIT_CELL) + h;
  const z0 = Math.floor(min[2]! / HIT_CELL) + h;
  const x1 = Math.floor(max[0]! / HIT_CELL) + h;
  const y1 = Math.floor(max[1]! / HIT_CELL) + h;
  const z1 = Math.floor(max[2]! / HIT_CELL) + h;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > HIT_CELLS_MAX) return null;
  const out: number[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push((x * HIT_KEY_SPAN + y) * HIT_KEY_SPAN + z);
  return out;
}

/** Whether decal box `b` can mark an object (its bounds `lo`–`hi`, its layers). */
function meets(b: DecalHitBox, o: { readonly lo: readonly number[]; readonly hi: readonly number[]; readonly layers: number }): boolean {
  return (b.layerMask & o.layers) !== 0 && b.min[0]! <= o.hi[0]! && b.max[0]! >= o.lo[0]! && b.min[1]! <= o.hi[1]! && b.max[1]! >= o.lo[1]! && b.min[2]! <= o.hi[2]! && b.max[2]! >= o.lo[2]!;
}

const _centre = new THREE.Vector3();

/** What an object's last hit test saw (its matrix, bounds and layers, its world bounds) and found. */
interface Seen {
  revision: number;
  layers: number;
  sphere: THREE.Sphere | null;
  readonly bounds: Float64Array;
  readonly matrix: Float64Array;
  lo: number[];
  hi: number[];
  hit: boolean;
}

/** An object's bounds in its own space: an instanced draw's over its instances, else its geometry's (null: none). */
function boundsOf(object: THREE.Object3D): THREE.Sphere | null {
  const own = (object as THREE.InstancedMesh).boundingSphere;
  if (own !== null && own !== undefined) return own;
  const g = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (g === undefined) return null;
  if (g.boundingSphere === null) g.computeBoundingSphere();
  return g.boundingSphere;
}

/**
 * The decal textures' nodes leave out three's texture transform (sixty-odd
 * reads of the decal loop made three update them for each reached draw),
 * and the table and index three's WebGL 2 flip (`texel-texture-node.ts`).
 *
 * Textures stay in each draw's own bind group (three's shared groups take
 * uniforms only), so every texture a decal program binds is checked and bound
 * for every reached draw: the table and the index share one texture, and a
 * page set no decal has an image on is not bound at all.
 */
const dataTextureNode = texelTexture;
const pageNode = untransformedTexture;

interface DecalNodes {
  data: N;
  albedo: N;
  normal: N;
  orm: N;
  origin: N;
  invCell: N;
  layout: N;
}

/** Each scene's projected decals (a scene adapter's host attaches them while it has any). */
const attached = new WeakMap<object, ProjectedDecals>();

/** Attach `decals` to `scene` (null: detach): its draws that a decal can reach wear decal variants. */
export function attachProjectedDecals(scene: THREE.Object3D, decals: ProjectedDecals | null): void {
  if (decals === null) attached.delete(scene);
  else attached.set(scene, decals);
  attachments += 1;
}

/** Counts attachments: a renderer's kept answer for its last scene is read again after any. */
let attachments = 0;

/** The decals attached to `scene` (null: none). */
export function projectedDecalsOf(scene: THREE.Object3D): ProjectedDecals | null {
  return attached.get(scene) ?? null;
}

/** The own property of a decal variant holding the decals it blends. */
const VARIANT_DECALS = 'tlProjectedDecals';

/** Each material's decal variants by decals (one generation each). */
const variants = new WeakMap<THREE.Material, Map<number, { generation: number; variant: THREE.Material }>>();

/**
 * The variant of `material` that blends `decals` in (made once per
 * generation of the decals' textures; the one it replaces is disposed, so
 * three lets go of its render objects; `material-variant.ts`), its values
 * copied from the material once per render call `call` (-1: now).
 */
export function decalVariant(material: THREE.Material, decals: ProjectedDecals, call = -1): THREE.Material {
  let byHost = variants.get(material);
  const known = byHost?.get(decals.id);
  if (known !== undefined && known.generation === decals.generation) {
    syncMaterialVariant(known.variant, call);
    return known.variant;
  }
  if (known !== undefined) known.variant.dispatchEvent({ type: 'dispose' });
  const v = makeMaterialVariant(material, { [VARIANT_DECALS]: decals }, `|tlDecals=${decals.id}:${decals.generation}`);
  if (call !== -1) syncMaterialVariant(v, call);
  if (byHost === undefined) {
    byHost = new Map();
    variants.set(material, byHost);
    material.addEventListener('dispose', () => {
      const made = variants.get(material);
      variants.delete(material);
      for (const m of made?.values() ?? []) m.variant.dispatchEvent({ type: 'dispose' });
    });
  }
  byHost.set(decals.id, { generation: decals.generation, variant: v });
  return v;
}

/**
 * Whether a material can take projected decals: a lit material (a node one,
 * or a plain one three converts, copying the variant's mark with its values)
 * that is not a mesh decal.
 */
function receives(material: THREE.Material): boolean {
  return isLit(material) && decalDrawOf(material) === null;
}

/** The receiver's decal layers, per drawn object (a uniform updated per object, so a mask builds no program). */
const objectLayers: N = uniform(DECAL_LAYERS_ALL).onObjectUpdate(({ object }: { object: THREE.Object3D }) => objectDecalLayers(object));

/** Texel `k` of table row `row` (int node). */
function rowTexel(n: DecalNodes, row: N, k: number): N {
  const e = row.mul(DECAL_ROW_TEXELS).add(k);
  return n.data.load(ivec2(e.mod(DECAL_TEXTURE_WIDTH), e.div(DECAL_TEXTURE_WIDTH)));
}
/** Texel `e` of the index (int node): the index's lines follow the table's in the one data texture. */
function indexTexel(n: DecalNodes, e: N): N {
  const at = e.add(int(n.layout.x));
  return n.data.load(ivec2(at.mod(DECAL_TEXTURE_WIDTH), at.div(DECAL_TEXTURE_WIDTH)));
}

/**
 * The channels the attached decals change (a bit each), part of the
 * variants' key: a build blends only those, so stains that change only the
 * colour cost no ORM or normal reads and no lighting inputs of their own.
 */
export const DECAL_CHANNEL_BITS = { albedo: 1, normal: 2, roughness: 4, metalness: 8, occlusion: 16, emission: 32 } as const;
/**
 * With the channels: some decal marks only some layers, so each pixel tests
 * its object's layers (a per-object uniform, updated for every draw). While
 * every decal marks every layer the test is left out: an object reached at
 * all shares a layer with every decal (`hits` keeps out those in none).
 */
export const DECAL_LAYER_TEST_BIT = 64;
/**
 * With the channels: the page sets some decal has an image on. A set no decal
 * reads is neither bound nor sampled (its reads are the fallback value), so a
 * stain with an albedo image and a roughness value binds one page array, not
 * three.
 */
export const DECAL_PAGE_BITS = { albedo: 128, normal: 256, orm: 512 } as const;
const ORM_BITS = DECAL_CHANNEL_BITS.roughness | DECAL_CHANNEL_BITS.metalness | DECAL_CHANNEL_BITS.occlusion | DECAL_CHANNEL_BITS.emission;

/** One channel's blend: the decals' share and what is left of the surface's (`over`, front to back). */
interface Over {
  readonly p: N;
  readonly t: N;
}

/** What one build's decals add up to, per channel it blends (null: a channel no attached decal changes). */
interface DecalBlend {
  readonly albedo: Over | null;
  readonly rough: Over | null;
  readonly metal: Over | null;
  readonly ao: Over | null;
  readonly emission: N | null;
  /** The bend the decals give the normal (world). */
  readonly bend: N | null;
}

/** The decals over this pixel, blended in sort order (see the module comment), for the channels in `uses`. */
function evaluate(n: DecalNodes, uses: number): DecalBlend {
  // The world position from the view position the lighting uses (a per-camera matrix), not three's `positionWorld`,
  // whose object matrix is a uniform updated for every draw: the decal steps add no per-draw work of their own.
  const p = cameraWorldMatrix.mul(vec4(positionView, 1)).xyz.toVar('tlDecalPos');
  const dpx = dFdx(p).toVar('tlDecalDpx');
  const dpy = dFdy(p).toVar('tlDecalDpy');
  const has = (bit: number): boolean => (uses & bit) !== 0;
  const over = (name: string, bit: number, zero: N): Over | null => (has(bit) ? { p: zero.toVar(`tlDecal${name}`), t: float(1).toVar(`tlDecal${name}Left`) } : null);
  const b: DecalBlend = {
    albedo: over('Albedo', DECAL_CHANNEL_BITS.albedo, vec3(0)),
    rough: over('Rough', DECAL_CHANNEL_BITS.roughness, float(0)),
    metal: over('Metal', DECAL_CHANNEL_BITS.metalness, float(0)),
    ao: over('Ao', DECAL_CHANNEL_BITS.occlusion, float(0)),
    emission: has(DECAL_CHANNEL_BITS.emission) ? vec3(0).toVar('tlDecalEmission') : null,
    bend: has(DECAL_CHANNEL_BITS.normal) ? vec3(0).toVar('tlDecalBend') : null,
  };
  const blend = (o: Over | null, value: () => N, a: N): void => {
    if (o === null) return;
    o.p.assign(o.p.mul(float(1).sub(a)).add(value().mul(a)));
    o.t.mulAssign(float(1).sub(a));
  };
  const cf = p.sub(n.origin.xyz).mul(n.invCell.xyz).floor().toVar('tlDecalCell');
  {
    // The cell's slot in the hash table (decal-index.ts): probe from its hash until its key or an empty slot.
    // Coordinates may be negative (a decal moved past the grid's corner): hashed as their signed bits, as the index does.
    const c = uvec3(ivec3(cf));
    const hashed = c.x.mul(uint(DECAL_HASH[0])).bitXor(c.y.mul(uint(DECAL_HASH[1]))).bitXor(c.z.mul(uint(DECAL_HASH[2])));
    const mask = uint(n.origin.w);
    const slot = hashed.bitAnd(mask).toVar('tlDecalSlot');
    const start = int(-1).toVar('tlDecalStart');
    Loop(int(n.invCell.w), () => {
      const head = indexTexel(n, int(slot));
      If(head.w.lessThan(0), () => {
        Break();
      });
      If(head.xyz.equal(cf).all(), () => {
        start.assign(int(head.w));
        Break();
      });
      slot.assign(slot.add(uint(1)).bitAnd(mask));
    });
    If(start.greaterThanEqual(0), () => {
      const count = int(indexTexel(n, start).x);
      // Only a pixel whose cell lists decals goes on: its facing, its distance, its object's layers.
      const toEye = cameraPosition.sub(p);
      const face = normalize(cross(dpx, dpy));
      const ng = select(dot(face, toEye).lessThan(0), face.negate(), face).toVar('tlDecalFacing');
      const distance = length(toEye).toVar('tlDecalDistance');
      const layers = (uses & DECAL_LAYER_TEST_BIT) !== 0 ? int(objectLayers).toVar('tlDecalLayers') : null;
      Loop(count, ({ i }: { i: N }) => {
        const row = int(indexTexel(n, start.add(1).add(i)).x).toVar('tlDecalRow');
        const m0 = rowTexel(n, row, 0).toVar('tlDecalM0');
        const m1 = rowTexel(n, row, 1).toVar('tlDecalM1');
        const m2 = rowTexel(n, row, 2).toVar('tlDecalM2');
        const p4 = vec4(p, 1);
        const q = vec3(dot(m0, p4), dot(m1, p4), dot(m2, p4)).toVar('tlDecalBox');
        If(abs(q).lessThanEqual(vec3(0.5)).all(), () => {
          const fades = rowTexel(n, row, 6);
          const ends = rowTexel(n, row, 7);
          const layerOk = layers === null ? null : int(ends.w).bitAnd(layers).notEqual(int(0));
          // Facing the projector: its +Z (the box's depth axis) against the surface's facing.
          const facing = smoothstep(fades.z, fades.w, dot(ng, normalize(m2.xyz)));
          // 0 at the box's front (+Z, where it projects from), 1 at its back.
          const depth = float(0.5).sub(q.z);
          const edge = saturate(depth.div(max(ends.x, DECAL_FADE.edgeMin))).mul(saturate(float(1).sub(depth).div(max(ends.y, DECAL_FADE.edgeMin))));
          const far = select(ends.z.greaterThan(0), float(1).sub(smoothstep(ends.z.mul(DECAL_FADE.distanceStartShare), ends.z, distance)), float(1));
          const w = (layerOk === null ? facing.mul(edge).mul(far) : select(layerOk, facing.mul(edge).mul(far), float(0))).toVar('tlDecalWeight');
          If(w.greaterThan(0), () => {
            const rect = rowTexel(n, row, 3);
            const place = rowTexel(n, row, 4);
            const op = rowTexel(n, row, 5);
            const tint = rowTexel(n, row, 8);
            // Image +Y up, pages from the top-left.
            const span = rect.zw.sub(rect.xy);
            const uv = rect.xy.add(vec2(q.x.add(0.5), float(0.5).sub(q.y)).mul(span));
            const gx = vec2(dot(m0.xyz, dpx), dot(m1.xyz, dpx).negate()).mul(span);
            const gy = vec2(dot(m0.xyz, dpy), dot(m1.xyz, dpy).negate()).mul(span);
            // The derivatives shortened so their longer one spans at most the rectangle's safe footprint (level-0 texels).
            const longest = max(length(gx), length(gy)).mul(n.layout.y);
            const k = min(float(1), place.w.div(max(longest, 1e-6)));
            const sx = gx.mul(k);
            const sy = gy.mul(k);
            const read = (pages: N, layer: N, fallback: N, bit: number): N => {
              // A set no decal has an image on is not bound: its value is the fallback's.
              if ((uses & bit) === 0) return fallback;
              const v = vec4(fallback).toVar();
              If(layer.greaterThanEqual(0), () => {
                v.assign(pages.sample(uv).depth(int(layer)).grad(sx, sy));
              });
              return v;
            };
            // The image's alpha is the mark's shape for every channel.
            const albedo = read(n.albedo, place.x, vec4(1, 1, 1, 1), DECAL_PAGE_BITS.albedo);
            const cover = albedo.a.mul(tint.w).mul(w).toVar('tlDecalCover');
            blend(b.albedo, () => albedo.rgb.mul(tint.rgb), cover.mul(op.x));
            if ((uses & ORM_BITS) !== 0) {
              const glow = rowTexel(n, row, 9);
              const factors = rowTexel(n, row, 10);
              const orm = read(n.orm, place.z, vec4(1, 1, 1, 0), DECAL_PAGE_BITS.orm);
              blend(b.rough, () => saturate(orm.g.mul(factors.x)).max(0.0525), cover.mul(op.z));
              blend(b.metal, () => saturate(orm.b.mul(factors.y)), cover.mul(op.w));
              // three's aoMapIntensity rule: (r − 1) × intensity + 1.
              blend(b.ao, () => orm.r.sub(1).mul(glow.w).add(1), cover.mul(fades.x));
              if (b.emission !== null) b.emission.addAssign(glow.rgb.mul(orm.a).mul(cover.mul(fades.y)));
            }
            const bend = b.bend;
            if (bend !== null) {
              If(place.y.greaterThanEqual(0), () => {
                const scale = rowTexel(n, row, 10);
                const s = n.normal.sample(uv).depth(int(place.y)).grad(sx, sy);
                const tn = normalize(s.xyz.mul(2).sub(1).mul(vec3(scale.z, scale.w, 1)));
                const x = normalize(m0.xyz);
                const tangent = normalize(x.sub(ng.mul(dot(ng, x))));
                const bitangent = cross(ng, tangent);
                const bent = tangent.mul(tn.x).add(bitangent.mul(tn.y)).add(ng.mul(tn.z));
                const a = cover.mul(op.y);
                bend.assign(bend.mul(float(1).sub(a)).add(bent.sub(ng).mul(a)));
              });
            }
          });
        });
      });
    });
  }
  return b;
}

/** The blend of the build being set up (the steps after `setupDiffuseColor` read it). */
const blends = new WeakMap<object, DecalBlend>();

/** The decals a build of `material` blends in (null: three's own steps). */
function decalsFor(material: THREE.NodeMaterial, builder: N): ProjectedDecals | null {
  const d = (material as unknown as Record<string, unknown>)[VARIANT_DECALS] as ProjectedDecals | undefined;
  if (d === undefined || !receives(material)) return null;
  const object = builder.object as THREE.Object3D | undefined;
  if (object === undefined || (object as THREE.Points).isPoints === true || (object as THREE.Line).isLine === true || (object as THREE.Sprite).isSprite === true) return null;
  return d;
}

let installed = false;

/**
 * Teach every node material the decal steps (idempotent). Installed before
 * any material wraps a step of its own (node-materials.ts), so those wrap
 * these.
 */
export function installProjectedDecalSteps(): void {
  if (installed) return;
  installed = true;
  type Step = (this: THREE.NodeMaterial, builder: N) => N;
  const proto = THREE.NodeMaterial.prototype as unknown as Record<'setupDiffuseColor' | 'setupAmbientOcclusion' | 'setupNormal' | 'setupLighting', Step>;
  const standard = THREE.MeshStandardNodeMaterial.prototype as unknown as { setupVariants: Step; setupSpecular(this: unknown): void };

  const diffuse = proto.setupDiffuseColor;
  proto.setupDiffuseColor = function setupDiffuseColorWithDecals(builder) {
    const light = decalsFor(this, builder);
    if (light === null) return diffuse.call(this, builder);
    // First: the blend sits before anything the material's own colour reads (a graph may read the normal).
    const b = evaluate(light.nodesOf(), light.uses);
    blends.set(builder, b);
    const out = diffuse.call(this, builder);
    if (b.albedo !== null) diffuseColor.rgb.assign(diffuseColor.rgb.mul(b.albedo.t).add(b.albedo.p));
    return out;
  };

  const ao = proto.setupAmbientOcclusion;
  proto.setupAmbientOcclusion = function setupAmbientOcclusionWithDecals(builder) {
    const out = ao.call(this, builder);
    const o = blends.get(builder)?.ao;
    if (o === undefined || o === null) return out;
    if (builder.context.ambientOcclusion !== undefined) ambientOcclusion.assign(ambientOcclusion.mul(o.t).add(o.p));
    else {
      ambientOcclusion.assign(o.t.add(o.p));
      builder.context.ambientOcclusion = ambientOcclusion;
    }
    return out;
  };

  const variants = standard.setupVariants;
  standard.setupVariants = function setupVariantsWithDecals(builder) {
    const out = variants.call(this, builder);
    const b = blends.get(builder);
    if (b === undefined || (b.metal === null && b.rough === null)) return out;
    if (b.metal !== null) metalness.assign(metalness.mul(b.metal.t).add(b.metal.p));
    if (b.rough !== null) roughness.assign(roughness.mul(b.rough.t).add(b.rough.p));
    // What three derived from the metalness, again from the blended one.
    (this as unknown as { setupSpecular(): void }).setupSpecular();
    diffuseContribution.assign(diffuseColor.rgb.mul(metalness.oneMinus()));
    return out;
  };

  const normal = proto.setupNormal;
  proto.setupNormal = function setupNormalWithDecals(builder) {
    const out = normal.call(this, builder);
    const bend = builder?.shaderStage === 'fragment' ? blends.get(builder)?.bend : undefined;
    if (bend === undefined || bend === null) return out;
    return normalize(vec3(out).add(cameraViewMatrix.mul(vec4(bend, 0)).xyz));
  };

  const lighting = proto.setupLighting;
  proto.setupLighting = function setupLightingWithDecals(builder) {
    const out = lighting.call(this, builder);
    const glow = blends.get(builder)?.emission;
    return glow === undefined || glow === null ? out : vec3(out).add(glow);
  };
}

/** three's `renderObject`, its arguments spelled out: called for every draw, a rest array would be made for each. */
type RenderObjectFn = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, group: unknown, lightsNode: unknown, clippingContext?: unknown, passId?: unknown) => void;

/**
 * Teach a renderer projected decals: every material the decal steps, and
 * each draw a decal can reach its material's decal variant. Shadow and other
 * override passes draw with their own material and are left alone.
 */
export function registerProjectedDecals(renderer: { renderObject: RenderObjectFn }): void {
  installProjectedDecalSteps();
  const base = renderer.renderObject;
  // The scene this renderer drew last and its decals (every draw of a pass asks; the scene rarely changes). Kept per
  // renderer, so a disposed renderer's scene is not held by the next one's draws.
  let lastScene: THREE.Object3D | null = null;
  let lastDecals: ProjectedDecals | undefined;
  let seen = -1;
  renderer.renderObject = function renderObjectWithDecals(this: unknown, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) {
    if (scene !== lastScene || seen !== attachments) {
      lastScene = scene;
      lastDecals = attached.get(scene);
      seen = attachments;
    }
    const d = scene.overrideMaterial === null ? lastDecals : undefined;
    if (d !== undefined && receives(material) && d.hits(object)) {
      const v = decalVariant(material, d, renderCallOf(this));
      d.draws += 1;
      base.call(this, object, scene, camera, geometry, v, group, lightsNode, clippingContext, passId);
      return;
    }
    base.call(this, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
  };
}

/** The page flag that draws without projected and clipped decals (`?decals=off`: their cost, by comparison). */
export const DECALS_URL_PARAM = 'decals';

/** Whether a page's query string leaves projected and clipped decals on (the default) — `decals=off` or `0` turns them off. */
export function decalsFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(DECALS_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}
