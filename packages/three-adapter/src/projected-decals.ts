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
import { DECAL_LAYERS_ALL } from '@thirdlight/runtime';

import { DECAL_HASH, DECAL_ROW_TEXELS, DECAL_TEXTURE_WIDTH } from './decal-index';
import type { N } from './effects-tsl';
import { isLit, materialValuesKey } from './local-lights';
import { decalDrawOf } from './mesh-decals';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Break, If, Loop, abs, cameraPosition, cameraViewMatrix, cross, dFdx, dFdy, dot, float, int, ivec2, length, max, min, normalize, saturate, select, smoothstep, uint, uniform, uvec3, texture, vec2, vec3, vec4, positionView, cameraWorldMatrix } = TSL;
const { diffuseColor, metalness, roughness, ambientOcclusion, diffuseContribution } = TSL;

/** `object.userData[DECAL_LAYERS_KEY]`: the decal layers a drawable is in (absent: every layer; a skinned mesh none). */
export const DECAL_LAYERS_KEY = '__tlDecalLayers';

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

let nextId = 1;

/**
 * The projected decals of a scene: the table, the index, the page arrays and
 * the grid's placement the receiving materials read, and the decals' boxes
 * the CPU tests objects against. The host (decal-projectors.ts) fills them
 * and attaches them to its scene ({@link attachProjectedDecals}).
 */
export class ProjectedDecals {
  readonly id = nextId++;
  table: THREE.DataTexture = decalDataTexture(new Float32Array(DECAL_TEXTURE_WIDTH * 4), 1);
  index: THREE.DataTexture = decalDataTexture(new Float32Array(DECAL_TEXTURE_WIDTH * 4), 1);
  pages: Record<DecalPageSetName, THREE.Texture> = { albedo: placeholderPages(true), normal: placeholderPages(false), orm: placeholderPages(false) };
  private readonly placeholders = { ...this.pages };
  /** The grid's corner; 1 / its cell size and (w) the longest probe; its cells per axis and (w) the hash table's mask. */
  readonly origin = new THREE.Vector4();
  readonly invCell = new THREE.Vector4();
  readonly dims = new THREE.Vector4();
  /**
   * Counts the swaps of a bound texture (pages arrived, data grown). It is
   * part of the variants' program key: three's WebGL 2 backend binds a
   * texture node's new texture only for a new program state.
   */
  generation = 0;
  /** The channels the decals change ({@link DECAL_CHANNEL_BITS}) and the layer test; all of them until the host says. */
  uses = 127;
  /** Draws that wore a decal variant since the host last read it (every pass). */
  draws = 0;
  private pageSide = 1;
  private nodes: DecalNodes | null = null;
  /** The decals' world boxes and layers, a coarse grid of them, the layers any decal marks; a count of their changes. */
  private boxes: readonly { readonly min: readonly number[]; readonly max: readonly number[]; readonly layerMask: number }[] = [];
  private coarse = new Map<string, number[]>();
  private big: number[] = [];
  private layerUnion = 0;
  private revision = 0;
  /** Each object's last test, on the object itself (read for every draw: a property, not a map lookup). */
  private readonly seenKey = Symbol('tlDecalHits');

  /** A set's array (null: none; the placeholder stands in). */
  setPages(set: DecalPageSetName, t: THREE.Texture | null): void {
    const next = t ?? this.placeholders[set];
    if (this.pages[set] === next) return;
    this.pages[set] = next;
    this.generation += 1;
    if (this.nodes !== null) this.nodes[set].value = next;
  }

  /** The channels the decals change: a change is a new generation (the variants' programs blend other channels). */
  setUses(uses: number): void {
    if (uses === this.uses) return;
    this.uses = uses;
    this.generation += 1;
  }

  /** The pages' side in level-0 texels (what a read's footprint is measured in). */
  setPageSize(side: number): void {
    this.pageSide = side;
    if (this.nodes !== null) this.nodes.pageSize.value = side;
  }

  /** Swap in new table or index textures (grown); the nodes follow. */
  setData(table: THREE.DataTexture, index: THREE.DataTexture): void {
    if (table === this.table && index === this.index) return;
    this.table = table;
    this.index = index;
    this.generation += 1;
    if (this.nodes !== null) {
      this.nodes.table.value = table;
      this.nodes.index.value = index;
    }
  }

