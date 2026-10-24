/**
 * Instancing that shares node programs.
 *
 * three r186 builds a node program for every `InstancedMesh` on its own: the
 * render object's cache key holds the instanced object's `uuid` (its matrices
 * are bound into the program's nodes). A scene whose repeated objects form
 * hundreds of instanced groups (many materials × many meshes) then builds
 * hundreds of identical programs before its first frame — measured: 573
 * builds, ~4.5 s of the large benchmark's first frame on the GPU host.
 *
 * Here the instance matrices are instead a vertex attribute of the drawn
 * geometry (an `InstancedBufferGeometry` that shares the source geometry's
 * vertex attributes and index, plus four `vec4` columns of one interleaved
 * instanced buffer, {@link INSTANCE_MATRIX_ATTRIBUTE}0–3), drawn by a plain
 * `THREE.Mesh`. The key then holds no object id: every group with the same
 * material and vertex layout shares one program. Every node material (also
 * the renderer's shadow-pass material) applies the matrices at the point
 * where three applies an `InstancedMesh`'s — before the material's own
 * `positionNode` — when the geometry it draws carries the columns
 * ({@link installAttributeInstancing}). Geometry without them is untouched.
 */
import * as THREE from 'three';
import { RenderObjectRefreshType } from 'three';
import { attribute, Fn, instanceIndex, mat4, normalLocal, positionLocal, positionPrevious, storage, transformNormal, uint, uniform, type vec3 } from 'three/tsl';
import { NodeMaterial, StorageBufferAttribute, type NodeBuilder } from 'three/webgpu';
import { disposeSharingGeometry } from './dispose';
import { instanceSphereBounds } from './instance-prepare';
import { SEE_THROUGH_MEMBERS_KEY, type SeeThroughMembers } from './see-through-occluders';
import { maxScaleOf, SphereSide, STATIC_SHADOW_CAMERA_KEY, VIEW_CULL_KEY, type CullView, type ViewCullable } from './view-cull';

/** The name prefix of the four instance-matrix columns (`…0` to `…3`, `vec4` each). */
export const INSTANCE_MATRIX_ATTRIBUTE = 'tlInstanceMatrix';

/**
 * The marker of a draw whose instances carry paint slots (vertex-paint-draw.ts):
 * a view of each matrix's float 3 (the first column's `w`, the unused fourth
 * row of an affine matrix), never read by a shader. It is in the geometry so
 * the painted draw's vertex layout, and so its program, is its own.
 */
export const PAINT_SLOT_ATTRIBUTE = 'tlPaintSlot';
/** Floats an instance takes in a drawn buffer: its column-major matrix (the paint slot and marks ride in its fourth row). */
export const INSTANCE_MATRIX_FLOATS = 16;

/** Where in an instance's 16 floats its paint slot rides. */
const PAINT_SLOT_FLOAT = 3;

/**
 * The marker of a draw whose copies are culled on the GPU (occlusion
 * culling's depth pyramid, `occlusion-instances.ts`): a view of each
 * matrix's float 7 (the second column's `w`, also unused), never read. Its
 * build reads the copy's matrix through the frame's compacted list when the
 * view draws it culled (a program of its own, made only while that culling
 * is on; every other draw keeps the program it had).
 */
export const CULLED_COPIES_ATTRIBUTE = 'tlCulledCopies';
const CULLED_MARKER_FLOAT = 7;

/** The columns' names. */
const COLUMNS = [0, 1, 2, 3].map((i) => `${INSTANCE_MATRIX_ATTRIBUTE}${i}`);

const geometryOfBuild = (builder: NodeBuilder): THREE.BufferGeometry | null => {
  const g = (builder as unknown as { geometry?: THREE.BufferGeometry | null }).geometry;
  return g !== null && g !== undefined && typeof g.getAttribute === 'function' ? g : null;
};

/** Whether a node build draws a geometry with instance-matrix columns. */
export function buildHasInstanceColumns(builder: NodeBuilder): boolean {
  return geometryOfBuild(builder)?.getAttribute(COLUMNS[3]!) !== undefined;
}

/** Whether a node build draws copies the GPU may cull (they are read through a list). */
function buildReadsCulledCopies(builder: NodeBuilder): boolean {
  return geometryOfBuild(builder)?.getAttribute(CULLED_COPIES_ATTRIBUTE) !== undefined;
}

/** `mesh.userData[CULLED_COPIES_KEY]`: where a draw culled on the GPU reads its copies in the draw being made. */
export const CULLED_COPIES_KEY = '__tlCulledCopies';

/** What the vertex stage of a culled draw reads (set per draw, right before it, by the culler's {@link InstanceIndirect}). */
export interface CulledCopies {
  /**
   * Every culled draw's copies (four vec4 columns each, as drawn) by slot, each draw's drawn order (the slot at
   * each place) and the frame's compacted lists (places).
   */
  readonly matrices: StorageBufferAttribute;
  readonly slots: StorageBufferAttribute;
  readonly lists: StorageBufferAttribute;
  /** The draw's first copy in `matrices`, and its capacity (the length of each of its two lists). */
  readonly base: number;
  readonly cap: number;
  /**
   * Where this draw's first pass list starts in `lists` (never 0); its second follows `cap` later. 0: the copies
   * are drawn from the columns in their order. `lists[0]` holds the pass the GPU is drawing (0: the first, 1:
   * the second), written by the culling dispatches, so a draw's uniforms stay the same in both passes.
   */
  readonly list: number;
}

