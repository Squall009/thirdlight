/**
 * A brush stroke's paint drawn before it is stored (the editor's vertex paint
 * brush): the brush works on bytes the page holds, the GPU draws them at
 * once, and the stroke goes to the backend as one `paintVertices` when it
 * ends. The page and the backend paint with the same pure functions
 * (project-model `paintVertexDabs`, `paintPathDabs`), so what the preview
 * shows is what is stored.
 *
 * - **A placed model:** its meshes draw a geometry sharing the model's with
 *   the preview's paint as its `tlPaint` (drawn alone meanwhile: a batch or
 *   merged cell would copy the paint at every dab).
 * - **A copy of an instance set:** the set is drawn again once with a slot
 *   of its own for the copy (the other copies keep theirs); each dab rewrites
 *   that slot in the set's streams.
 * - **Generated architecture and splines:** one path side's grid is
 *   replaced by the brush's, and the drawn meshes' paint sampled again.
 *
 * A preview lasts past the stroke until the object's stored paint changes
 * (the stroke's result read and drawn), so the object never shows its old
 * paint or nothing in between; a refused stroke drops it at once. Stored
 * paint that arrives while a stroke is still being painted goes under it
 * (an earlier stroke's result): the preview stays on top.
 */
import * as THREE from 'three';
import { INSTANCE_FLOATS, type PathFrame, type PathGrid, type PathPaintSide } from '@thirdlight/project-model';

import type { InstanceSetPaint } from './instancing';
import { disposePaintedGeometry, meshPaintOf, paintBaseOf, paintedGeometry, paintSourceOf, paintStream, PAINT_ATTRIBUTE, PAINT_MESH_KEY, PAINT_PREVIEW_KEY, type PaintStream } from './vertex-paint-draw';

/** One mesh a stroke paints: its name, its vertices in the world (xyz), and the paint the brush changes in place (4 bytes a vertex). */
export interface PaintPreviewMesh {
  readonly mesh: string;
  readonly points: Float32Array;
  readonly values: Uint8Array;
}

/** A stroke on a placed model or one copy of an instance set. */
export interface MeshPaintPreview {
  readonly kind: 'meshes';
  readonly meshes: readonly PaintPreviewMesh[];
  /** Draw the values as they are now (after the brush changed them). */
  show(): void;
  /**
   * The stroke ended. `keep`: drawn until the object's stored paint changes
   * next (the stroke stored), else dropped now (refused; also after a
   * `keep`). Resolves once the preview is no longer drawn.
   */
  end(keep: boolean): Promise<void>;
}

/** A stroke on one side of a path of generated architecture or a spline. */
export interface PathPaintPreview {
  readonly kind: 'path';
  /** Where the object stands: a world point less this is in the object's frame (these objects are placed by position alone). */
  readonly origin: readonly [number, number, number];
  readonly frame: PathFrame;
  /** The side's grid as drawn now (null: not painted); the brush paints a copy of it. */
  readonly grid: PathGrid | null;
  /** Draw this grid on the side (the brush's, grown where it reached past the stored one). */
  show(grid: PathGrid | null): void;
  end(keep: boolean): Promise<void>;
}

export type VertexPaintPreview = MeshPaintPreview | PathPaintPreview;

/** What a stroke paints on an object: a model's meshes (nothing), one copy of a set, or one side of a path. */
export type PaintPreviewTarget = { readonly copy?: number } | { readonly path: string; readonly side: PathPaintSide };

/**
 * A preview's life: live while the brush paints, held after a stored stroke
 * until the object's paint changes next, then gone.
 */
export class PreviewLife {
  state: 'live' | 'held' | 'gone' = 'live';
  private done!: () => void;
  readonly gone = new Promise<void>((resolve) => (this.done = resolve));

  /** The object's stored paint was drawn: a held preview has served its turn (true: drop it). */
  repainted(): boolean {
    if (this.state !== 'held') return false;
    this.finish();
    return true;
  }