  /** The decals' boxes as the table holds them (objects are tested against these). */
  setBoxes(boxes: readonly { readonly min: readonly number[]; readonly max: readonly number[]; readonly layerMask: number }[]): void {
    this.boxes = boxes;
    this.coarse = new Map();
    this.layerUnion = 0;
    this.big = [];
    boxes.forEach((b, i) => {
      this.layerUnion |= b.layerMask;
      const [x0, y0, z0] = b.min.map((v) => Math.floor(v / HIT_CELL));
      const [x1, y1, z1] = b.max.map((v) => Math.floor(v / HIT_CELL));
      // A decal over many coarse cells is tested against every object instead of listed in each.
      if ((x1! - x0! + 1) * (y1! - y0! + 1) * (z1! - z0! + 1) > HIT_CELLS_MAX) {
        this.big.push(i);
        return;
      }
      for (let x = x0!; x <= x1!; x++)
        for (let y = y0!; y <= y1!; y++)
          for (let z = z0!; z <= z1!; z++) {
            const k = `${x},${y},${z}`;
            const l = this.coarse.get(k);
            if (l === undefined) this.coarse.set(k, [i]);
            else l.push(i);
          }
    });
    this.revision += 1;
  }

  /** Decals whose boxes are held. */
  get count(): number {
    return this.boxes.length;
  }

  /**
   * Whether a decal can mark `object`: its world bounds meet a decal's box,
   * and its decal layers share one with that decal's. Kept per object until
   * it moves or the decals change. An object without bounds counts as hit.
   */
  hits(object: THREE.Object3D): boolean {
    if (this.boxes.length === 0) return false;
    const layers = objectDecalLayers(object);
    if ((layers & this.layerUnion) === 0) return false;
    const sphere = boundsOf(object);
    const e = object.matrixWorld.elements;
    // Asked for every draw of every frame: what it was asked last is compared number by number, nothing made.
    const own = object as unknown as Record<symbol, Seen | undefined>;
    let known = own[this.seenKey];
    if (known !== undefined && known.revision === this.revision && known.layers === layers && known.sphere === sphere && (sphere === null || (known.bounds[0] === sphere.radius && known.bounds[1] === sphere.center.x && known.bounds[2] === sphere.center.y && known.bounds[3] === sphere.center.z))) {
      let same = true;
      for (let k = 0; k < 16 && same; k++) same = known.matrix[k] === e[k];
      if (same) return known.hit;
    }
    if (known === undefined) {
      known = { revision: -1, layers: 0, sphere: null, bounds: new Float64Array(4), matrix: new Float64Array(16), hit: false };
      own[this.seenKey] = known;
    }
    known.revision = this.revision;
    known.layers = layers;
    known.sphere = sphere;
    if (sphere !== null) known.bounds.set([sphere.radius, sphere.center.x, sphere.center.y, sphere.center.z]);
    known.matrix.set(e);
    let hit = true;
    if (sphere !== null) {
      _centre.copy(sphere.center).applyMatrix4(object.matrixWorld);
      const r = sphere.radius * object.matrixWorld.getMaxScaleOnAxis();
      const lo = [_centre.x - r, _centre.y - r, _centre.z - r];
      const hi = [_centre.x + r, _centre.y + r, _centre.z + r];
      const meets = (i: number): boolean => {
        const b = this.boxes[i]!;
        return (b.layerMask & layers) !== 0 && b.min[0]! <= hi[0]! && b.max[0]! >= lo[0]! && b.min[1]! <= hi[1]! && b.max[1]! >= lo[1]! && b.min[2]! <= hi[2]! && b.max[2]! >= lo[2]!;
      };
      const c0 = lo.map((v) => Math.floor(v / HIT_CELL));
      const c1 = hi.map((v) => Math.floor(v / HIT_CELL));
      const cells = (c1[0]! - c0[0]! + 1) * (c1[1]! - c0[1]! + 1) * (c1[2]! - c0[2]! + 1);
      // The decals too large for the coarse grid first, then the grid's (or every decal, for an object too large for it).
      hit = this.big.some(meets);
      if (!hit && cells > HIT_CELLS_MAX) {
        for (let i = 0; i < this.boxes.length && !hit; i++) hit = meets(i);
      } else if (!hit) {
        for (let x = c0[0]!; x <= c1[0]! && !hit; x++)
          for (let y = c0[1]!; y <= c1[1]! && !hit; y++)
            for (let z = c0[2]!; z <= c1[2]! && !hit; z++) {
              const l = this.coarse.get(`${x},${y},${z}`);
              if (l !== undefined) for (const i of l) if (meets(i)) hit = true;
            }
      }
    }
    known.hit = hit;
    return hit;
  }

