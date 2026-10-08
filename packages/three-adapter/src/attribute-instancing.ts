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
import { attribute, Fn, mat4, normalLocal, positionLocal, positionPrevious, transformNormal, type vec3 } from 'three/tsl';
import { NodeMaterial, type NodeBuilder } from 'three/webgpu';
import { disposeSharingGeometry } from './dispose';
import { instanceSphereBounds } from './instance-prepare';
import { maxScaleOf, SphereSide, STATIC_SHADOW_CAMERA_KEY, VIEW_CULL_KEY, type CullView, type ViewCullable } from './view-cull';

/** The name prefix of the four instance-matrix columns (`…0` to `…3`, `vec4` each). */
export const INSTANCE_MATRIX_ATTRIBUTE = 'tlInstanceMatrix';

/** The columns' names. */
const COLUMNS = [0, 1, 2, 3].map((i) => `${INSTANCE_MATRIX_ATTRIBUTE}${i}`);

/** Whether a node build draws a geometry with instance-matrix columns. */
export function buildHasInstanceColumns(builder: NodeBuilder): boolean {
  const g = (builder as unknown as { geometry?: THREE.BufferGeometry | null }).geometry;
  return g !== null && g !== undefined && typeof g.getAttribute === 'function' && g.getAttribute(COLUMNS[3]!) !== undefined;
}

/** The instance matrix read from the geometry's columns (vertex stage). */
export function instanceMatrixFromColumns(): ReturnType<typeof mat4> {
  return mat4(attribute(COLUMNS[0]!, 'vec4'), attribute(COLUMNS[1]!, 'vec4'), attribute(COLUMNS[2]!, 'vec4'), attribute(COLUMNS[3]!, 'vec4')) as unknown as ReturnType<typeof mat4>;
}

/** The instance's translation from the columns (vertex stage). */
export function instanceOriginFromColumns(): ReturnType<typeof vec3> {
  return (attribute(COLUMNS[3]!, 'vec4') as unknown as { xyz: ReturnType<typeof vec3> }).xyz;
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

let installed = false;

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
  const proto = NodeMaterial.prototype as unknown as { setupPosition(builder: NodeBuilder): unknown };
  const base = proto.setupPosition;
  proto.setupPosition = function setupPositionWithColumns(this: unknown, builder: NodeBuilder): unknown {
    if (buildHasInstanceColumns(builder)) applyColumns();
    return base.call(this, builder);
  };
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

/** One group drawn through instance-matrix columns (culled per instance in the view: `view-cull.ts`). */
export interface AttributeInstancedMesh extends ViewCullable {
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
  /** Instance `i`'s matrix (mesh space). */
  getMatrixAt(i: number, out: THREE.Matrix4): THREE.Matrix4;
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
export function createAttributeInstancedMesh(source: THREE.BufferGeometry, material: THREE.Material, capacity: number, options: { readonly raycast?: boolean; readonly filter?: InstanceFilter; readonly group?: ViewCullable; /** The slots' matrices, written already (`capacity × 16`; taken, not copied). */ readonly matrices?: Float32Array } = {}): AttributeInstancedMesh {
  const filter = options.filter;
  installAttributeInstancing();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.name = source.name;
  for (const [name, a] of Object.entries(source.attributes)) geometry.setAttribute(name, a);
  if (source.index !== null) geometry.setIndex(source.index);
  for (const g of source.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  const array = options.matrices !== undefined && options.matrices.length >= capacity * 16 ? options.matrices : new Float32Array(capacity * 16);
  // What the GPU reads: the same matrices, those the view sees first (`array` keeps its slots for writers).
  const drawn = new Float32Array(capacity * 16);
  // Static usage: three's WebGPURenderer uploads a dynamic-usage buffer on every draw whatever its version
  // (a scene of many instance sets: a hundred buffers a frame); this one is uploaded when `markChanged` bumps it.
  const buffer = new THREE.InstancedInterleavedBuffer(drawn, 16, 1);
  const columns = COLUMNS.map((name, i) => {
    const column = new THREE.InterleavedBufferAttribute(buffer, 4, i * 4);
    geometry.setAttribute(name, column);
    return column;
  });
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
    sphere.center.copy(src.center).applyMatrix4(tmpMatrix.fromArray(array, slot * 16));
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
      const from = order[at]! * 16;
      const to = at * 16;
      for (let k = 0; k < 16; k += 1) drawn[to + k] = array[from + k]!;
    }
    // Only what was written goes to the GPU (a large group's view moves every frame).
    buffer.addUpdateRange(0, len * 16);
    buffer.needsUpdate = true;
  };
  const copySlotOrder = (): void => {
    if (filter === undefined) {
      drawn.set(array.subarray(0, drawnCount * 16));
      buffer.addUpdateRange(0, drawnCount * 16);
      buffer.needsUpdate = true;
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
  mesh.onBeforeRender = (_r, _s, camera) => {
    if (culledFor !== null && culledStamp === culledFor.stamp && culledFor.is(camera)) geometry.instanceCount = inView;
    else if (filter !== undefined && camera.userData[STATIC_SHADOW_CAMERA_KEY] === true) geometry.instanceCount = filter.full && wroteAll ? drawnCount : 0;
    else geometry.instanceCount = includedCount;
  };
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
          const o = i * 16;
          const lx = array[o]! * sx + array[o + 4]! * sy + array[o + 8]! * sz + array[o + 12]!;
          const ly = array[o + 1]! * sx + array[o + 5]! * sy + array[o + 9]! * sz + array[o + 13]!;
          const lz = array[o + 2]! * sx + array[o + 6]! * sy + array[o + 10]! * sz + array[o + 14]!;
          spheres[i * 4] = w[0]! * lx + w[4]! * ly + w[8]! * lz + w[12]!;
          spheres[i * 4 + 1] = w[1]! * lx + w[5]! * ly + w[9]! * lz + w[13]!;
          spheres[i * 4 + 2] = w[2]! * lx + w[6]! * ly + w[10]! * lz + w[14]!;
          spheres[i * 4 + 3] = src.radius * maxScaleOf(array, o) * ws;
        }
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
      return out.fromArray(array, i * 16);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
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
    // (the hit names the instance: `instanceId`, and this mesh as its object).
    const probe = new THREE.Mesh(source, material);
    const hits: THREE.Intersection[] = [];
    const world = new THREE.Matrix4();
    const bound = new THREE.Sphere();
    mesh.raycast = (raycaster, intersects) => {
      const n = Math.min(capacity, handle.count);
      if (n === 0 || geometry.boundingSphere === null || geometry.boundingSphere.isEmpty()) return;
      if (!raycaster.ray.intersectsSphere(bound.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld))) return;
      probe.material = mesh.material;
      for (let i = 0; i < n; i += 1) {
        // Only what is drawn is picked (a copy at another level, or thinned out, is not here).
        if (filter !== undefined && !filter.includes(i)) continue;
        probe.matrixWorld = world.multiplyMatrices(mesh.matrixWorld, tmpMatrix.fromArray(array, i * 16));
        probe.raycast(raycaster, hits);
        for (const h of hits) {
          h.instanceId = i;
          h.object = mesh;
          intersects.push(h);
        }
        hits.length = 0;
      }
    };
  }
  return handle;
}
