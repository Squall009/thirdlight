/**
 * The voxel world's draws: one object a 32³ storage chunk, built from the
 * chunk's joined derive sections (the streamer's `joinedChunk`), so the
 * object count, and with it the render CPU and the work a swap does on the
 * main thread, follows the chunk count however small the derive sections
 * are. Play, an exported game and the editor draw through this one view.
 *
 * A chunk is one mesh holding its ground and its modular base surfaces (the
 * same material, so one draw), plus its kit pieces, which draw across the
 * chunks: one instanced draw a (kit piece, slot mesh, mirror, cut) for the
 * whole view ({@link VoxelPieceBatches}), culled by chunk. Only a chunk
 * (level 0, the near ring) lists pieces; coarser nodes draw their edges as
 * plain voxel faces. A kit piece's kit is its dressing cell's material's
 * (its own cell or one beside it), read from the chunk's shader data as the surface shader reads it; a piece beside an
 * opening draws a copy of its mesh cut flush at the faces its instance names. Its mesh comes from the
 * view's {@link VoxelKitSet} (the world's piece table and kits). A chunk
 * whose kit meshes are still loading draws its other pieces and builds the
 * waiting ones when they arrive. The surface buffers' packed vertices are unpacked to float
 * attributes here (positions in metres from the chunk's corner, normals).
 * They carry no material: the voxel surface shader blends the materials it
 * finds in the chunk's shader grid, uploaded as the join wrote its entries
 * (no palette packed only to be expanded again), on its own when only the
 * shader data changed, so such an edit rebuilds no mesh.
 *
 * Coarser levels of the chunk tree draw the same way: a mip node is one
 * object (its derive, in its level's cells, scaled to metres here) with its
 * own grid of its own cells, and each seam between two levels is one more
 * object, shaded from the coarse node's grid (the seam lies at that node's
 * face). Level 0 is always storage chunks; a node of level L covers 2^L
 * chunks a side.
 *
 * Objects are placed relative to the floating origin from their integer
 * cell; after a re-base every object is placed again. Objects keep their
 * matrices until placed (no per-frame matrix work for a still world). The
 * surface and the pieces draw with a camera-relative model-view made in 64
 * bits (camera-relative.ts), so a view whose origin is never moved (a game
 * view kilometres out) draws as exactly as one kept near its origin.
 *
 * Decals: every draw takes projected decals in the world's decal layers
 * ({@link VoxelChunkView.setDecalLayers}); a chunk's surface mesh (level 0
 * only, the surface its edits change) is also a surface clipped decals are
 * cut from, told to the scene's clipped decals as it comes and goes
 * ({@link VoxelChunkView.setDecalSurfaces}). Kit pieces are instanced and
 * coarser levels change the surface with distance, so they take projected
 * decals only. Each piece wears its dressing cell's wetness, read from the
 * shader data as its kit is, and read again when only the shader data
 * changes.
 *
 * A swap's draws are replaced in the task that announces them (a batch,
 * {@link applyChunkDrawBatch}: everything one streamer task changed, a
 * change of the levels drawn with its seams included), so all of them
 * change between the same two frames; the piece draws are written once, at
 * the batch's end.
 *
 * Colours and patterns are stand-ins picked by material id: materials,
 * kits and detail art come later.
 */
import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshLambertNodeMaterial } from 'three/webgpu';
import {
  caseFlushFaces,
  chunkKey,
  chunkOrigin,
  INSTANCE_BYTES,
  INSTANCE_DRESSING_OFFSET,
  instanceDressingCell,
  instanceFlushFaces,
  instanceScatter,
  instancePlaceOf,
  mipCellMetres,
  PIECE_VARIANT_MIRROR,
  mirrorAxisOf,
  POSITION_STEPS_PER_CELL,
  SampleRing,
  surfaceCrackOf,
  surfaceOwnerOf,
  SURFACE_VERTEX_BYTES,
  VOXEL_SIZE_M,
  type ChunkGrid,
  type FarSeenWire,
  type FloatingOrigin,
  type JoinedDraw,
  type SeamPieceWire,
  type DrawSurface,
  type InstanceList,
  MATERIAL_ID_MAX,
  SHADER_BORDER_CELLS,
  shaderEntryWetness,
  WETNESS_MAX,
} from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import { applyObjectDecalLayers, DECAL_LAYERS_KEY, DECAL_SURFACE_KEY } from './projected-decals';
import { OFF_VIEW_LAYER } from './view-hidden';
import type { SurfaceListener } from './render-graph';
import type { VoxelKitSet } from './voxel-kit-pieces';
import { INSTANCE_MATRIX_FLOATS } from './attribute-instancing';
import { PIECE_DATA_FLOATS, PIECE_WET_FLOAT, pieceU, runAxisOf } from './voxel-trim-u';
import { VoxelPieceBatches, type PieceRun } from './voxel-piece-batches';
import type { FarFineTexture } from './voxel-far-fine-shade';
import { VoxelFarView } from './voxel-far-mesh';
import { cubeRotationMatrix, pieceMatrix, pieceTurn, type PiecePlacement } from './voxel-piece-placement';
import { gridPhases } from './voxel-surface-projection';
import { AXIS_PROJECTION_LEVEL, voxelDrawPath } from './voxel-surface-path';
import { STATIC_CASTER_KEY } from './shadow-casters';
import { disposeObjectTree } from './dispose';
import { markOccludee, markOccludeeGroup } from './occludees';
import { FULL_PATH, PHASE_CELLS, VOXEL_CREASE_ATTRIBUTE, VOXEL_CRACK_ATTRIBUTE, VOXEL_OWNER_ATTRIBUTE, VOXEL_PATTERNS, VOXEL_SURFACE_KEY, type VoxelGridRenderer, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceObject } from './voxel-surface';

/** Stand-in colours, by material id (wrapping): earth, rock and building tones, so neighbouring ids read apart. */
const SWATCHES = [0x8a8f96, 0x7d7f84, 0x7a5a3c, 0x5f8f3e, 0xc8b47c, 0x4a78b8, 0x9a958c, 0xb0a48c, 0xa9a39a, 0x8b5a33, 0xd8d0c0, 0x9c4a3a, 0xb08850, 0xa0523c, 0x6d6a5f, 0x8c7a6b];

/** A material id's stand-in look: a swatch and a test pattern, both by id. */
export function voxelStandInLook(material: number): VoxelMaterialLook {
  return { colour: SWATCHES[material % SWATCHES.length]!, pattern: material % VOXEL_PATTERNS };
}

/** A surface buffer to place: metres a position step, and the metres added to every position. */
interface PlacedSurface {
  readonly buf: DrawSurface;
  readonly stepMetres: number;
  readonly offset: readonly [number, number, number];
}