  /** The nodes every build reads (made once, shared). */
  nodesOf(): DecalNodes {
    if (this.nodes === null) {
      this.nodes = {
        table: dataTextureNode(this.table),
        index: dataTextureNode(this.index),
        albedo: texture(this.pages.albedo),
        normal: texture(this.pages.normal),
        orm: texture(this.pages.orm),
        origin: uniform(this.origin),
        invCell: uniform(this.invCell),
        dims: uniform(this.dims),
        pageSize: uniform(this.pageSide),
      };
    }
    return this.nodes;
  }

  dispose(): void {
    this.boxes = [];
    this.coarse.clear();
    this.table.dispose();
    this.index.dispose();
    for (const t of Object.values(this.placeholders)) t.dispose();
  }
}

const _centre = new THREE.Vector3();

/** What an object's last hit test saw (its matrix, bounds and layers) and found. */
interface Seen {
  revision: number;
  layers: number;
  sphere: THREE.Sphere | null;
  readonly bounds: Float64Array;
  readonly matrix: Float64Array;
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
 * A data texture read texel by texel, as uploaded. three's WebGL 2 builder
 * gives every texture read a flip-Y switch (render targets are stored upside
 * down there): a uniform updated for every draw and a `textureSize` and a
 * select in the shader for every read. The table and index are plain data
 * textures, never flipped, and the decal loop reads them a dozen times a
 * decal: their reads go without it. (A clone keeps the class: `sample` and
 * `load` clone through `this.constructor`.)
 */
class DecalDataNode extends (THREE.TextureNode as unknown as new (value: THREE.Texture) => object) {
  setupUV(_builder: unknown, uvNode: N): N {
    return uvNode;
  }
}
const dataTextureNode = (t: THREE.Texture): N => TSL.nodeObject(new DecalDataNode(t));

interface DecalNodes {
  table: N;
  index: N;
  albedo: N;
  normal: N;
  orm: N;
  origin: N;
  invCell: N;
  dims: N;
  pageSize: N;
}

/** Each scene's projected decals (a scene adapter's host attaches them while it has any). */
const attached = new WeakMap<object, ProjectedDecals>();

/** Attach `decals` to `scene` (null: detach): its draws that a decal can reach wear decal variants. */
export function attachProjectedDecals(scene: THREE.Object3D, decals: ProjectedDecals | null): void {
  if (decals === null) attached.delete(scene);
  else attached.set(scene, decals);
  lastScene = null;
}

/** The scene drawn last and its decals: every draw of a pass asks, the scene rarely changes. */
let lastScene: THREE.Object3D | null = null;
let lastDecals: ProjectedDecals | undefined;

/** The decals attached to `scene` (null: none). */
export function projectedDecalsOf(scene: THREE.Object3D): ProjectedDecals | null {
  return attached.get(scene) ?? null;
}

/** The own property of a decal variant holding the decals it blends. */
const VARIANT_DECALS = 'tlProjectedDecals';

type Keyed = THREE.Material & { customProgramCacheKey(): string };

/** Each material's decal variants by decals (one generation each). */
const variants = new WeakMap<THREE.Material, Map<number, { generation: number; variant: THREE.Material }>>();

/**
 * The variant of `material` that blends `decals` in (made once per
 * generation of the decals' textures; the one it replaces is disposed, so
 * three lets go of its render objects). Variants of equal materials share
 * programs: the key spells out the material's values, as the local-light
 * variants' do.
 */
export function decalVariant(material: THREE.Material, decals: ProjectedDecals): THREE.Material {
  let byHost = variants.get(material);
  const known = byHost?.get(decals.id);
  if (known !== undefined && known.generation === decals.generation) return known.variant;
  if (known !== undefined) known.variant.dispatchEvent({ type: 'dispose' });
  const base = material as Keyed;
  const v = Object.create(base) as Keyed & Record<string, unknown>;
  // Own listeners: three's render objects listen for the variant's dispose, never the material's.
  v['_listeners'] = {};
  v[VARIANT_DECALS] = decals;
  const tag = `|tlDecals=${decals.id}:${decals.generation}`;
  v.customProgramCacheKey = function decalVariantKey(): string {
    return `${base.customProgramCacheKey()}|${materialValuesKey(base)}${tag}`;
  };
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
  return n.table.load(ivec2(e.mod(DECAL_TEXTURE_WIDTH), e.div(DECAL_TEXTURE_WIDTH)));
}
function indexTexel(n: DecalNodes, e: N): N {
  return n.index.load(ivec2(e.mod(DECAL_TEXTURE_WIDTH), e.div(DECAL_TEXTURE_WIDTH)));
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
  If(cf.greaterThanEqual(vec3(0)).all().and(cf.lessThan(n.dims.xyz).all()), () => {
    // The cell's slot in the hash table (decal-index.ts): probe from its hash until its key or an empty slot.
    const c = uvec3(cf);
    const hashed = c.x.mul(uint(DECAL_HASH[0])).bitXor(c.y.mul(uint(DECAL_HASH[1]))).bitXor(c.z.mul(uint(DECAL_HASH[2])));
    const mask = uint(n.dims.w);
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
          const edge = saturate(depth.div(max(ends.x, 1e-4))).mul(saturate(float(1).sub(depth).div(max(ends.y, 1e-4))));
          const far = select(ends.z.greaterThan(0), float(1).sub(smoothstep(ends.z.mul(0.8), ends.z, distance)), float(1));
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
            const longest = max(length(gx), length(gy)).mul(n.pageSize);
            const k = min(float(1), place.w.div(max(longest, 1e-6)));
            const sx = gx.mul(k);
            const sy = gy.mul(k);
            const read = (pages: N, layer: N, fallback: N): N => {
              const v = vec4(fallback).toVar();
              If(layer.greaterThanEqual(0), () => {
                v.assign(pages.sample(uv).depth(int(layer)).grad(sx, sy));
              });
              return v;
            };
            // The image's alpha is the mark's shape for every channel.
            const albedo = read(n.albedo, place.x, vec4(1, 1, 1, 1));
            const cover = albedo.a.mul(tint.w).mul(w).toVar('tlDecalCover');
            blend(b.albedo, () => albedo.rgb.mul(tint.rgb), cover.mul(op.x));
            if ((uses & ORM_BITS) !== 0) {
              const glow = rowTexel(n, row, 9);
              const factors = rowTexel(n, row, 10);
              const orm = read(n.orm, place.z, vec4(1, 1, 1, 0));
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
  });
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

type RenderObjectFn = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, ...rest: unknown[]) => void;

/**
 * Teach a renderer projected decals: every material the decal steps, and
 * each draw a decal can reach its material's decal variant. Shadow and other
 * override passes draw with their own material and are left alone.
 */
export function registerProjectedDecals(renderer: { renderObject: RenderObjectFn }): void {
  installProjectedDecalSteps();
  const base = renderer.renderObject;
  renderer.renderObject = function renderObjectWithDecals(this: unknown, object, scene, camera, geometry, material, ...rest) {
    if (scene !== lastScene) {
      lastScene = scene;
      lastDecals = attached.get(scene);
    }
    const d = scene.overrideMaterial === null ? lastDecals : undefined;
    if (d !== undefined && receives(material) && d.hits(object)) {
      const v = decalVariant(material, d);
      d.draws += 1;
      base.call(this, object, scene, camera, geometry, v, ...rest);
      // A transparent double-sided draw sets `side` on the material it draws and back: keep reading the material's.
      if (Object.prototype.hasOwnProperty.call(v, 'side')) delete (v as unknown as Record<string, unknown>)['side'];
      return;
    }
    base.call(this, object, scene, camera, geometry, material, ...rest);
  };
}

/** The page flag that draws without projected decals (`?decals=off`: their cost, by comparison). */
export const DECALS_URL_PARAM = 'decals';

/** Whether a page's query string leaves projected decals on (the default) — `decals=off` or `0` turns them off. */
export function decalsFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(DECALS_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}