/** Bound where a draw has no pools (never read: its list is 0). */
const NO_MATRICES = new StorageBufferAttribute(new Float32Array(4), 4);
const NO_LISTS = new StorageBufferAttribute(new Uint32Array(4), 1);
const NO_SLOTS = new StorageBufferAttribute(new Uint32Array(4), 1);
const culledMatrices = storage(NO_MATRICES, 'vec4', 1).toReadOnly();
const culledSlots = storage(NO_SLOTS, 'uint', 1).toReadOnly();
const culledLists = storage(NO_LISTS, 'uint', 1).toReadOnly();
/** The drawn object's list (+1; 0: none), and on the way the pools its build binds. */
const culledList = uniform(0, 'uint').onObjectUpdate(({ object }) => {
  const c = object?.userData[CULLED_COPIES_KEY] as CulledCopies | undefined;
  culledMatrices.value = c?.matrices ?? NO_MATRICES;
  culledSlots.value = c?.slots ?? NO_SLOTS;
  culledLists.value = c?.lists ?? NO_LISTS;
  return c?.list ?? 0;
});
const culledBase = uniform(0, 'uint').onObjectUpdate(({ object }) => (object?.userData[CULLED_COPIES_KEY] as CulledCopies | undefined)?.base ?? 0);
const culledCap = uniform(0, 'uint').onObjectUpdate(({ object }) => (object?.userData[CULLED_COPIES_KEY] as CulledCopies | undefined)?.cap ?? 0);
type U = ReturnType<typeof uint>;
/** The copy's place in the draw's drawn order: the instance itself, or the list's entry for it. */
const culledPlace = (): U => {
  const pass = culledLists.element(uint(0)) as unknown as U;
  const start = (culledList as unknown as U).add(pass.mul(culledCap as unknown as U));
  const listed = culledLists.element(start.add(instanceIndex)) as unknown as U;
  return (culledList as unknown as U).greaterThan(0).select(listed, instanceIndex) as unknown as U;
};

/**
 * The copy's per-instance vec4 `name` (vertex stage): the geometry's
 * attribute, or, in a draw the GPU culls, the same 4 floats from the pools at
 * the place the list names (vec4 `i` of the copy's 16 floats as drawn).
 */
export function culledCopyVec4(name: string, i: number): ReturnType<typeof attribute<'vec4'>> {
  return Fn((builder: NodeBuilder) => {
    const own = attribute<'vec4'>(name, 'vec4');
    if (!buildReadsCulledCopies(builder)) return own;
    // The pools hold copies by slot (written only when one changes); the draw's order says which slot a place holds.
    const base = culledBase as unknown as U;
    const slot = culledSlots.element(base.add(culledPlace())) as unknown as U;
    const fromPool = culledMatrices.element(base.add(slot).mul(4).add(i));
    return (culledList as unknown as U).greaterThan(0).select(fromPool, own);
  })() as unknown as ReturnType<typeof attribute<'vec4'>>;
}

/**
 * Column `i` of this copy's matrix (vertex stage): the geometry's attribute,
 * or, in a draw the GPU culls, the same 4 floats from the pools (the columns'
 * values as drawn: the paint slot in float 3 comes with them).
 */
export function instanceColumn(i: number): ReturnType<typeof attribute<'vec4'>> {
  return culledCopyVec4(COLUMNS[i]!, i);
}

/** This copy's place in its draw's drawn order (what `instanceIndex` is for a draw drawn whole; vertex stage). */
export function instanceDrawnIndex(): U {
  return Fn((builder: NodeBuilder) => (buildReadsCulledCopies(builder) ? culledPlace() : instanceIndex))() as unknown as U;
}

/** The instance matrix read from the geometry's columns (vertex stage). */
export function instanceMatrixFromColumns(): ReturnType<typeof mat4> {
  return mat4(instanceColumn(0), instanceColumn(1), instanceColumn(2), instanceColumn(3)) as unknown as ReturnType<typeof mat4>;
}

/** The instance's translation from the columns (vertex stage). */
export function instanceOriginFromColumns(): ReturnType<typeof vec3> {
  return (instanceColumn(3) as unknown as { xyz: ReturnType<typeof vec3> }).xyz;
}

/** What three's `instance()` does for an `InstancedMesh`, with the matrix from the columns. */
const applyColumns = Fn((builder: NodeBuilder) => {
  const m = instanceMatrixFromColumns() as unknown as { mul(v: unknown): { xyz: unknown } };
  (positionLocal as unknown as { assign(v: unknown): void }).assign(m.mul(positionLocal).xyz);
  const b = builder as unknown as { needsPreviousData?: () => boolean; hasGeometryAttribute?: (name: string) => boolean };
  // Velocity passes: the columns are the current matrices (no previous copy; batches are redrawn every frame).
  if (b.needsPreviousData?.() === true) (positionPrevious as unknown as { assign(v: unknown): void }).assign(m.mul(positionPrevious).xyz);
  if (b.hasGeometryAttribute?.('normal') === true) (normalLocal as unknown as { assign(v: unknown): void }).assign(transformNormal(normalLocal, m as never));
}, 'void');

/** What a culled draw's vertex stage last read, per render object (each camera's draw has its own). */
const culledSeen = new WeakMap<object, { list: number; base: number; cap: number; matrices: unknown; slots: unknown; lists: unknown }>();

