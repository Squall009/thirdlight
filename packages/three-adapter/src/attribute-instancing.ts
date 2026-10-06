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
import { maxScaleOf, SphereSide, VIEW_CULL_KEY, type CullView, type ViewCullable } from './view-cull';

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
  /** Upload the matrices, draw `count` instances and refit the bounds (for culling). */
  markChanged(): void;
  /** Instance `i`'s matrix (mesh space). */
  getMatrixAt(i: number, out: THREE.Matrix4): THREE.Matrix4;
  /**
   * Free what this group made (its instance buffer, its geometry record, its
   * render objects); the source geometry's attributes stay with their owner.
   */
  dispose(): void;
}

const tmpMatrix = new THREE.Matrix4();
const tmpSphere = new THREE.Sphere();

/**
 * A mesh drawing `capacity` instances of `source` with `material` through
 * instance-matrix columns. The source geometry's attributes, index, groups
 * and draw range are shared, not copied.
 */
export function createAttributeInstancedMesh(source: THREE.BufferGeometry, material: THREE.Material, capacity: number, options: { readonly raycast?: boolean } = {}): AttributeInstancedMesh {
  installAttributeInstancing();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.name = source.name;
  for (const [name, a] of Object.entries(source.attributes)) geometry.setAttribute(name, a);
  if (source.index !== null) geometry.setIndex(source.index);
  for (const g of source.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  const array = new Float32Array(capacity * 16);
  // What the GPU reads: the same matrices, those the view sees first (`array` keeps its slots for writers).
  const drawn = new Float32Array(capacity * 16);
  // Static usage: three's WebGPURenderer uploads a dynamic-usage buffer on every draw whatever its version
  // (Skyforge's village: ~100 instance buffers a frame); this one is uploaded when `markChanged` bumps it.
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
  /** Instances in the drawn buffer, and those of them the view sees (the leading ones). */
  let drawnCount = 0;
  let inView = 0;
  /** The view and its stamp the order was made for (null: not culled since the last change: all are drawn). */
  let culledFor: CullView | null = null;
  let culledStamp = -1;
  /** Which slots were in view at the last cull, and the world matrix it was made with. */
  const seen = new Uint8Array(capacity);
  const world = new Float64Array(16);
  /** Each instance's world sphere (centre xyz, radius), and whether the matrices or the world moved since. */
  const spheres = new Float32Array(capacity * 4);
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
  const copySlotOrder = (): void => {
    drawn.set(array.subarray(0, drawnCount * 16));
    buffer.needsUpdate = true;
  };
  // Per pass: the view draws those in view, any other camera (a shadow map) all of them.
  mesh.onBeforeRender = (_r, _s, camera) => {
    geometry.instanceCount = culledFor !== null && culledStamp === culledFor.stamp && culledFor.is(camera) ? inView : drawnCount;
  };
  const handle: AttributeInstancedMesh = {
    mesh,
    capacity,
    array,
    count: 0,
    get inView() {
      return culledFor !== null && culledStamp === culledFor.stamp ? inView : drawnCount;
    },
    cull(view) {
      const n = drawnCount;
      const w = mesh.matrixWorld.elements;
      let sameWorld = true;
      for (let k = 0; k < 16; k += 1) if (world[k] !== w[k]) sameWorld = false;
      if ((sameWorld && culledFor === view && culledStamp === view.stamp) || n === 0) {
        culledFor = view;
        culledStamp = view.stamp;
        return false;
      }
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
      if (side === SphereSide.Outside) {
        inView = 0;
        seen.fill(0, 0, n);
        return false;
      }
      // Each instance's sphere (the source's, at its matrix and the mesh's), worked out once per change (the
      // depths sort them even when all are in view).
      if (spheresStale) {
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
        spheresStale = false;
      }
      // Not culled since the matrices changed: the order is the slots', whatever was seen before.
      let changed = wasFor === null;
      let count = 0;
      for (let i = 0; i < n; i += 1) {
        const v = side === SphereSide.Inside || view.side(spheres[i * 4]!, spheres[i * 4 + 1]!, spheres[i * 4 + 2]!, spheres[i * 4 + 3]!) !== SphereSide.Outside ? 1 : 0;
        if (seen[i] !== v) {
          seen[i] = v;
          changed = true;
        }
        count += v;
      }
      inView = count;
      if (!changed) return false;
      // Those in view first, nearest first (each pixel is shaded once where they overlap), then the rest (the
      // shadow passes draw them all).
      let k = 0;
      for (let i = 0; i < n; i += 1) {
        if (seen[i] !== 1) continue;
        order[k] = i;
        depths[i] = view.depth(spheres[i * 4]!, spheres[i * 4 + 1]!, spheres[i * 4 + 2]!);
        k += 1;
      }
      order.subarray(0, k).sort((a, b) => depths[a]! - depths[b]!);
      for (let i = 0; i < n; i += 1) if (seen[i] !== 1) order[k++] = i;
      for (let at = 0; at < n; at += 1) {
        const i = order[at]!;
        drawn.set(array.subarray(i * 16, i * 16 + 16), at * 16);
      }
      buffer.needsUpdate = true;
      sortAt(count > 0 ? order[0]! : -1);
      return true;
    },
    markChanged() {
      const n = Math.max(0, Math.min(capacity, handle.count));
      geometry.instanceCount = n;
      drawnCount = n;
      // Matrices or the count changed: drawn in slot order (all of them) until the view culls them again.
      copySlotOrder();
      culledFor = null;
      spheresStale = true;
      // The bounds of every instance (three culls the mesh by its geometry's sphere).
      const src = source.boundingSphere!;
      bounds.makeEmpty();
      for (let i = 0; i < n; i += 1) {
        tmpMatrix.fromArray(array, i * 16);
        bounds.union(tmpSphere.copy(src).applyMatrix4(tmpMatrix));
      }
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