  finish(): void {
    this.state = 'gone';
    this.done();
  }
}

/**
 * A mesh drawn on now draws a geometry whose paint comes from elsewhere than
 * the one it drew (none ↔ an attribute): its program is made again. three
 * reads a geometry exchanged in place with the program it had and checks the
 * layout only when the material's version moves, so the material is marked
 * (the other objects wearing it keep their programs: their layouts did not
 * change).
 */
export function relayout(mesh: THREE.Mesh, before: THREE.BufferGeometry | undefined): void {
  if (before === undefined || paintSourceOf(before) === paintSourceOf(mesh.geometry)) return;
  for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m !== undefined && m !== null) m.needsUpdate = true;
}

/** One model mesh drawing a preview: the geometry it drew before, and the preview's. */
interface PreviewSwap {
  readonly mesh: THREE.Mesh;
  before: THREE.BufferGeometry;
  preview: THREE.BufferGeometry;
  readonly values: Uint8Array;
}

/**
 * The meshes of a placed model a stroke paints (every mesh vertex paint can
 * name, every level of detail), with their world points and current paint
 * (the drawn paint; 0 where none fits).
 */
export function modelPreviewMeshes(root: THREE.Object3D): { mesh: THREE.Mesh; item: PaintPreviewMesh }[] {
  const out: { mesh: THREE.Mesh; item: PaintPreviewMesh }[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const key = mesh.userData[PAINT_MESH_KEY] as string | undefined;
    if (mesh.isMesh !== true || key === undefined) return;
    const pos = paintBaseOf(mesh.geometry).getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos === undefined) return;
    const drawn = meshPaintOf(mesh);
    const values = drawn !== null && drawn.length === pos.count * 4 ? drawn.slice() : new Uint8Array(pos.count * 4);
    const points = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      points[i * 3] = v.x;
      points[i * 3 + 1] = v.y;
      points[i * 3 + 2] = v.z;
    }
    out.push({ mesh, item: { mesh: key, points, values } });
  });
  return out;
}

/** Draw a model's meshes with preview paint (their own values arrays, drawn as they change); the undo puts back what they drew. */
export function swapInPreview(meshes: readonly { mesh: THREE.Mesh; item: PaintPreviewMesh }[]): { show(): void; undo(): void } {
  const swaps: PreviewSwap[] = meshes.map(({ mesh, item }) => {
    const before = mesh.geometry;
    const preview = paintedGeometry(paintBaseOf(before), item.values);
    mesh.geometry = preview;
    mesh.userData[PAINT_PREVIEW_KEY] = true;
    relayout(mesh, before);
    return { mesh, before, preview, values: item.values };
  });
  return {
    show() {
      for (const s of swaps) {
        const a = s.preview.getAttribute(PAINT_ATTRIBUTE) as THREE.BufferAttribute | undefined;
        if (a !== undefined) a.needsUpdate = true;
      }
    },
    undo() {
      for (const s of swaps) {
        if (s.mesh.geometry === s.preview) {
          s.mesh.geometry = s.before;
          relayout(s.mesh, s.preview);
        }
        delete s.mesh.userData[PAINT_PREVIEW_KEY];
        disposePaintedGeometry(s.preview);
      }
    },
  };
}

/** One template mesh of an instance set: its name, vertex count and place in the model. */
interface TemplateMesh {
  readonly key: string;
  readonly vertices: number;
  readonly position: THREE.BufferAttribute;
  readonly offset: THREE.Matrix4;
}

function templateMeshes(template: THREE.Object3D): TemplateMesh[] {
  template.updateMatrixWorld(true);
  const rootInverse = template.matrixWorld.clone().invert();
  const out = new Map<string, TemplateMesh>();
  template.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const key = mesh.userData[PAINT_MESH_KEY] as string | undefined;
    if (mesh.isMesh !== true || key === undefined || out.has(key)) return;
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (position === undefined) return;
    out.set(key, { key, vertices: position.count, position, offset: rootInverse.clone().multiply(mesh.matrixWorld) });
  });
  return [...out.values()];
}

