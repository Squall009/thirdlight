/**
 * Vertex paint drawn: the four bytes a vertex that materials read as `paint`
 * (project-model `vertex-paint.ts` holds the data; an unpainted vertex reads
 * (0, 0, 0, 0)).
 *
 * Where a draw's paint comes from is decided per build from what its
 * geometry carries. three keys a program by its vertex layout, so a painted
 * draw builds a program of its own and every other draw keeps the one it
 * had (a scene without paint builds exactly the programs it built before):
 *
 * - **A mesh drawn alone** (a placed model, a merged static cell, a
 *   generated wall or road): a `tlPaint` attribute, 4 normalized bytes a
 *   vertex (a merged cell's unpainted members 0). A painted model mesh draws
 *   a geometry that shares every attribute of the model's own and adds the
 *   paint ({@link paintedGeometry}); batches and merged cells group it by the
 *   model's geometry, so painting a copy never takes it out of its batch.
 * - **A draw through instance-matrix columns** (an automatic batch, an
 *   instance set's chunk) with a painted instance: each instance's paint
 *   slot (1 + its slot; 0: unpainted) rides in its matrix's fourth row
 *   (`w` of the first column — the matrices are affine and only the xyz of
 *   their products are read), so it moves with the instance when view
 *   culling reorders them. The draw's paint stream, a data texture holding
 *   the slots' runs of 4 bytes a vertex, is read in the vertex stage at
 *   (slot − 1) × the mesh's vertices + the vertex's index. The geometry
 *   carries a marker attribute (`tlPaintSlot`: a view of that same float,
 *   never read) so its layout, and with it its program, is its own: painted
 *   copies stay in their one instanced draw, and the instance buffer keeps
 *   its 64 bytes a copy.
 * - **Otherwise** nothing: a material that reads paint reads (0, 0, 0, 0),
 *   and what only adds paint to something is left out of the build.
 *
 * The stream is a data texture on both renderers: one program text, and a
 * per-object texture three already binds per draw (a WebGPU storage buffer
 * would be a second path for one renderer).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { instanceColumn, PAINT_SLOT_ATTRIBUTE } from './attribute-instancing';
import { disposeSharingGeometry } from './dispose';
import type { N } from './effects-tsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, attribute, int, ivec2, max, uniform, varying, vec4, vertexIndex } = TSL;

/** The vertex attribute of a painted mesh drawn alone: 4 normalized bytes a vertex. */
export const PAINT_ATTRIBUTE = 'tlPaint';
export { PAINT_SLOT_ATTRIBUTE };
/**
 * `mesh.userData[PAINT_COPIES_KEY]`: how many of the copies an instanced draw
 * may list are painted, for a draw with no per-instance marker to count (a
 * GPU copy set's draw names its copies by texels, not by instance).
 */
export const PAINT_COPIES_KEY = '__tlPaintCopies';
/** `mesh.userData[PAINT_STREAM_KEY]`: the {@link PaintStream} an instanced draw reads. */
export const PAINT_STREAM_KEY = '__tlPaintStream';
/** `mesh.userData[PAINT_MESH_KEY]`: a model mesh's name as vertex paint stores it (its node's path and primitive). */
export const PAINT_MESH_KEY = '__tlPaintMesh';
/**
 * `mesh.userData[PAINT_PREVIEW_KEY]`: the mesh draws a brush stroke's paint
 * before it is stored, so it is drawn alone (never batched or merged): its
 * paint changes with every dab and only its own attribute is rewritten.
 */
export const PAINT_PREVIEW_KEY = '__tlPaintPreview';
/** Each painted geometry's model geometry (what batches and merged cells group it by); not in `userData`, which a clone would serialize. */
const paintBases = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/** Texels a row of a paint stream (under WebGPU's default largest side, 8192, and what WebGL 2 GPUs take in practice). */
export const PAINT_STREAM_WIDTH = 4096;
/**
 * Rows a paint stream may have until the renderer says what its device
 * takes (WebGPU's default largest texture side, which three asks for): past
 * the device's largest side the draw goes unpainted and is reported.
 */