/** A full refresh whenever what the render object's culled draw reads changed since its last draw, else three's own answer. */
function refreshOnCulledChange(base: (renderObject: { object: THREE.Object3D }, frame: unknown) => number): (renderObject: { object: THREE.Object3D }, frame: unknown) => number {
  return (renderObject, frame) => {
    const refresh = base(renderObject, frame);
    const c = renderObject.object.userData[CULLED_COPIES_KEY] as CulledCopies | undefined;
    const list = c?.list ?? 0;
    const base0 = c?.base ?? 0;
    const cap = c?.cap ?? 0;
    const matrices = c?.matrices ?? NO_MATRICES;
    const slots = c?.slots ?? NO_SLOTS;
    const lists = c?.lists ?? NO_LISTS;
    const was = culledSeen.get(renderObject);
    if (was !== undefined && was.list === list && was.base === base0 && was.cap === cap && was.matrices === matrices && was.slots === slots && was.lists === lists) return refresh;
    if (was === undefined) culledSeen.set(renderObject, { list, base: base0, cap, matrices, slots, lists });
    else Object.assign(was, { list, base: base0, cap, matrices, slots, lists });
    return RenderObjectRefreshType.FULL;
  };
}

let installed = false;
/** Whether three's `setupObserver` was there to wrap: without the refresh, culled draws could keep pools that were replaced. */
let culledRefreshInstalled = false;

/** Whether a draw's copies may be culled on the GPU here (the refresh its vertex stage needs is installed). */
export function culledCopiesSupported(): boolean {
  installAttributeInstancing();
  return culledRefreshInstalled;
}

/**
 * Teach every node material to draw instance-matrix columns (idempotent).
 * three's `NodeMaterial.setupPosition` applies morphs, skinning,
 * displacement and an `InstancedMesh`'s matrices, then the material's
 * `positionNode`; the columns are applied first here, which is the same for
 * the geometry that carries them (batches take no morphed, skinned or
 * displaced mesh — `batchRefusal`).
 */
export function installAttributeInstancing(): void {
  if (installed) return;
  installed = true;
  const proto = NodeMaterial.prototype as unknown as { setupPosition(builder: NodeBuilder): unknown; setupObserver(builder: NodeBuilder): unknown };
  const base = proto.setupPosition;
  proto.setupPosition = function setupPositionWithColumns(this: unknown, builder: NodeBuilder): unknown {
    if (buildHasInstanceColumns(builder)) applyColumns();
    return base.call(this, builder);
  };
  // three refreshes an object's own uniforms and bindings only when its observer sees a change it knows of; what a
  // culled draw's vertex stage reads (its list, its range, the pools, which may be made anew) is not among them.
  const observe = proto.setupObserver;
  if (typeof observe === 'function') {
    culledRefreshInstalled = true;
    proto.setupObserver = function setupObserverOfCulled(this: unknown, builder: NodeBuilder): unknown {
      const observer = observe.call(this, builder) as { needsRefresh?: (renderObject: { object: THREE.Object3D }, frame: unknown) => number } | null;
      if (observer !== null && typeof observer === 'object' && typeof observer.needsRefresh === 'function' && buildReadsCulledCopies(builder)) observer.needsRefresh = refreshOnCulledChange(observer.needsRefresh.bind(observer));
      return observer;
    };
  }
}

/**
 * Which instances of a group are drawn at all, decided per view before it is
 * culled (an instance set's levels of detail and density per copy,
 * `instance-lod.ts`): an instance it leaves out is drawn by no pass.
 */
export interface InstanceFilter {
  /**
   * Bring the decisions up to date for `view` and the draw's world matrix; returns a number that changes whenever
   * they did. `sameWorld`: the world matrix is the one the draw passed last time.
   */
  prepare(view: CullView, world: ArrayLike<number>, sameWorld: boolean): number;
  /** Whether instance `slot` is drawn. */
  includes(slot: number): boolean;
  /** The slots drawn, ascending (the first `slotCount()`; valid until the decisions change). */
  slots(): Uint32Array;
  slotCount(): number;
  /** Whether the draw holds every instance in a pass that must not depend on the view (a cached static shadow map; else none there). */
  readonly full: boolean;
}

/** Filtered draws hidden because the frame's passes draw none of their instances. */
const emptyDraws = new Set<THREE.Mesh>();

/**
 * Run `draw` (a pass whose draws must not depend on the view: a cached static
 * shadow map) with the filtered draws the view left empty shown: such a pass
 * draws a filtered group by `InstanceFilter.full`, not by what the view kept.
 */
export function withEmptyInstanceDraws(draw: () => void): void {
  if (emptyDraws.size === 0) {
    draw();
    return;
  }
  const shown = [...emptyDraws];
  for (const m of shown) m.visible = true;
  try {
    draw();
  } finally {
    for (const m of shown) m.visible = !emptyDraws.has(m);
  }
}

/**
 * What the view's draw holds for culling on the GPU: the first `count`
 * places of the drawn buffer (`drawn`, 16 floats a place) are in view, place
 * p holds slot `order[p]`, whose world sphere is `spheres[slot * 4 …]`.
 * `version` changes whenever the drawn buffer is written.
 */
export interface InstanceViewDraw {
  readonly version: number;
  readonly count: number;
  readonly drawn: Float32Array;
  readonly order: Uint32Array;
  readonly spheres: Float32Array;
  /**
   * The copies by slot, where the draw has them: its first `count` slots' 16 floats as drawn (`write` puts them
   * at copy `at` of `target`) and their spheres. `version` changes when a slot's copy or sphere does, not when
   * the view only puts them in another order (a moving camera), so a culler keeps them by slot and takes only
   * the order each frame. Absent: only the drawn places are known (they are copied as drawn).
   */
  readonly slots?: { readonly version: number; readonly count: number; write(target: Float32Array, at: number): void };
}

/** How a draw culled on the GPU is drawn by one pass (the culler's; occlusion-instances.ts). */
export interface InstanceIndirect {
  /** Right before a draw: set `geometry`'s indirect slot (or none) and what the vertex stage reads; `view`: the view's culled draw. */
  draw(geometry: THREE.InstancedBufferGeometry, view: boolean): void;
  /** The draw is gone. */
  release(): void;
}