/**
 * Surface buffers as one float geometry (null when they hold no triangle):
 * the buffers' vertices one after another, indices offset to match. A
 * vertex's owner offset ({@link VOXEL_OWNER_ATTRIBUTE}) stays in its
 * buffer's cells: an owned face is drawn by an object of its own level
 * (a seam's finer pieces carry none).
 * `cellMetres`: the buffers' cells (a coarser level's for a mip node);
 * positions count from one cell below the object's corner.
 */
export function voxelSurfaceGeometry(bufs: readonly DrawSurface[], cellMetres = VOXEL_SIZE_M, reliefDepthM = 0): THREE.BufferGeometry | null {
  const offset: [number, number, number] = [-cellMetres, -cellMetres, -cellMetres];
  return placedGeometry(bufs.map((buf) => ({ buf, stepMetres: cellMetres / POSITION_STEPS_PER_CELL, offset })), reliefDepthM);
}

/**
 * The buffers' vertices placed; a relief mesh's crease weights become the
 * {@link VOXEL_CREASE_ATTRIBUTE} (0 for a part without them), and its
 * culling bounds grow by the deepest relief, `reliefDepthM`: the vertex
 * stage moves its vertices up to that far, so a bound of the plain
 * positions would cull (or leave out of a shadow) a displaced edge.
 */