export const PAINT_STREAM_ROWS_MAX = 8192;

/** The rows the page's device takes (its largest texture side; 0: not even one row of {@link PAINT_STREAM_WIDTH}). */
let deviceRows = PAINT_STREAM_ROWS_MAX;
const overflowListeners = new Set<(message: string) => void>();

/**
 * Read the largest texture side of the renderer's device (once it is
 * initialised): WebGPU's device limit, WebGL 2's MAX_TEXTURE_SIZE (which may
 * be as low as 2048 or as high as 16384). Every page draws on one GPU.
 */
export function setPaintStreamDevice(backend: { readonly isWebGLBackend?: boolean; readonly gl?: { readonly MAX_TEXTURE_SIZE: number; getParameter(p: number): unknown }; readonly device?: { readonly limits?: { readonly maxTextureDimension2D?: number } } | null } | null | undefined): void {
  const side = backend?.isWebGLBackend === true && typeof backend.gl?.getParameter === 'function' ? backend.gl.getParameter(backend.gl.MAX_TEXTURE_SIZE) : backend?.device?.limits?.maxTextureDimension2D;
  if (typeof side !== 'number' || !(side > 0)) return;
  deviceRows = side < PAINT_STREAM_WIDTH ? 0 : side;
}

/** The rows a stream may have on this page's device. */
export function paintStreamRowsMax(): number {
  return deviceRows;
}

/** The Problems code of a paint stream that does not fit the device. */
export const PAINT_STREAM_OVERFLOW = 'vertex_paint_overflow';

/**
 * Report the paint streams that do not fit the device (a set or batch whose
 * painted copies × vertices pass its largest texture; that draw goes
 * unpainted) to `onProblem`, each case once. Returns the unsubscribe.
 */
export function reportPaintStreamOverflow(onProblem: (code: string, message: string) => void): () => void {
  const said = new Set<string>();
  const listener = (message: string): void => {
    if (said.has(message)) return;
    said.add(message);
    onProblem(PAINT_STREAM_OVERFLOW, message);
  };
  overflowListeners.add(listener);
  return () => overflowListeners.delete(listener);
}

/** An instanced draw's paint: its slots' runs, 4 bytes a vertex, as a data texture. */
export interface PaintStream {
  readonly texture: THREE.DataTexture;
  /** Vertices of the mesh (a slot's run). */
  readonly vertices: number;
  /** Slots in it. */
  readonly slots: number;
  /** GPU bytes. */
  readonly bytes: number;
  dispose(): void;
}