/** `scene.userData[INSTANCE_CULLER_KEY]`: a culler that adopts each draw whose copies it may cull before it is first drawn. */
export const INSTANCE_CULLER_KEY = '__tlInstanceCuller';
export interface InstanceCullerHost {
  adopt(draw: CullableCopies): void;
}

/**
 * A draw of copies the GPU may cull one by one: groups drawn through instance-matrix columns
 * ({@link AttributeInstancedMesh}, found by `VIEW_CULL_KEY`) and terrain pages' nodes (found by
 * {@link CULLABLE_COPIES_KEY}). Its vertex stage reads each copy's vec4s through {@link culledCopyVec4}.
 */
export interface CullableCopies {
  readonly mesh: THREE.Mesh;
  /** The most copies it holds (a draw that outgrows it is a new one). */
  readonly capacity: number;
  /** What the view's draw holds, as culled for the current view (null: not culled for it; every pass draws all). */
  viewDraw(): InstanceViewDraw | null;
  /** The culler drawing the view's draw on the GPU (null: none). */
  indirect: InstanceIndirect | null;
  /** Mark the geometry as culled on the GPU (or not): its builds read copies through a list ({@link CULLED_COPIES_ATTRIBUTE}). */
  markCulled(on: boolean): void;
  /** Its copies are tested as their world boxes, which each drawn copy carries in its floats from `COPY_BOX_FLOAT` (else as their spheres). */
  readonly boxes?: boolean;
}

/** `mesh.userData[CULLABLE_COPIES_KEY]`: the {@link CullableCopies} of a draw not culled inside by the view (a terrain page). */
export const CULLABLE_COPIES_KEY = '__tlCullableCopies';

/** One group drawn through instance-matrix columns (culled per instance in the view: `view-cull.ts`). */
export interface AttributeInstancedMesh extends ViewCullable, CullableCopies {
  /** The drawn mesh (a plain `THREE.Mesh`; its matrix is the identity). */
  readonly mesh: THREE.Mesh;
  /** Slots (16 floats each: a column-major matrix per instance). */
  readonly capacity: number;
  /** The instance matrices, `capacity × 16` (write, then {@link markChanged}). */
  readonly array: Float32Array;
  /** Instances drawn. */
  count: number;
  /** Instances the view's pass draws, as last culled (`count` when not culled). */
  readonly inView: number;
  /** Instances any other pass draws (a shadow map): those the filter keeps (`count` without one). */
  readonly included: number;
  /**
   * Upload the matrices, draw `count` instances and refit the bounds (for
   * culling); `bounds` (centre xyz, radius; radius < 0: empty) when they are
   * known already (made on a worker, or unchanged).
   */
  markChanged(bounds?: ArrayLike<number>): void;
  /**
   * Each slot's paint slot + 1 (0: unpainted), `capacity` long, on a draw made
   * `painted` (else null): written into the drawn buffer beside the matrices
   * at {@link markChanged}.
   */
  readonly paintSlots: Float32Array | null;
  /** Instance `i`'s matrix (mesh space). */
  getMatrixAt(i: number, out: THREE.Matrix4): THREE.Matrix4;
  /** What the view's draw holds, as culled for the current view (null: not culled for it; every pass draws all). */
  viewDraw(): InstanceViewDraw | null;
  /** The culler drawing this group's view draw on the GPU (null: none). */
  indirect: InstanceIndirect | null;
  /** Mark the geometry as culled on the GPU (or not): its builds read copies through a list ({@link CULLED_COPIES_ATTRIBUTE}). */
  markCulled(on: boolean): void;
  /**
   * Free what this group made (its instance buffer, its geometry record, its
   * render objects); the source geometry's attributes stay with their owner.
   */
  dispose(): void;
}

/**
 * Slots per culling block: a block's sphere is tested first and decides its
 * slots when it is wholly in or out of view (a large set's slots are in
 * spatial order, `instance-prepare.ts`, so its blocks are compact).
 */
export const CULL_BLOCK = 64;
/** Instances put in order exactly up to this many; past it by depth buckets (front to back closely enough, in linear time). */
const SORT_EXACT_MAX = 512;
const DEPTH_BUCKETS = 256;
const bucketCounts = new Uint32Array(DEPTH_BUCKETS + 1);