function placedGeometry(parts: readonly PlacedSurface[], reliefDepthM = 0): THREE.BufferGeometry | null {
  let n = 0;
  let indexCount = 0;
  for (const { buf } of parts) {
    if (buf.indices.length === 0) continue;
    n += buf.vertexCount;
    indexCount += buf.indices.length;
  }
  if (n === 0 || indexCount === 0) return null;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const crack = new Float32Array(n);
  const owner = new Int8Array(n * 4);
  const relief = parts.some((p) => p.buf.crease !== undefined);
  const crease = relief ? new Float32Array(n) : null;
  const index = n < 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  let v0 = 0;
  let i0 = 0;
  for (const { buf: b, stepMetres, offset } of parts) {
    if (b.indices.length === 0) continue;
    const view = new DataView(b.vertices.buffer, b.vertices.byteOffset, b.vertices.byteLength);
    for (let i = 0; i < b.vertexCount; i++) {
      const o = i * SURFACE_VERTEX_BYTES;
      const at = (v0 + i) * 3;
      for (let a = 0; a < 3; a++) {
        pos[at + a] = view.getUint16(o + a * 2, true) * stepMetres + offset[a]!;
        nor[at + a] = Math.max(-1, view.getInt8(o + 8 + a) / 127);
      }
      crack[v0 + i] = surfaceCrackOf(view, o) / 255;
      const own = surfaceOwnerOf(view, o);
      if (own !== null) owner.set([own[0], own[1], own[2], 1], (v0 + i) * 4);
    }
    if (crease !== null && b.crease !== undefined) for (let i = 0; i < b.vertexCount; i++) crease[v0 + i] = b.crease[i]! / 255;
    const src = b.indices;
    if (v0 === 0) index.set(src, i0);
    else for (let k = 0; k < src.length; k++) index[i0 + k] = src[k]! + v0;
    v0 += b.vertexCount;
    i0 += src.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute(VOXEL_CRACK_ATTRIBUTE, new THREE.BufferAttribute(crack, 1));
  // snorm8x4 (four bytes a vertex): quarter cells and the owned flag, read back whole by the shader.
  geo.setAttribute(VOXEL_OWNER_ATTRIBUTE, new THREE.BufferAttribute(owner, 4, true));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  if (crease !== null) geo.setAttribute(VOXEL_CREASE_ATTRIBUTE, new THREE.BufferAttribute(crease, 1));
  geo.computeBoundingSphere();
  if (crease !== null) geo.boundingSphere!.radius += reliefDepthM;
  return geo;
}

/** Bytes a geometry holds on the GPU (its attributes and index). */
function geometryBytes(geo: THREE.BufferGeometry): number {
  let n = geo.index?.array.byteLength ?? 0;
  for (const a of Object.values(geo.attributes)) n += (a as THREE.BufferAttribute).array.byteLength;
  return n;
}

/** What a chunk's (or node's) draw is made of: its joined sections' surfaces, pieces and shader grid (a join, or a batch's copy of one). */
export type VoxelChunkDraw = Pick<JoinedDraw, 'instances' | 'solid'> & { readonly ground: DrawSurface; readonly base: DrawSurface; readonly caster?: { readonly ground: DrawSurface; readonly base: DrawSurface } };

/** `mesh.userData[VOXEL_CASTER_KEY]`: a chunk's plain shadow caster (drawn only by the shadow cameras, for its relief mesh). */
export const VOXEL_CASTER_KEY = '__tlVoxelCaster';

/**
 * The plain casters' material: nothing but depth is read from it (three's
 * shadow pass draws its back faces, as for every front-sided surface), so no
 * colour, grid or texture is shaded for a caster's shadow pixels.
 */
function casterMaterial(): THREE.Material {
  const m = new MeshBasicNodeMaterial();
  m.name = 'voxel shadow caster';
  return m;
}

/** A seam piece: positions in the finer level's steps from its origin (finer-level cells). */
export type VoxelSeamPiece = SeamPieceWire;

export interface ChunkDraw {
  readonly group: THREE.Group;
  /** The object's corner, level-0 cells. */
  readonly cell: readonly [number, number, number];
  readonly level: number;
  bytes: number;
  /** What the object's surface passes the shader. */
  readonly surface: VoxelSurfaceObject;
  /** The object's grid region (null: none, its one solid entry is passed instead). */
  region: THREE.Vector3 | null;
  /** Its detail instances (a copy), each one's material (0 for a default piece) and wetness (0 … 1), kept to build its kit pieces again. */
  readonly instances: InstanceList;
  readonly materials: Uint16Array;
  wet: Float32Array;
  /** GPU bytes of its pieces in the view's piece draws. */
  pieceBytes: number;
  readonly cellMetres: number;
  /** Kit pieces whose meshes were still loading when its pieces were built. */
  waiting: boolean;
  /** Its surface mesh when clipped decals may be cut from it (a level-0 chunk's), else null. */
  readonly decalSurface: THREE.Mesh | null;
  /** Its surface mesh (null: none), whose program follows its grid ({@link voxelDrawPath}). */
  readonly mesh: THREE.Mesh | null;
}

/** A draw's kit pieces as runs in the view's piece draws, the instances they hold, and whether some waited for kit meshes. */
interface PieceRuns {
  readonly runs: readonly PieceRun[];
  readonly instances: number;
  readonly waiting: boolean;
}

/** A chunk's (or node's) draw made and not shown yet ({@link VoxelChunkView.prepare}); `draw` null: nothing to draw, its commit removes the chunk. */
export interface VoxelPreparedDraw {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly level: number;
  readonly key: number;
  readonly draw: ChunkDraw | null;
  readonly runs: PieceRuns;
  /** The kits its pieces were made from. */
  readonly kits: VoxelKitSet | null;
}

/** What the view tells of the surfaces clipped decals may be cut from (the scene's clipped decals). */
export type VoxelDecalSurfaces = Pick<SurfaceListener, 'added' | 'removed' | 'moved'>;

interface SeamDraw {
  readonly mesh: THREE.Mesh;
  /** The coarse node's corner, level-0 cells. */
  readonly cell: readonly [number, number, number];
  readonly level: number;
  /** The coarse node and the face. */
  readonly node: readonly [number, number, number, number];
  readonly triangles: number;
  readonly bytes: number;
}

/** A seam's key: the coarse node and its face. */
const seamId = (level: number, nx: number, ny: number, nz: number, face: number): string => `${level},${nx},${ny},${nz},${face}`;

/** Shader values for a seam whose coarse node is not drawn (it left first; its seam goes with the next batch): one entry, all air. */
const NO_SURFACE: VoxelSurfaceObject = { slot: new THREE.Vector4(0, 0, 0, 0), phase: new THREE.Vector3(), slopePhase: new THREE.Vector3(), slope5Phase: new THREE.Vector3(), cellMetres: VOXEL_SIZE_M };

export interface VoxelChunkViewOptions {
  /** The storage chunks' grid (32³). */
  readonly grid: ChunkGrid;
  readonly origin: FloatingOrigin;
  /** The surface material and its grid store (a grid side of the chunk's: edge + 2 · border). */
  readonly surface: VoxelSurface;
  readonly renderer: VoxelGridRenderer;
  /** Kit pieces' meshes (the world's piece table and kits); absent: kit pieces are not drawn ({@link VoxelChunkView.setKits}). */
  readonly kits?: VoxelKitSet | null;
  /** Surfaces and pieces cast and receive shadows (default false). */
  readonly shadows?: boolean;
  /** Each draw's program follows its grid and level ({@link voxelDrawPath}; default true; false: every draw the full program). */
  readonly fastPaths?: boolean;
  /** Surfaces (not pieces) cast and receive the key light's shadow as static casters, whatever `shadows` says (a measurement). */
  readonly staticCasters?: boolean;
  /** Whether the far bricks draw as a visibility pass and one shade on WebGPU (default on; `VoxelFarViewOptions.visibility`). */
  readonly farVisibility?: boolean;
  /** Where the far field's visibility feedback goes (`VoxelFarViewOptions.onSeen`; absent: none is made). */
  readonly onFarSeen?: (seen: FarSeenWire) => void;
  /** What fine far bricks read of the texture sets (default `full`; voxel-far-fine-shade.ts). */
  readonly fineTexture?: FarFineTexture;
  /** Fine far nodes cannot be built here (WebGL 2; voxel-far-mesh.ts `onFineUnavailable`). */
  readonly onFineUnavailable?: () => void;
  /**
   * What casts a relief chunk's shadow: its plain surfaces (`plain`, the
   * default; see {@link VoxelChunkView} `addCaster`) or the displaced relief
   * mesh itself (`relief`: every lattice triangle drawn into each shadow map,
   * kept to compare).
   */
  readonly reliefCasters?: 'plain' | 'relief';
}

/** GPU bytes an instance takes in a piece draw: its matrix and its `pieceU` (voxel-trim-u.ts). */
const PIECE_INSTANCE_BYTES = (INSTANCE_MATRIX_FLOATS + PIECE_DATA_FLOATS) * Float32Array.BYTES_PER_ELEMENT;

/** Every drawn chunk, mip node and seam of a voxel world, in one scene group. */
export class VoxelChunkView {
  readonly root = new THREE.Group();
  /** The surfaces raycasts hit (picking a cell to edit): level-0 chunks only, the cells an edit names. */
  readonly pickable: THREE.Object3D[] = [];
  /** A join writes a chunk's shader grid entries here; the upload reads them. */
  readonly cells: Uint16Array;
  /** Drawn objects by level, by key within the level. */
  private readonly levels: Array<Map<number, ChunkDraw>> = [];
  private readonly seams = new Map<string, SeamDraw>();
  /** The kit pieces of every chunk, drawn per kind across them. */
  readonly pieces: VoxelPieceBatches;
  /** The far field's draws (voxel-far-mesh.ts): past the near rings, under them. */
  readonly far: VoxelFarView;
  /** Inside {@link applyChunkDrawBatch}: the piece draws are written at its end. */
  private batching = false;
  /** Whether the near field (everything under {@link root} but the far field) is drawn; draws added while hidden come hidden. */
  private nearShown = true;
  private kitSet: VoxelKitSet | null;
  /** Kits' own crack layers the surface has now. */
  private crackLayers = 0;
  private kitLoaded: (() => void) | null = null;
  /** Told when kit meshes arrived (or the kits changed) and the pieces that waited were built: the draws' bytes changed, for the stream budget. */
  rebuilt: (() => void) | null = null;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly at = new THREE.Vector3();
  private readonly tip = new THREE.Quaternion();
  private readonly grid: ChunkGrid;
  private readonly origin: FloatingOrigin;
  private readonly shading: VoxelSurface;
  private readonly renderer: VoxelGridRenderer;
  private readonly shadows: boolean;
  private readonly fastPaths: boolean;
  private readonly staticCasters: boolean;
  private readonly plainCasters: boolean;
  /** Triangles drawn (seams included), and of them the seams'. */
  triangles = 0;
  /** Vertices of the chunk and node surfaces drawn (seams not counted), and of them the relief meshes' (displaced). */
  vertices = 0;
  reliefVertices = 0;
  seamTriangles = 0;
  /** Triangles of the plain shadow casters drawn for relief chunks (shadow passes only; not in {@link triangles}). */
  casterTriangles = 0;
  /** The plain casters' material (made with the first caster). */
  private caster: THREE.Material | null = null;
  /** Objects whose meshes were built (chunks and nodes), and shader grids uploaded or set (one solid entry). */
  meshBuilds = 0;
  shaderSets = 0;
  /** ms to upload one grid. */
  readonly uploadMs = new SampleRing();
  /** The decal layers every draw is in (undefined: every layer), and who hears of the chunks' surfaces. */
  private decalLayers: number | undefined = undefined;
  private decalSurfaces: VoxelDecalSurfaces | null = null;

  constructor(opts: VoxelChunkViewOptions) {
    this.grid = opts.grid;
    this.origin = opts.origin;
    this.shading = opts.surface;
    this.renderer = opts.renderer;
    this.shadows = opts.shadows === true;
    this.fastPaths = opts.fastPaths !== false;
    this.staticCasters = opts.staticCasters === true;
    this.plainCasters = opts.reliefCasters !== 'relief';
    this.cells = new Uint16Array(opts.surface.grids.layout.side ** 3);
    this.pieces = new VoxelPieceBatches({ origin: opts.origin, shadows: this.shadows });
    this.root.add(this.pieces.root);
    // Its chunk, node and seam surfaces are occlusion culling's draws, though they sit below this root.
    markOccludeeGroup(this.root);
    this.far = new VoxelFarView({ grid: opts.grid, origin: opts.origin, surface: opts.surface, renderer: opts.renderer, visibility: opts.farVisibility !== false, ...(opts.onFarSeen !== undefined ? { onSeen: opts.onFarSeen } : {}), ...(opts.onFineUnavailable !== undefined ? { onFineUnavailable: opts.onFineUnavailable } : {}), ...(opts.fineTexture !== undefined ? { fineTexture: opts.fineTexture } : {}) });
    this.root.add(this.far.root);
    this.kitSet = null;
    this.setKits(opts.kits ?? null);
  }

  /** Piece instances drawn (every chunk's), and the draws they take (one a kind across the chunks). */
  get instances(): number {
    return this.pieces.instances;
  }

  get pieceDraws(): number {
    return this.pieces.draws;
  }

  /** Of the instances drawn, the kit pieces (every instance drawn is one). */
  get piecesDrawn(): { readonly kit: number } {
    return { kit: this.pieces.instances };
  }

  /** Piece instances a chunk (or a node of `level`) draws. */
  piecesOf(cx: number, cy: number, cz: number, level = 0): number {
    const m = this.levels[level]?.get(chunkKey(this.grid, cx, cy, cz));
    return m === undefined ? 0 : this.pieces.countOf(m);
  }

  /** The kit pieces drawn now (null: none). */
  get kits(): VoxelKitSet | null {
    return this.kitSet;
  }

  /**
   * Draws kit pieces from `set` from now on (a world's piece table changed:
   * its streamer derives again what the change touches, and those draws come
   * with the new pieces). Drawn chunks keep the pieces they were built with,
   * but those that waited for meshes are built again now, and whenever the
   * set's meshes finish loading. The surface's crack textures follow the
   * set's kits (a kit's own once it has loaded, else the engine's).
   */
  setKits(set: VoxelKitSet | null): void {
    this.kitLoaded?.();
    this.kitLoaded = null;
    this.kitSet = set;
    if (set !== null) {
      const off = set.meshes.onLoaded(() => {
        this.setCracks();
        this.buildWaiting();
      });
      this.kitLoaded = off;
    }
    this.setCracks();
    this.buildWaiting();
  }

  /** Every draw (pieces and seams included) is in decal layers `mask` from now on (undefined: every layer). */
  setDecalLayers(mask: number | undefined): void {
    if (mask === this.decalLayers) return;
    this.decalLayers = mask;
    applyObjectDecalLayers(this.root, mask);
    this.pieces.setDecalLayers(mask);
    // A clipped decal reads its surfaces' layers when it cuts: each surface comes again, so the decals over it look again.
    for (const m of this.surfaceMeshes()) {
      this.decalSurfaces?.removed(m);
      this.decalSurfaces?.added(m);
    }
  }

  /** Tell `l` of every level-0 chunk's surface as it comes, goes and moves from now on (null: no one); the drawn ones come now. */
  setDecalSurfaces(l: VoxelDecalSurfaces | null): void {
    if (l === this.decalSurfaces) return;
    for (const m of this.surfaceMeshes()) this.decalSurfaces?.removed(m);
    this.decalSurfaces = l;
    for (const m of this.surfaceMeshes()) this.tellAdded(m);
  }

  private *surfaceMeshes(): Iterable<THREE.Mesh> {
    for (const d of this.levels[0]?.values() ?? []) if (d.decalSurface !== null) yield d.decalSurface;
  }

  /**
   * Its world matrix first: the listener reads the mesh's place before the next frame's matrix update. Forced: a
   * mesh that never moves itself is not marked for a world-matrix update, so three would leave it as it was.
   */
  private tellAdded(m: THREE.Mesh): void {
    if (this.decalSurfaces === null) return;
    m.updateWorldMatrix(true, false, true);
    this.decalSurfaces.added(m);
  }

  /** The surface's crack layers from the kit set now (none: every material the engine's). */
  private setCracks(): void {
    const c = this.kitSet?.crackLayers() ?? null;
    if (c === null) {
      if (this.crackLayers !== 0) this.shading.setCracks([], () => 0);
      this.crackLayers = 0;
      return;
    }
    // A kit's own crack textures are rare: the array is rebuilt only when some kit has one (or had one).
    if (c.layers.length === 0 && this.crackLayers === 0) return;
    this.shading.setCracks(c.layers, c.materialLayer);
    this.crackLayers = c.layers.length;
  }

  /** Builds again the pieces of every drawn chunk and node that waited for kit meshes, then tells {@link rebuilt}. */
  private buildWaiting(): void {
    for (const map of this.levels) for (const m of map?.values() ?? []) if (m.waiting) this.givePieces(m, this.pieceRuns(m));
    this.flushPieces();
    this.rebuilt?.();
  }

  /** Writes the piece draws a change touched, unless a batch is being applied (it writes them at its end). */
  private flushPieces(): void {
    if (!this.batching) this.pieces.flush();
  }

  /** Applies `f` (a batch's changes) with the piece draws written once, after it. */
  inBatch<T>(f: () => T): T {
    const was = this.batching;
    this.batching = true;
    try {
      return f();
    } finally {
      this.batching = was;
      this.flushPieces();
    }
  }

  /** Level-0 chunks' GPU bytes now (`[cx, cy, cz, bytes]` repeated), as a batch reports them. */
  chunkBytes(): number[] {
    const out: number[] = [];
    const e = this.grid.edge;
    for (const m of this.levels[0]?.values() ?? []) out.push(m.cell[0] / e, m.cell[1] / e, m.cell[2] / e, m.bytes);
    return out;
  }

  /** Objects drawing with a grid region. */
  get regions(): number {
    return this.shading.grids.count;
  }

  /** Chunks and nodes drawn (every level). */
  get count(): number {
    let n = 0;
    for (const m of this.levels) n += m?.size ?? 0;
    return n;
  }

  /** Objects drawn per level (index: the level). */
  levelCounts(): number[] {
    return Array.from({ length: this.levels.length }, (_, l) => this.levels[l]?.size ?? 0);
  }

  /** Seams drawn. */
  get seamCount(): number {
    return this.seams.size;
  }

  /** GPU bytes of the mip nodes (level 1 and up: meshes and grid regions) and the seams drawn. */
  coarseBytes(): number {
    let n = 0;
    for (let l = 1; l < this.levels.length; l++) for (const m of this.levels[l]?.values() ?? []) n += m.bytes;
    for (const s of this.seams.values()) n += s.bytes;
    return n;
  }

  /** Whether a chunk (or a node of `level`) is drawn. */
  has(cx: number, cy: number, cz: number, level = 0): boolean {
    return this.levels[level]?.has(chunkKey(this.grid, cx, cy, cz)) ?? false;
  }

  private at0(level: number, nx: number, ny: number, nz: number): [number, number, number] {
    const s = 2 ** level;
    return [chunkOrigin(this.grid, nx) * s, chunkOrigin(this.grid, ny) * s, chunkOrigin(this.grid, nz) * s];
  }

  private place(o3: THREE.Object3D, cell: readonly number[]): void {
    const o = this.origin.origin;
    o3.position.set((cell[0]! - o.x) * VOXEL_SIZE_M, (cell[1]! - o.y) * VOXEL_SIZE_M, (cell[2]! - o.z) * VOXEL_SIZE_M);
    // Still objects keep their matrices (no per-frame matrix work): made here, when set and after a re-base.
    o3.updateMatrix();
  }

  /** After a floating-origin re-base: every object's 32-bit position again, from its integer cell. */
  rebase(): void {
    for (const m of this.levels) if (m !== undefined) for (const d of m.values()) this.place(d.group, d.cell);
    for (const s of this.seams.values()) this.place(s.mesh, s.cell);
    this.pieces.rebase();
    this.far.rebase();
    for (const m of this.surfaceMeshes()) {
      m.updateWorldMatrix(true, false, true);
      this.decalSurfaces?.moved(m);
    }
  }

  /**
   * Replaces a chunk's draw (or, with `level` ≥ 1, a mip node's) with its
   * joined sections' (null: nothing to draw, it is removed); the shader
   * grid's entries are read from {@link cells} when the draw has no solid
   * entry. Returns the bytes it holds (meshes and grid).
   */
  set(cx: number, cy: number, cz: number, d: VoxelChunkDraw | null, level = 0): number {
    if (d === null) {
      this.remove(cx, cy, cz, level);
      return 0;
    }
    return this.commit(this.prepare(cx, cy, cz, d, level));
  }

  /**
   * Builds a chunk's (or node's) draw without showing it: its meshes, its
   * kit pieces' instance data and its shader grid (uploaded into a region of
   * its own, so the draw it replaces keeps reading its old one) are made,
   * nothing drawn changes until {@link commit}. The shader grid is read from
   * {@link cells} now. What a draw costs to make is here; showing it is
   * cheap, so a swap's draws can be made over several frames and shown in
   * one ({@link VoxelBatchStage}).
   */
  prepare(cx: number, cy: number, cz: number, d: VoxelChunkDraw, level = 0): VoxelPreparedDraw {
    const key = chunkKey(this.grid, cx, cy, cz);
    const group = new THREE.Group();
    group.name = level === 0 ? `voxel-chunk ${cx},${cy},${cz}` : `voxel-node ${level}:${cx},${cy},${cz}`;
    group.matrixAutoUpdate = false;
    let bytes = 0;
    const cellM = mipCellMetres(level);
    const surface = this.shading.objectValues(cellM);
    const cell = this.at0(level, cx, cy, cz);
    gridPhases(cell, VOXEL_SIZE_M, PHASE_CELLS, surface.phase, surface.slopePhase, surface.slope5Phase);
    const geo = voxelSurfaceGeometry([d.ground, d.base], cellM, this.shading.reliefDepthM);
    let decalSurface: THREE.Mesh | null = null;
    let surfaceMesh: THREE.Mesh | null = null;
    if (geo !== null) {
      const mesh = new THREE.Mesh(geo, this.shading.material);
      surfaceMesh = mesh;
      // Culled whole on the GPU (a row of occlusion culling's table) like any other draw of the scene.
      markOccludee(mesh, 'single');
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = mesh.receiveShadow = this.shadows;
      this.castStatic(mesh);
      mesh.userData['voxelChunk'] = key;
      mesh.userData['voxelLevel'] = level;
      mesh.userData[VOXEL_SURFACE_KEY] = surface;
      if (this.decalLayers !== undefined) mesh.userData[DECAL_LAYERS_KEY] = this.decalLayers;
      if (level === 0) {
        mesh.userData[DECAL_SURFACE_KEY] = true;
        decalSurface = mesh;
      }
      group.add(mesh);
      bytes += geometryBytes(geo);
      if (geo.getAttribute(VOXEL_CREASE_ATTRIBUTE) !== undefined) bytes += this.addCaster(group, mesh, d, cellM);
    }
    const kept = keptInstances(d.instances, this.kitEntriesOf(d));
    const m: ChunkDraw = { group, cell, level, bytes, surface, region: null, instances: kept.instances, materials: kept.materials, wet: kept.wet, pieceBytes: 0, cellMetres: cellM, waiting: false, decalSurface, mesh: surfaceMesh };
    const runs = this.pieceRuns(m);
    const empty = group.children.length === 0 && runs.instances === 0 && !runs.waiting;
    // The grid goes into a region of its own now; the draw it replaces is shown with its old one until the commit.
    if (!empty) this.applyShader(m, d.solid);
    return { cx, cy, cz, level, key, draw: empty ? null : m, runs, kits: this.kitSet };
  }

  /**
   * Shows a prepared draw in place of what the chunk (or node) draws now
   * (an empty one removes it); returns the bytes it holds. A draw prepared
   * before the view's kits changed has its pieces built again from the kits
   * now, as do pieces that were waiting for meshes.
   */
  commit(p: VoxelPreparedDraw): number {
    this.remove(p.cx, p.cy, p.cz, p.level);
    this.meshBuilds++;
    const m = p.draw;
    if (m === null) return 0;
    if (m.mesh !== null) {
      const geo = m.mesh.geometry;
      if (p.level === 0) this.pickable.push(m.mesh);
      this.triangles += (geo.index?.count ?? 0) / 3;
      this.vertices += geo.getAttribute('position').count;
      if (geo.getAttribute(VOXEL_CREASE_ATTRIBUTE) !== undefined) this.reliefVertices += geo.getAttribute('position').count;
    }
    for (const c of m.group.children) if (c instanceof THREE.Mesh && c.userData[VOXEL_CASTER_KEY] === true) this.casterTriangles += ((c.geometry as THREE.BufferGeometry).index?.count ?? 0) / 3;
    this.givePieces(m, p.kits === this.kitSet && !p.runs.waiting ? p.runs : this.pieceRuns(m));
    this.place(m.group, m.cell);
    m.group.visible = this.nearShown;
    this.root.add(m.group);
    if (m.decalSurface !== null) this.tellAdded(m.decalSurface);
    let map = this.levels[p.level];
    if (map === undefined) {
      for (let l = this.levels.length; l <= p.level; l++) this.levels[l] = new Map();
      map = this.levels[p.level]!;
    }
    map.set(p.key, m);
    this.flushPieces();
    return m.bytes;
  }

  /** Lets go of a prepared draw that will not be shown (its world closed): its grid region and meshes. */
  discard(p: VoxelPreparedDraw): void {
    const m = p.draw;
    if (m === null) return;
    if (m.region !== null) this.shading.grids.release(m.region);
    for (const c of m.group.children) if (c instanceof THREE.Mesh) (c.geometry as THREE.BufferGeometry).dispose();
    disposeObjectTree(m.group);
  }

  /**
   * A relief mesh's shadow: with shadows on and the chunk's plain surfaces
   * given, the relief mesh casts none and the plain surfaces cast in its
   * place, drawn only by the shadow cameras ({@link OFF_VIEW_LAYER}). The
   * relief only recesses the plain surface (inward along its normal, never
   * out), so the plain solid holds the displaced one and its shadow is the
   * one every chunk outside the ring casts: no edge or seam lets light
   * through, and the shadow map draws the plain triangles (a sixteenth of
   * the relief ring's at 4 steps a cell) instead of the lattice. The relief
   * looks its shadow up at its plain place (the surface's received shadow
   * position), so a recessed point is lit or shaded as the plain surface
   * there. Returns the caster's bytes (0: none built).
   */
  private addCaster(group: THREE.Group, relief: THREE.Mesh, d: VoxelChunkDraw, cellM: number): number {
    if (!this.shadows || !this.plainCasters || d.caster === undefined) return 0;
    const geo = voxelSurfaceGeometry([d.caster.ground, d.caster.base], cellM);
    if (geo === null) return 0;
    relief.castShadow = false;
    const mesh = new THREE.Mesh(geo, (this.caster ??= casterMaterial()));
    mesh.name = 'voxel shadow caster';
    mesh.matrixAutoUpdate = false;
    mesh.layers.set(OFF_VIEW_LAYER);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.userData[VOXEL_CASTER_KEY] = true;
    group.add(mesh);
    return geometryBytes(geo);
  }

  /**
   * Gives a drawn chunk's (or node's) surface its new shader data (a
   * material or wetness change): its grid region uploaded again from
   * {@link cells}, or its one solid entry passed; no mesh is touched.
   * Returns its bytes now (0: not drawn).
   */
  setShader(cx: number, cy: number, cz: number, solid: number, level = 0): number {
    const m = this.levels[level]?.get(chunkKey(this.grid, cx, cy, cz));
    if (m === undefined) return 0;
    this.applyShader(m, solid);
    // Its pieces' wetness from the new data (their kits stay: a kit follows a derive).
    if (m.instances.count > 0) {
      const wet = keptInstances(m.instances, this.kitEntriesOf({ solid })).wet;
      if (wet.some((w, k) => w !== m.wet[k])) {
        m.wet = wet;
        this.givePieces(m, this.pieceRuns(m));
        this.flushPieces();
      }
    }
    return m.bytes;
  }

  /** Drawn surfaces (chunks, nodes and seams) by their program's name (diagnostics). */
  pathCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    const add = (mesh: THREE.Mesh | null): void => {
      if (mesh === null) return;
      const name = (mesh.material as THREE.Material).name;
      out[name] = (out[name] ?? 0) + 1;
    };
    for (const level of this.levels) for (const m of level?.values() ?? []) add(m.mesh);
    for (const seam of this.seams.values()) add(seam.mesh);
    return out;
  }

  /** With {@link VoxelChunkViewOptions.staticCasters}: `mesh` casts and receives as a static caster (the cached map). */
  private castStatic(mesh: THREE.Mesh): void {
    if (!this.staticCasters) return;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData[STATIC_CASTER_KEY] = true;
  }

  private applyShader(m: ChunkDraw, solid: number): void {
    this.shaderSets++;
    const grids = this.shading.grids;
    if (m.mesh !== null) {
      const path = this.fastPaths ? voxelDrawPath(solid >= 0 ? null : this.cells, solid, m.level) : FULL_PATH;
      m.mesh.material = this.shading.materialFor(path);
    }
    if (solid >= 0) {
      if (m.region !== null) {
        grids.release(m.region);
        m.region = null;
        m.bytes -= grids.regionBytes;
      }
      m.surface.slot.set(0, 0, 0, solid);
      return;
    }
    const t0 = performance.now();
    if (m.region === null) {
      m.region = grids.allocate(this.renderer);
      m.bytes += grids.regionBytes;
    }
    grids.upload(this.renderer, m.region, this.cells);
    m.surface.slot.set(m.region.x, m.region.y, m.region.z, -1);
    this.uploadMs.add(performance.now() - t0);
  }

  /** Reads each kit instance's cell entry (material, wetness) from the shader data the draw arrived with ({@link cells}, or its one solid entry). */
  private kitEntriesOf(d: Pick<VoxelChunkDraw, 'solid'>): (x: number, y: number, z: number) => number {
    if (d.solid >= 0) return () => d.solid;
    const side = this.shading.grids.layout.side;
    const b = SHADER_BORDER_CELLS;
    const cells = this.cells;
    return (x, y, z) => cells[((x + b) * side + (z + b)) * side + (y + b)]!;
  }

  /** A draw's runs in the view's piece draws (none: its pieces leave them) and its bytes from them; `pieceRuns(m)` builds them again from its instances and the kits the view has now. */
  private givePieces(m: ChunkDraw, r: PieceRuns): void {
    m.bytes -= m.pieceBytes;
    m.pieceBytes = 0;
    m.waiting = r.waiting;
    if (r.runs.length === 0) {
      this.pieces.remove(m);
      return;
    }
    const e = this.grid.edge * 2 ** m.level;
    this.pieces.set(m, [m.cell[0]!, m.cell[1]!, m.cell[2]!], e * VOXEL_SIZE_M, r.runs);
    m.pieceBytes = r.instances * PIECE_INSTANCE_BYTES;
    m.bytes += m.pieceBytes;
  }

  /** A draw's kit pieces as runs (one a resolved piece kind) from its instances and the kits the view has now; nothing of the view changes. */
  private pieceRuns(m: ChunkDraw): PieceRuns {
    const list = m.instances;
    let waiting = false;
    if (list.count === 0) return { runs: [], instances: 0, waiting };
    // One run a kit piece's resolved draw: its mesh (cut flush or not) and material.
    const byMesh = new Map<string, PiecePlacement & { key: string; geometry: THREE.BufferGeometry; material: THREE.Material; offsets: number[]; uPerMetre?: number; runAxis: 0 | 1 | 2 }>();
    for (let k = 0; k < list.count; k++) {
      const o = k * INSTANCE_BYTES;
      const piece = list.data[o + 4]! | (list.data[o + 5]! << 8);
      const r = this.kitSet?.resolve(m.materials[k]!, piece, list.data[o + 6]! | (list.data[o + 7]! << 8)) ?? null;
      if (r === 'pending') {
        waiting = true;
        continue;
      }
      if (r === null) continue;
      // A piece beside an opening draws its mesh cut at the faces its instance names, turned into its case's axes.
      const flush = instanceFlushFaces(dressingAt(list.data, o));
      const caseFaces = flush === 0 ? 0 : caseFlushFaces(flush, list.data[o + 3]! & 3);
      const geometry = caseFaces === 0 || this.kitSet === null ? r.geometry : this.kitSet.meshes.flushGeometry(r.geometry, r.rotation, caseFaces);
      // The draw's key names what it draws with, so kinds of two kit sets (a changed table) never share a draw.
      const key = `${geometry.uuid}|${r.material.uuid}|${r.key}|f${caseFaces}`;
      // A case's quarter turn takes its +x to +z (kit-cases.ts applyFold): a negative turn about +y in three.
      if (!byMesh.has(key)) byMesh.set(key, { key, geometry, material: r.material, turnSign: -1, rotation: r.rotation, stagger: r.stagger, halfRun: r.halfRun, caseId: r.caseId, mirror: r.mirror, runAxis: r.runAxis, offsets: [], ...(r.uPerMetre === undefined ? {} : { uPerMetre: r.uPerMetre }), ...(r.scatterCount === undefined ? {} : { scatterCount: r.scatterCount, seed: r.seed }) });
      byMesh.get(key)!.offsets.push(o);
    }
    // A piece is drawn at its draw's cell size (a chunk's: 0.5 m).
    const cellM = m.cellMetres;
    const k0 = cellM / VOXEL_SIZE_M;
    const runs: PieceRun[] = [];
    let instances = 0;
    for (const g of byMesh.values()) {
      const n = g.offsets.length;
      if (n === 0) continue;
      const matrices = new Float32Array(n * INSTANCE_MATRIX_FLOATS);
      const data = new Float32Array(n * PIECE_DATA_FLOATS);
      g.offsets.forEach((o, i) => {
        const rot = list.data[o + 3]!;
        this.at.set((list.data[o]! + 0.5) * cellM, (list.data[o + 1]! + 0.5) * cellM, (list.data[o + 2]! + 0.5) * cellM);
        const cell0 = [m.cell[0]! + list.data[o]! * k0, m.cell[1]! + list.data[o + 1]! * k0, m.cell[2]! + list.data[o + 2]! * k0];
        pieceMatrix(this.matrix, rot, instancePlaceOf(rot), this.at, cellM, cell0, m.level, g, instanceScatter(dressingAt(list.data, o))).toArray(matrices, i * INSTANCE_MATRIX_FLOATS);
        // A trim piece's world-anchored U (voxel-trim-u.ts); every piece's wetness.
        let offset = 0;
        let factor = 1;
        if (g.uPerMetre !== undefined) {
          const local = [list.data[o]!, list.data[o + 1]!, list.data[o + 2]!];
          const mirror = ((list.data[o + 6]! | (list.data[o + 7]! << 8)) & PIECE_VARIANT_MIRROR) !== 0;
          // The mesh's run through its slot rotation, the tip and the turns: a vertical edge's U runs up y.
          const q = pieceTurn(this.quat, rot, instancePlaceOf(rot), g.turnSign);
          if (g.rotation !== 0) q.multiply(this.tip.setFromRotationMatrix(cubeRotationMatrix(g.rotation)));
          const [axis, sign] = runAxisOf(q, g.runAxis, mirror, mirrorAxisOf(g.rotation));
          [offset, factor] = pieceU(g.uPerMetre, m.cell, local, cellM, axis, sign);
        }
        data[i * PIECE_DATA_FLOATS] = offset;
        data[i * PIECE_DATA_FLOATS + 1] = factor;
        data[i * PIECE_DATA_FLOATS + PIECE_WET_FLOAT] = m.wet[o / INSTANCE_BYTES]!;
      });
      runs.push({ kind: { key: g.key, geometry: g.geometry, material: g.material }, n, matrices, data });
      instances += n;
    }
    return { runs, instances, waiting };
  }

  /** Stops drawing a chunk (unloaded, or nothing left to draw), or a node of `level`. */
  remove(cx: number, cy: number, cz: number, level = 0): void {
    const map = this.levels[level];
    if (map === undefined) return;
    const key = chunkKey(this.grid, cx, cy, cz);
    const m = map.get(key);
    if (m === undefined) return;
    map.delete(key);
    this.removeDraw(m);
  }

  private removeDraw(m: ChunkDraw): void {
    this.root.remove(m.group);
    this.pieces.remove(m);
    this.flushPieces();
    if (m.decalSurface !== null) this.decalSurfaces?.removed(m.decalSurface);
    if (m.region !== null) this.shading.grids.release(m.region);
    for (const child of m.group.children) {
      const i = this.pickable.indexOf(child);
      if (i >= 0) this.pickable.splice(i, 1);
      if (child instanceof THREE.Mesh && child.userData[VOXEL_CASTER_KEY] === true) {
        this.casterTriangles -= ((child.geometry as THREE.BufferGeometry).index?.count ?? 0) / 3;
        (child.geometry as THREE.BufferGeometry).dispose();
      } else if (child instanceof THREE.Mesh) {
        const g = child.geometry as THREE.BufferGeometry;
        this.triangles -= (g.index?.count ?? 0) / 3;
        this.vertices -= g.getAttribute('position').count;
        if (g.getAttribute(VOXEL_CREASE_ATTRIBUTE) !== undefined) this.reliefVertices -= g.getAttribute('position').count;
        (child.geometry as THREE.BufferGeometry).dispose();
      }
    }
    // The renderer's render objects of these meshes listen on the shared surface material and the lights, so
    // without the objects' own dispose they (and through them every mesh's geometry arrays) outlive the chunk.
    disposeObjectTree(m.group);
  }

  /**
   * Replaces the seam on face `face` of the coarse node (level ≥ 1, node
   * nx, ny, nz) with `pieces` (none: removed). The seam is shaded from that
   * node's grid, whichever draw the node has at the time. Returns its bytes.
   */
  setSeam(level: number, nx: number, ny: number, nz: number, face: number, pieces: readonly VoxelSeamPiece[] | null): number {
    this.removeSeam(level, nx, ny, nz, face);
    if (pieces === null || pieces.length === 0 || level < 1) return 0;
    const cell = this.at0(level, nx, ny, nz);
    const fineM = mipCellMetres(level - 1);
    const step = fineM / POSITION_STEPS_PER_CELL;
    // Placed at the coarse node's corner (its grid's frame): each piece's origin moved into it.
    const parts = pieces.flatMap((p) => {
      const offset: [number, number, number] = [0, 1, 2].map((a) => p.origin[a]! * fineM - cell[a]! * VOXEL_SIZE_M) as [number, number, number];
      return [{ buf: p.ground, stepMetres: step, offset }, { buf: p.base, stepMetres: step, offset }];
    });
    const geo = placedGeometry(parts);
    if (geo === null) return 0;
    // A seam lies on a coarse node's face and is shaded from that node's grid, which may change on its own: two materials.
    const mesh = new THREE.Mesh(geo, this.fastPaths ? this.shading.materialFor({ materials: 2, projection: level >= AXIS_PROJECTION_LEVEL ? 'axis' : 'blend' }) : this.shading.material);
    mesh.castShadow = mesh.receiveShadow = this.shadows;
    this.castStatic(mesh);
    markOccludee(mesh, 'single');
    mesh.name = `voxel-seam ${seamId(level, nx, ny, nz, face)}`;
    mesh.matrixAutoUpdate = false;
    if (this.decalLayers !== undefined) mesh.userData[DECAL_LAYERS_KEY] = this.decalLayers;
    const key = chunkKey(this.grid, nx, ny, nz);
    const map = (): Map<number, ChunkDraw> | undefined => this.levels[level];
    // The node's draw is replaced on its own (a new result, a shader change): the seam reads whichever is drawn.
    Object.defineProperty(mesh.userData, VOXEL_SURFACE_KEY, { get: () => map()?.get(key)?.surface ?? NO_SURFACE, enumerable: false });
    this.place(mesh, cell);
    mesh.visible = this.nearShown;
    this.root.add(mesh);
    const triangles = (geo.index?.count ?? 0) / 3;
    const bytes = geometryBytes(geo);
    this.seams.set(seamId(level, nx, ny, nz, face), { mesh, cell, level, node: [nx, ny, nz, face], triangles, bytes });
    this.triangles += triangles;
    this.seamTriangles += triangles;
    return bytes;
  }

  /** The near field's draws: chunks, mip nodes, seams and the kit pieces (every child of {@link root} but the far field's). */
  nearObjects(): THREE.Object3D[] {
    return this.root.children.filter((c) => c !== this.far.root);
  }

  /** Shows or hides the near field (a measuring run's pass hidden; nothing is rebuilt). */
  showNear(on: boolean): void {
    this.nearShown = on;
    for (const c of this.nearObjects()) c.visible = on;
  }

  removeSeam(level: number, nx: number, ny: number, nz: number, face: number): void {
    const id = seamId(level, nx, ny, nz, face);
    const s = this.seams.get(id);
    if (s === undefined) return;
    this.seams.delete(id);
    this.root.remove(s.mesh);
    s.mesh.geometry.dispose();
    disposeObjectTree(s.mesh);
    this.triangles -= s.triangles;
    this.seamTriangles -= s.triangles;
  }

  /** Removes every chunk, node and seam; the stand-in pieces and the piece materials are disposed (the surface and a kit's pieces are their owners'). */
  dispose(): void {
    this.kitLoaded?.();
    this.kitLoaded = null;
    for (const m of this.levels) {
      if (m === undefined) continue;
      for (const d of m.values()) this.removeDraw(d);
      m.clear();
    }
    for (const s of [...this.seams.values()]) this.removeSeam(s.level, ...s.node);
    this.pieces.dispose();
    this.far.dispose();
    this.caster?.dispose();
    this.caster = null;
  }
}