/** A stream of `slots` runs of `vertices` (the bytes one after another), or null when it would not fit a texture. */
export function paintStream(bytes: Uint8Array, vertices: number, slots: number): PaintStream | null {
  const texels = vertices * slots;
  if (vertices <= 0 || slots <= 0) return null;
  const rows = Math.ceil(texels / PAINT_STREAM_WIDTH);
  if (rows > deviceRows) {
    const message = `vertex paint of ${slots} painted copies of a ${vertices}-vertex mesh needs ${rows} rows of ${PAINT_STREAM_WIDTH} texels, past the ${deviceRows} this GPU takes: that draw goes unpainted; paint fewer copies of it, or a mesh with fewer vertices`;
    for (const l of overflowListeners) l(message);
    return null;
  }
  if (bytes.length < texels * 4) return null;
  const data = new Uint8Array(rows * PAINT_STREAM_WIDTH * 4);
  data.set(bytes.subarray(0, texels * 4));
  const texture = new THREE.DataTexture(data, PAINT_STREAM_WIDTH, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  // Its own version: three's WebGL 2 backend rebinds a texture node's texture only when its version differs.
  texture.version = Math.max(texture.version, ++streamVersion);
  return { texture, vertices, slots, bytes: data.byteLength, dispose: () => texture.dispose() };
}
let streamVersion = 2_000_000;

// ---- geometry -----------------------------------------------------------------------------------

/** Where a geometry's paint comes from in a build: its attribute, its instances' stream, or nowhere. */
export type PaintSource = 'attribute' | 'stream' | null;

export function paintSourceOf(geometry: THREE.BufferGeometry | null | undefined): PaintSource {
  if (geometry === null || geometry === undefined || typeof geometry.getAttribute !== 'function') return null;
  if (geometry.getAttribute(PAINT_ATTRIBUTE) !== undefined) return 'attribute';
  if (geometry.getAttribute(PAINT_SLOT_ATTRIBUTE) !== undefined) return 'stream';
  return null;
}

/**
 * A geometry drawing `base` with `paint` (4 bytes a vertex): every attribute,
 * the index and the groups shared, the paint its own.
 */
export function paintedGeometry(base: THREE.BufferGeometry, paint: Uint8Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.name = base.name;
  for (const [name, a] of Object.entries(base.attributes)) g.setAttribute(name, a);
  for (const [name, list] of Object.entries(base.morphAttributes)) (g.morphAttributes as Record<string, unknown>)[name] = list;
  g.morphTargetsRelative = base.morphTargetsRelative;
  if (base.index !== null) g.setIndex(base.index);
  for (const grp of base.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  g.setDrawRange(base.drawRange.start, base.drawRange.count);
  if (base.boundingBox !== null) g.boundingBox = base.boundingBox.clone();
  if (base.boundingSphere !== null) g.boundingSphere = base.boundingSphere.clone();
  g.setAttribute(PAINT_ATTRIBUTE, new THREE.BufferAttribute(paint, 4, true));
  paintBases.set(g, base);
  return g;
}

/** The model geometry a painted geometry draws (the geometry itself when it is not one). */
export function paintBaseOf(g: THREE.BufferGeometry): THREE.BufferGeometry {
  return paintBases.get(g) ?? g;
}

/** A mesh's paint drawn alone (its attribute's bytes), or null. */
export function meshPaintOf(mesh: THREE.Mesh): Uint8Array | null {
  const g = mesh.geometry as THREE.BufferGeometry | undefined;
  if (g === undefined || !paintBases.has(g)) return null;
  const a = g.getAttribute(PAINT_ATTRIBUTE) as THREE.BufferAttribute | undefined;
  return a === undefined ? null : (a.array as Uint8Array);
}

/** Free a painted geometry: its paint only (the model's attributes and index stay their owner's). */
export function disposePaintedGeometry(g: THREE.BufferGeometry): void {
  const a = g.getAttribute(PAINT_ATTRIBUTE);
  disposeSharingGeometry(g, a === undefined ? [] : [a]);
}

// ---- the paint a build reads ------------------------------------------------------------------------

/** A data texture read texel by texel as uploaded: no transform, no flip-Y switch (each would cost a per-draw uniform). */
class PaintStreamNode extends (THREE.TextureNode as unknown as new (value: THREE.Texture) => object) {
  setUpdateMatrix(): this {
    (this as unknown as { updateMatrix: boolean }).updateMatrix = false;
    return this;
  }
  setupUV(_builder: unknown, uvNode: N): N {
    return uvNode;
  }
}

/** What a draw without a stream binds in its place (never read: its slots are all 0). */
const NO_STREAM = ((): THREE.DataTexture => {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
})();

const streamTexture: N = TSL.nodeObject(new PaintStreamNode(NO_STREAM));
/** The drawn object's stream: its vertices per slot, and (set on the way) the texture the read binds. */
const streamVertices: N = uniform(0, 'int').onObjectUpdate(({ object }: { object: THREE.Object3D }) => {
  const s = object.userData[PAINT_STREAM_KEY] as PaintStream | undefined;
  streamTexture.value = s?.texture ?? NO_STREAM;
  return s?.vertices ?? 0;
});

/** The paint of this vertex of this instance from the draw's stream (vertex stage). */
const streamRead: N = Fn(() => {
  // Through the column reader: a draw whose copies the GPU culls reads the slot of the copy its list names.
  const slot = (instanceColumn(0) as N).w;
  const at = max(int(slot.add(0.5)).sub(1), int(0)).mul(streamVertices).add(int(vertexIndex));
  const texel = streamTexture.load(ivec2(at.mod(PAINT_STREAM_WIDTH), at.div(PAINT_STREAM_WIDTH)));
  return slot.greaterThan(0.5).select(texel, vec4(0));
})();
const streamPaint: N = varying(streamRead, 'vTlPaintStream');
const attributePaint: N = attribute(PAINT_ATTRIBUTE, 'vec4');

const geometryOf = (builder: unknown): THREE.BufferGeometry | undefined => (builder as { geometry?: THREE.BufferGeometry }).geometry;

/** Where the drawn geometry's paint comes from in this build. */
export function buildPaintSource(builder: unknown): PaintSource {
  return paintSourceOf(geometryOf(builder));
}

/** The paint of this vertex (normalized RGBA; (0, 0, 0, 0) where the draw carries none). */
export const paintNode = (): N => Fn((builder: unknown) => {
  const source = buildPaintSource(builder);
  return source === 'attribute' ? attributePaint : source === 'stream' ? streamPaint : vec4(0, 0, 0, 0);
})();

/**
 * `base` with paint worked in by `mix(base, paint)` where the draw carries
 * paint, and `base` itself elsewhere: a material that adds paint to
 * something builds the program it did on every unpainted draw.
 */
export const withPaint = (base: N, mix: (base: N, paint: N) => N): N => Fn((builder: unknown) => {
  const source = buildPaintSource(builder);
  if (source === null) return base;
  return mix(base, source === 'attribute' ? attributePaint : streamPaint);
})();

/** The page flag that draws without vertex paint (`?paint=off`: its cost, by comparison). */
export const PAINT_URL_PARAM = 'paint';


/** What a scene draws of vertex paint (diagnostics; counted when asked, not per frame). */
export interface VertexPaintDiagnostics {
  /** Painted meshes drawn alone (placed models, generated walls and roads) and merged static cells with paint. */
  alone: number;
  merged: number;
  /** Instanced draws reading a paint stream (batches, instance set chunks), the instances in them, and those painted. */
  instancedDraws: number;
  instances: number;
  paintedInstances: number;
  /** GPU bytes: paint attributes (drawn alone and merged) and streams. */
  attributeBytes: number;
  streamBytes: number;
}

/** Vertex paint in `root`'s drawables (null: none). */
export function vertexPaintDiagnostics(root: THREE.Object3D): VertexPaintDiagnostics | null {
  const d: VertexPaintDiagnostics = { alone: 0, merged: 0, instancedDraws: 0, instances: 0, paintedInstances: 0, attributeBytes: 0, streamBytes: 0 };
  const streams = new Set<PaintStream>();
  const attributes = new Set<unknown>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // Drawn by the view: on layer 0 (batched and merged members are moved off it) and shown.
    if (mesh.isMesh !== true || mesh.geometry === undefined || !mesh.visible || !mesh.layers.isEnabled(0)) return;
    const g = mesh.geometry;
    const a = g.getAttribute(PAINT_ATTRIBUTE) as THREE.BufferAttribute | undefined;
    if (a !== undefined) {
      if (mesh.name.startsWith('tl-merged:')) d.merged += 1;
      else d.alone += 1;
      if (!attributes.has(a)) d.attributeBytes += (a.array as Uint8Array).byteLength;
      attributes.add(a);
      return;
    }
    const marker = g.getAttribute(PAINT_SLOT_ATTRIBUTE) as THREE.InterleavedBufferAttribute | undefined;
    if (marker === undefined) return;
    const n = (g as THREE.InstancedBufferGeometry).instanceCount;
    d.instancedDraws += 1;
    d.instances += n;
    const painted = mesh.userData[PAINT_COPIES_KEY] as (() => number) | undefined;
    if (painted !== undefined) d.paintedInstances += painted();
    else for (let i = 0; i < n; i += 1) if (marker.getX(i) > 0.5) d.paintedInstances += 1;
    const s = mesh.userData[PAINT_STREAM_KEY] as PaintStream | undefined;
    if (s !== undefined) streams.add(s);
  });
  for (const s of streams) d.streamBytes += s.bytes;
  return d.alone + d.merged + d.instancedDraws > 0 ? d : null;
}