/** Put the first `k` slots of `order` nearest first by `depths` (see {@link SORT_EXACT_MAX}). */
export function orderByDepth(order: Uint32Array, k: number, depths: Float32Array, scratch: Uint32Array): void {
  if (k <= SORT_EXACT_MAX) {
    order.subarray(0, k).sort((a, b) => depths[a]! - depths[b]!);
    return;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < k; j += 1) {
    const d = depths[order[j]!]!;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  if (!(hi > lo)) return;
  const scale = (DEPTH_BUCKETS - 1) / (hi - lo);
  bucketCounts.fill(0);
  for (let j = 0; j < k; j += 1) bucketCounts[((depths[order[j]!]! - lo) * scale) | 0]! += 1;
  // Each bucket's start, then the slots in, each bucket in slot order.
  let at = 0;
  for (let b = 0; b < DEPTH_BUCKETS; b += 1) {
    const c = bucketCounts[b]!;
    bucketCounts[b] = at;
    at += c;
  }
  for (let j = 0; j < k; j += 1) {
    const i = order[j]!;
    const b = ((depths[i]! - lo) * scale) | 0;
    scratch[bucketCounts[b]!] = i;
    bucketCounts[b]! += 1;
  }
  order.set(scratch.subarray(0, k));
}

const tmpMatrix = new THREE.Matrix4();
const tmpCenter = new THREE.Vector3();
const sphereSource = new Float64Array(4);
const sphereOut = new Float64Array(4);

/**
 * A mesh drawing `capacity` instances of `source` with `material` through
 * instance-matrix columns. The source geometry's attributes, index, groups
 * and draw range are shared, not copied.
 */
/**
 * A group's instances as see-through members (the source's bounds at each instance's matrix, in world space), so
 * see-through fades the instances in front of a subject, not the whole group.
 */
function withInstanceMembers(handle: AttributeInstancedMesh, source: THREE.BufferGeometry): AttributeInstancedMesh {
  const m = new THREE.Matrix4();
  // The members' bounds change only when the matrices are marked changed.
  let changes = 0;
  const mark = handle.markChanged.bind(handle);
  handle.markChanged = (bounds) => {
    changes += 1;
    mark(bounds);
  };
  const members: SeeThroughMembers = {
    count: () => handle.count,
    box: (i, out) => {
      if (source.boundingBox === null) source.computeBoundingBox();
      const b = source.boundingBox;
      if (b === null || b.isEmpty()) return false;
      out.copy(b).applyMatrix4(m.fromArray(handle.array, i * INSTANCE_MATRIX_FLOATS).premultiply(handle.mesh.matrixWorld));
      return true;
    },
    stamp: () => changes,
  };
  handle.mesh.userData[SEE_THROUGH_MEMBERS_KEY] = members;
  return handle;
}

export function createAttributeInstancedMesh(source: THREE.BufferGeometry, material: THREE.Material, capacity: number, options: {
    readonly raycast?: boolean;
    readonly filter?: InstanceFilter;
    readonly group?: ViewCullable;
    /** The slots' matrices, written already (`capacity × 16`; taken, not copied). */
    readonly matrices?: Float32Array;
    /** The instances carry paint slots (`paintSlots`; a draw of its own program). */
    readonly painted?: boolean;
  } = {}): AttributeInstancedMesh {
  const filter = options.filter;
  installAttributeInstancing();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.name = source.name;
  for (const [name, a] of Object.entries(source.attributes)) geometry.setAttribute(name, a);
  if (source.index !== null) geometry.setIndex(source.index);
  for (const g of source.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  const array = options.matrices !== undefined && options.matrices.length >= capacity * INSTANCE_MATRIX_FLOATS ? options.matrices : new Float32Array(capacity * INSTANCE_MATRIX_FLOATS);
  // What the GPU reads: the same matrices, those the view sees first (`array` keeps its slots for writers).
  const drawn = new Float32Array(capacity * INSTANCE_MATRIX_FLOATS);
  // Static usage: three's WebGPURenderer uploads a dynamic-usage buffer on every draw whatever its version
  // (a scene of many instance sets: a hundred buffers a frame); this one is uploaded when `markChanged` bumps it.
  const buffer = new THREE.InstancedInterleavedBuffer(drawn, INSTANCE_MATRIX_FLOATS, 1);
  const columns = COLUMNS.map((name, i) => {
    const column = new THREE.InterleavedBufferAttribute(buffer, 4, i * 4);
    geometry.setAttribute(name, column);
    return column;
  });
  const paintSlots = options.painted === true ? new Float32Array(capacity) : null;
  if (paintSlots !== null) {
    const marker = new THREE.InterleavedBufferAttribute(buffer, 1, PAINT_SLOT_FLOAT);
    geometry.setAttribute(PAINT_SLOT_ATTRIBUTE, marker);
    columns.push(marker);
  }
  geometry.instanceCount = 0;
  if (source.boundingSphere === null) source.computeBoundingSphere();
  geometry.boundingSphere = new THREE.Sphere();
  geometry.boundingBox = new THREE.Box3();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  let disposed = false;
  /** Instances in the drawn buffer, those of them drawn at all (the leading ones) and those the view sees (leading those). */
  let drawnCount = 0;
  let includedCount = 0;
  let inView = 0;
  /** The filter's answer when the order was made. */
  let filterVersion = Number.NaN;
  /** The view and its stamp the order was made for (null: not culled since the last change: all are drawn). */
  let culledFor: CullView | null = null;
  let culledStamp = -1;
  /** Each slot at the last cull: in view (1), drawn but out of view (2), or left out by the filter (0); and the world matrix it was made with. */
  const seen = new Uint8Array(capacity);
  const world = new Float64Array(16);
  /** Each instance's world sphere (centre xyz, radius), and whether the matrices or the world moved since. */
  const spheres = new Float32Array(capacity * 4);
  /** Each block of {@link CULL_BLOCK} slots' sphere (world), and its side of the view in the current cull (-1: not tested yet). */
  const blocks = new Float32Array(Math.ceil(capacity / CULL_BLOCK) * 4);
  const blockSides = new Int8Array(Math.ceil(capacity / CULL_BLOCK));
  const sortScratch = new Uint32Array(capacity);
  /** The drawn order (slots), and each slot's depth in the view when it was put in order. */
  const order = new Uint32Array(capacity);
  const depths = new Float32Array(capacity);
  let spheresStale = true;
  /** Bumped whenever the drawn buffer is written (a culler on the GPU takes the order again). */
  let version = 0;
  /** Bumped whenever a slot's matrix, paint slot or sphere changes (a culler on the GPU copies the slots again). */
  let slotsVersion = 0;
  /** Drawn at least once (its render objects exist: a new program needs the material's version bumped). */
  let drawnOnce = false;
  /**
   * Where three sorts the draw among the opaque ones: by its bounding sphere's centre. The group's own centre is
   * somewhere amid members spread over the scene, so the draw came before or after the objects round it at
   * random and shaded pixels they cover again; at the nearest member in view it is drawn about when that member
   * would be. The sphere still holds every instance (three culls the draw by it in every pass).
   */
  const bounds = new THREE.Sphere();
  const sortAt = (slot: number): void => {
    const sphere = geometry.boundingSphere!;
    if (slot < 0 || bounds.isEmpty()) {
      sphere.copy(bounds);
      return;
    }
    const src = source.boundingSphere!;
    sphere.center.copy(src.center).applyMatrix4(tmpMatrix.fromArray(array, slot * INSTANCE_MATRIX_FLOATS));
    sphere.radius = bounds.radius + sphere.center.distanceTo(bounds.center);
  };
  /**
   * Write the drawn buffer in `order`: its first `drawnCount` slots, or only those drawn at all where no pass
   * draws the others (a filter not drawn whole in the cached static shadow map).
   */
  /**
   * Whether the drawn buffer holds every instance, those the filter leaves out
   * last: only where a cached static shadow map draws the whole group (its
   * filter's first level, a mesh that casts). Else the rest are never
   * written, nor uploaded.
   */
  const holdsAll = (): boolean => filter === undefined || (filter.full && mesh.castShadow);
  /** What the drawn buffer held when it was last written. */
  let wroteAll = false;
  const writeOrder = (): void => {
    wroteAll = holdsAll();
    const len = wroteAll ? drawnCount : includedCount;
    // Sixteen floats a copy by hand: a view of each slot would be an allocation per copy per cull.
    for (let at = 0; at < len; at += 1) {
      const from = order[at]! * INSTANCE_MATRIX_FLOATS;
      const to = at * INSTANCE_MATRIX_FLOATS;
      for (let k = 0; k < INSTANCE_MATRIX_FLOATS; k += 1) drawn[to + k] = array[from + k]!;
    }
    // Each instance's paint slot travels with it in the order.
    if (paintSlots !== null) for (let at = 0; at < len; at += 1) drawn[at * INSTANCE_MATRIX_FLOATS + PAINT_SLOT_FLOAT] = paintSlots[order[at]!]!;
    // Only what was written goes to the GPU (a large group's view moves every frame).
    buffer.addUpdateRange(0, len * INSTANCE_MATRIX_FLOATS);
    buffer.needsUpdate = true;
    version += 1;
  };
  const copySlotOrder = (): void => {
    if (filter === undefined) {
      drawn.set(array.subarray(0, drawnCount * INSTANCE_MATRIX_FLOATS));
      if (paintSlots !== null) for (let i = 0; i < drawnCount; i += 1) drawn[i * INSTANCE_MATRIX_FLOATS + PAINT_SLOT_FLOAT] = paintSlots[i]!;
      buffer.addUpdateRange(0, drawnCount * INSTANCE_MATRIX_FLOATS);
      buffer.needsUpdate = true;
      version += 1;
      includedCount = drawnCount;
      wroteAll = true;
      return;
    }
    // Not culled yet: the filter's last decisions, those it keeps first.
    const slots = filter.slots();
    const m = filter.slotCount();
    seen.fill(0, 0, drawnCount);
    let k = 0;
    for (let j = 0; j < m; j += 1) {
      const i = slots[j]!;
      if (i >= drawnCount) continue;
      order[k++] = i;
      seen[i] = 2;
    }
    includedCount = k;
    if (holdsAll()) for (let i = 0; i < drawnCount; i += 1) if (seen[i] === 0) order[k++] = i;
    writeOrder();
    showIfDrawn();
  };
  // Per pass: the view draws those in view, any other camera (a shadow map) all that are drawn.
  mesh.onBeforeRender = (_r, scene, camera) => {
    // A culler on the GPU takes the draw before its first render object is made (its build reads the copies by list).
    if (!drawnOnce) {
      (scene?.userData[INSTANCE_CULLER_KEY] as InstanceCullerHost | undefined)?.adopt(handle);
      drawnOnce = true;
    }
    const view = culledFor !== null && culledStamp === culledFor.stamp && culledFor.is(camera);
    if (view) geometry.instanceCount = inView;
    else if (filter !== undefined && camera.userData[STATIC_SHADOW_CAMERA_KEY] === true) geometry.instanceCount = filter.full && wroteAll ? drawnCount : 0;
    else geometry.instanceCount = includedCount;
    // The view's culled draw draws what the GPU kept of those in view; every other pass draws as above.
    handle.indirect?.draw(geometry, view);
  };
  const marker = new THREE.InterleavedBufferAttribute(buffer, 1, CULLED_MARKER_FLOAT);
  const bySlot = {
    version: 0,
    count: 0,
    write(target: Float32Array, at: number): void {
      target.set(array.subarray(0, drawnCount * INSTANCE_MATRIX_FLOATS), at * INSTANCE_MATRIX_FLOATS);
      // Each slot's paint slot rides in its copy as it does in the drawn buffer.
      if (paintSlots !== null) for (let i = 0; i < drawnCount; i += 1) target[(at + i) * INSTANCE_MATRIX_FLOATS + PAINT_SLOT_FLOAT] = paintSlots[i]!;
    },
  };
  const viewDrawn = { version: 0, count: 0, drawn, order, spheres, slots: bySlot };
  /**
   * A draw holding nothing in the frame's passes leaves three's walks (as a merged cell with nothing to draw
   * does): three sets up every visible object of a pass even when it draws no instance, and an instance set
   * with levels keeps a draw per level in every chunk, most of them empty. A cached static shadow map shows
   * them again while it is drawn ({@link withEmptyInstanceDraws}).
   */
  const showIfDrawn = (): void => {
    if (filter === undefined) return;
    mesh.visible = includedCount > 0;
    if (mesh.visible) emptyDraws.delete(mesh);
    else emptyDraws.add(mesh);
  };
  const handle: AttributeInstancedMesh = {
    mesh,
    ...(options.group !== undefined ? { group: options.group } : {}),
    capacity,
    array,
    paintSlots,
    count: 0,
    get inView() {
      return culledFor !== null && culledStamp === culledFor.stamp ? inView : includedCount;
    },
    get included() {
      return includedCount;
    },
    cull(view) {
      const n = drawnCount;
      const w = mesh.matrixWorld.elements;
      let sameWorld = true;
      for (let k = 0; k < 16; k += 1) {
        if (world[k] !== w[k]) {
          sameWorld = false;
          break;
        }
      }
      const fv = filter !== undefined ? filter.prepare(view, w, sameWorld) : 0;
      if ((sameWorld && culledFor === view && culledStamp === view.stamp && fv === filterVersion) || n === 0) {
        culledFor = view;
        culledStamp = view.stamp;
        return false;
      }
      const picksChanged = fv !== filterVersion;
      filterVersion = fv;
      if (!sameWorld) spheresStale = true;
      world.set(w);
      const wasFor = culledFor;
      culledFor = view;
      culledStamp = view.stamp;
      const all = bounds;
      const ws = maxScaleOf(w);
      const cx = w[0]! * all.center.x + w[4]! * all.center.y + w[8]! * all.center.z + w[12]!;
      const cy = w[1]! * all.center.x + w[5]! * all.center.y + w[9]! * all.center.z + w[13]!;
      const cz = w[2]! * all.center.x + w[6]! * all.center.y + w[10]! * all.center.z + w[14]!;
      const side = all.isEmpty() ? SphereSide.Inside : view.side(cx, cy, cz, all.radius * ws);
      if (side === SphereSide.Outside && filter === undefined) {
        // Nothing in view, every pass but the view's draws all: the order does not matter.
        inView = 0;
        seen.fill(2, 0, n);
        return false;
      }
      // Each instance's sphere (the source's, at its matrix and the mesh's), worked out once per change (the
      // depths sort them even when all are in view).
      if (spheresStale && side !== SphereSide.Outside) {
        const src = source.boundingSphere!;
        const sx = src.center.x;
        const sy = src.center.y;
        const sz = src.center.z;
        for (let i = 0; i < n; i += 1) {
          const o = i * INSTANCE_MATRIX_FLOATS;
          const lx = array[o]! * sx + array[o + 4]! * sy + array[o + 8]! * sz + array[o + 12]!;
          const ly = array[o + 1]! * sx + array[o + 5]! * sy + array[o + 9]! * sz + array[o + 13]!;
          const lz = array[o + 2]! * sx + array[o + 6]! * sy + array[o + 10]! * sz + array[o + 14]!;
          spheres[i * 4] = w[0]! * lx + w[4]! * ly + w[8]! * lz + w[12]!;
          spheres[i * 4 + 1] = w[1]! * lx + w[5]! * ly + w[9]! * lz + w[13]!;
          spheres[i * 4 + 2] = w[2]! * lx + w[6]! * ly + w[10]! * lz + w[14]!;
          spheres[i * 4 + 3] = src.radius * maxScaleOf(array, o) * ws;
        }
        slotsVersion += 1;
        // Each block of slots' sphere: around its instances' centres, grown by the largest of their radii.
        for (let b = 0; b * CULL_BLOCK < n; b += 1) {
          let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, r = 0;
          for (let i = b * CULL_BLOCK; i < Math.min(n, (b + 1) * CULL_BLOCK); i += 1) {
            const x = spheres[i * 4]!, y = spheres[i * 4 + 1]!, z = spheres[i * 4 + 2]!;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            if (z < z0) z0 = z;
            if (z > z1) z1 = z;
            if (spheres[i * 4 + 3]! > r) r = spheres[i * 4 + 3]!;
          }
          blocks[b * 4] = (x0 + x1) / 2;
          blocks[b * 4 + 1] = (y0 + y1) / 2;
          blocks[b * 4 + 2] = (z0 + z1) / 2;
          blocks[b * 4 + 3] = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + r;
        }
        spheresStale = false;
      }
      // A block wholly in or out of view decides its instances without a test each (worked out when first needed).
      blockSides.fill(-1);
      // Not culled since the matrices changed: the order is the slots', whatever was seen before.
      let changed = wasFor === null || holdsAll() !== wroteAll;
      let count = 0;
      // The slots drawn at all: every one, or the filter's list (a draw of one level loops over its own copies only).
      const slots = filter !== undefined ? filter.slots() : null;
      let m = filter !== undefined ? filter.slotCount() : n;
      if (filter !== undefined && picksChanged) {
        seen.fill(0, 0, n);
        changed = true;
      }
      if (slots !== null) while (m > 0 && slots[m - 1]! >= n) m -= 1;
      const blockSide = (i: number): number => {
        const b = Math.floor(i / CULL_BLOCK);
        let s = blockSides[b]!;
        if (s < 0) blockSides[b] = s = view.side(blocks[b * 4]!, blocks[b * 4 + 1]!, blocks[b * 4 + 2]!, blocks[b * 4 + 3]!);
        return s;
      };
      for (let j = 0; j < m; j += 1) {
        const i = slots !== null ? slots[j]! : j;
        const bs = side === SphereSide.Crossing ? blockSide(i) : side;
        const v = bs === SphereSide.Outside ? 2 : bs === SphereSide.Inside || view.side(spheres[i * 4]!, spheres[i * 4 + 1]!, spheres[i * 4 + 2]!, spheres[i * 4 + 3]!) !== SphereSide.Outside ? 1 : 2;
        if (seen[i] !== v) {
          seen[i] = v;
          changed = true;
        }
        if (v === 1) count += 1;
      }
      inView = count;
      if (!changed) return false;
      // Those in view first, nearest first (each pixel is shaded once where they overlap), then the rest drawn (the
      // shadow passes draw them all), then those the filter leaves out (no pass draws them; written only where the
      // cached static shadow map draws the whole group).
      let k = 0;
      for (let j = 0; j < m; j += 1) {
        const i = slots !== null ? slots[j]! : j;
        if (seen[i] !== 1) continue;
        order[k] = i;
        depths[i] = view.depth(spheres[i * 4]!, spheres[i * 4 + 1]!, spheres[i * 4 + 2]!);
        k += 1;
      }
      orderByDepth(order, k, depths, sortScratch);
      for (let j = 0; j < m; j += 1) {
        const i = slots !== null ? slots[j]! : j;
        if (seen[i] === 2) order[k++] = i;
      }
      includedCount = k;
      if (holdsAll()) for (let i = 0; i < n; i += 1) if (seen[i] === 0) order[k++] = i;
      writeOrder();
      showIfDrawn();
      sortAt(count > 0 ? order[0]! : -1);
      return true;
    },
    markChanged(known) {
      const n = Math.max(0, Math.min(capacity, handle.count));
      geometry.instanceCount = n;
      drawnCount = n;
      slotsVersion += 1;
      // Matrices or the count changed: drawn in slot order (all of them) until the view culls them again.
      copySlotOrder();
      culledFor = null;
      spheresStale = true;
      // The bounds of every instance (three culls the mesh by its geometry's sphere).
      const src = source.boundingSphere!;
      if (known === undefined) {
        sphereSource[0] = src.center.x;
        sphereSource[1] = src.center.y;
        sphereSource[2] = src.center.z;
        sphereSource[3] = src.radius;
        instanceSphereBounds(array, n, sphereSource, sphereOut);
      } else for (let k = 0; k < 4; k += 1) sphereOut[k] = known[k]!;
      if (sphereOut[3]! < 0) bounds.makeEmpty();
      else bounds.set(tmpCenter.set(sphereOut[0]!, sphereOut[1]!, sphereOut[2]!), sphereOut[3]!);
      geometry.boundingSphere!.copy(bounds);
      // The box around that sphere (bounds of the whole group; conservative, like the sphere).
      if (bounds.isEmpty()) geometry.boundingBox!.makeEmpty();
      else bounds.getBoundingBox(geometry.boundingBox!);
    },
    getMatrixAt(i, out) {
      return out.fromArray(array, i * INSTANCE_MATRIX_FLOATS);
    },
    viewDraw() {
      if (culledFor === null || culledStamp !== culledFor.stamp) return null;
      // One object, refreshed: asked for every draw every frame.
      viewDrawn.version = version;
      viewDrawn.count = inView;
      bySlot.version = slotsVersion;
      bySlot.count = drawnCount;
      return viewDrawn;
    },
    indirect: null,
    markCulled(on) {
      if ((geometry.getAttribute(CULLED_COPIES_ATTRIBUTE) !== undefined) === on) return;
      if (on) geometry.setAttribute(CULLED_COPIES_ATTRIBUTE, marker);
      else {
        geometry.deleteAttribute(CULLED_COPIES_ATTRIBUTE);
        geometry.indirect = null;
      }
      // three keeps a render object's program until its material's version changes.
      if (drawnOnce) (mesh.material as THREE.Material).needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handle.indirect?.release();
      handle.indirect = null;
      delete mesh.userData[VIEW_CULL_KEY];
      emptyDraws.delete(mesh);
      mesh.removeFromParent();
      // The render objects go with the object. The geometry shares the source's attributes and index,
      // which a plain `dispose` would free on the GPU while the source and its other groups still draw them.
      (mesh as unknown as { dispose?: () => void }).dispose?.();
      disposeSharingGeometry(geometry, columns);
    },
  };
  mesh.userData[VIEW_CULL_KEY] = handle;
  if (options.raycast === true) {
    // Like `InstancedMesh.raycast`: each drawn instance is hit as the source geometry at its matrix
    // (the hit names the instance: `instanceId`, and this mesh as its object). Its normals are turned
    // by the instance's matrix into this mesh's space, as any hit's are in its object's: this mesh
    // has no `getMatrixAt` a picker would know to apply, so a copy's rotation would be lost.
    const probe = new THREE.Mesh(source, material);
    const hits: THREE.Intersection[] = [];
    const world = new THREE.Matrix4();
    const bound = new THREE.Sphere();
    const turn = new THREE.Matrix3();
    mesh.raycast = (raycaster, intersects) => {
      const n = Math.min(capacity, handle.count);
      if (n === 0 || geometry.boundingSphere === null || geometry.boundingSphere.isEmpty()) return;
      if (!raycaster.ray.intersectsSphere(bound.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld))) return;
      probe.material = mesh.material;
      for (let i = 0; i < n; i += 1) {
        // Only what is drawn is picked (a copy at another level, or thinned out, is not here).
        if (filter !== undefined && !filter.includes(i)) continue;
        probe.matrixWorld = world.multiplyMatrices(mesh.matrixWorld, tmpMatrix.fromArray(array, i * INSTANCE_MATRIX_FLOATS));
        probe.raycast(raycaster, hits);
        if (hits.length > 0) turn.getNormalMatrix(tmpMatrix);
        for (const h of hits) {
          h.face?.normal.applyMatrix3(turn).normalize();
          h.normal?.applyMatrix3(turn).normalize();
          h.instanceId = i;
          h.object = mesh;
          intersects.push(h);
        }
        hits.length = 0;
      }
    };
  }
  return withInstanceMembers(handle, source);
}