/** The dressing word of the instance at byte `o` of `data` (derived-mesh.ts). */
function dressingAt(data: Uint8Array, o: number): number {
  const at = o + INSTANCE_DRESSING_OFFSET;
  return (data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24)) >>> 0;
}

/**
 * A draw's instances copied (a batch's buffers may be reused once applied)
 * with each kit piece's cell material and wetness (0 … 1) read now, while
 * the draw's shader data is in the view's grid buffer.
 */
function keptInstances(list: InstanceList, entryAt: (x: number, y: number, z: number) => number): { instances: InstanceList; materials: Uint16Array; wet: Float32Array } {
  const data = list.data.slice(0, list.count * INSTANCE_BYTES);
  const materials = new Uint16Array(list.count);
  const wet = new Float32Array(list.count);
  for (let k = 0; k < list.count; k++) {
    const o = k * INSTANCE_BYTES;
    // The kit and the wetness are the dressing cell's: the instance's own cell or one beside it (in the shader data's border).
    const [dx, dy, dz] = instanceDressingCell(dressingAt(data, o));
    const entry = entryAt(data[o]! + dx, data[o + 1]! + dy, data[o + 2]! + dz);
    materials[k] = entry & MATERIAL_ID_MAX;
    wet[k] = shaderEntryWetness(entry) / WETNESS_MAX;
  }
  return { instances: { count: list.count, data }, materials, wet };
}

/** What applying a batch replaced: per level-0 chunk, its bytes now (`[cx, cy, cz, bytes]` repeated), the coarse draws' bytes, and the entries applied. */
export interface VoxelBatchApplied {
  /** Level-0 chunks' GPU bytes, for the stream budget's mesh parts. */
  readonly chunkBytes: number[];
  /** GPU bytes of every node and seam drawn after the batch, for the stream budget's mip share. */
  readonly coarseBytes: number;
  /** Chunk and node entries applied (shader-only and removals included), and seams. */
  readonly replaced: number;
  readonly seams: number;
  /** GPU bytes of the far field's draws after the batch. */
  readonly farBytes: number;
}