/**
 * A copy's preview on an instance set: the set's paint with a slot of the
 * copy's own appended to every mesh's stream (its current paint copied in),
 * and the copy's meshes in the world. `values` are the brush's (`brush`:
 * the arrays it paints already); `show` copies them into the streams.
 */
export function copyPreview(template: THREE.Object3D, current: InstanceSetPaint | null, copy: number, copyWorld: THREE.Matrix4, brush?: ReadonlyMap<string, Uint8Array>): { readonly items: PaintPreviewMesh[]; readonly paint: InstanceSetPaint; show(): void; dispose(): void } | null {
  const meshes = templateMeshes(template);
  if (meshes.length === 0) return null;
  const was = current === null ? -1 : current.slotOf(copy);
  // One slot index for every mesh (a copy's slot is shared by its meshes): past every stream's slots.
  let slot = 0;
  for (const m of meshes) slot = Math.max(slot, current?.stream(m.key)?.slots ?? 0);
  const streams = new Map<string, PaintStream>();
  const items: PaintPreviewMesh[] = [];
  const v = new THREE.Vector3();
  const toWorld = new THREE.Matrix4();
  for (const m of meshes) {
    const run = m.vertices * 4;
    const old = current?.stream(m.key);
    const bytes = new Uint8Array((slot + 1) * run);
    if (old !== undefined) bytes.set((old.texture.image.data as Uint8Array).subarray(0, Math.min(old.slots, slot) * run));
    // The brush's values when it is painting already (the set drawn again under it), else the copy's as drawn.
    const own = brush?.get(m.key);
    const values = own !== undefined && own.length === run ? own : new Uint8Array(run);
    if (own === undefined && old !== undefined && was >= 0 && was < old.slots) values.set((old.texture.image.data as Uint8Array).subarray(was * run, (was + 1) * run));
    bytes.set(values, slot * run);
    const stream = paintStream(bytes, m.vertices, slot + 1);
    if (stream === null) continue;
    streams.set(m.key, stream);
    toWorld.multiplyMatrices(copyWorld, m.offset);
    const points = new Float32Array(m.vertices * 3);
    for (let i = 0; i < m.vertices; i += 1) {
      v.fromBufferAttribute(m.position, i).applyMatrix4(toWorld);
      points[i * 3] = v.x;
      points[i * 3 + 1] = v.y;
      points[i * 3 + 2] = v.z;
    }
    items.push({ mesh: m.key, points, values });
  }
  if (items.length === 0) return null;
  const paint: InstanceSetPaint = {
    slotOf: (c) => (c === copy ? slot : (current?.slotOf(c) ?? -1)),
    stream: (key) => streams.get(key),
  };
  const show = (): void => {
    for (const it of items) {
      const s = streams.get(it.mesh)!;
      (s.texture.image.data as Uint8Array).set(it.values, slot * it.values.length);
      s.texture.needsUpdate = true;
    }
  };
  return {
    items,
    paint,
    show,
    dispose: () => {
      for (const s of streams.values()) s.dispose();
      streams.clear();
    },
  };
}

/** A copy's matrix in its set from its floats (position, rotation, scale). */
export function copyMatrixOf(floats: Float32Array, copy: number, out = new THREE.Matrix4()): THREE.Matrix4 | null {
  const o = copy * INSTANCE_FLOATS;
  if (o + INSTANCE_FLOATS > floats.length) return null;
  return out.compose(new THREE.Vector3(floats[o]!, floats[o + 1]!, floats[o + 2]!), new THREE.Quaternion(floats[o + 3]!, floats[o + 4]!, floats[o + 5]!, floats[o + 6]!), new THREE.Vector3(floats[o + 7]!, floats[o + 8]!, floats[o + 9]!));
}
