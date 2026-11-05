/**
 * The voxel world's draws: one object a 32³ storage chunk, built from the
 * chunk's joined derive sections (the streamer's `joinedChunk`), so the
 * object count, and with it the render CPU and the work a swap does on the
 * main thread, follows the chunk count however small the derive sections
 * are. Play, an exported game and the editor draw through this one view.
 *
 * A chunk is one mesh holding its ground and its modular base surfaces (the
 * same material, so one draw), plus the detail instances the assembly rules
 * resolved: the engine's default pieces (beams, rails, posts) one instanced
 * mesh a stand-in family and detail, and kit pieces one instanced mesh a
 * (kit piece, variant, mirror, detail): a chunk's at high detail, a level-1
 * node's at low; coarser nodes list no pieces and draw those cells as
 * bodies. A kit piece's kit is its cell's material's, read from the chunk's
 * shader data as the surface shader reads it; its mesh comes from the
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
 * A swap's draws are replaced in the task that announces them (a batch,
 * {@link applyChunkDrawBatch}: everything one streamer task changed, a
 * change of the levels drawn with its seams included), so all of them
 * change between the same two frames.
 *
 * Colours and patterns are stand-ins picked by material id: materials,
 * kits and detail art come later.
 */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import {
  chunkKey,
  chunkOrigin,
  INSTANCE_BYTES,
  defaultPieceFamily,
  INSTANCE_FLAG,
  instancePlaceOf,
  mipCellMetres,
  PIECE_FAMILY,
  PIECE_VARIANT_MIRROR,
  POSITION_STEPS_PER_CELL,
  SampleRing,
  SURFACE_VERTEX_BYTES,
  VOXEL_SIZE_M,
  type ChunkDrawBatch,
  type ChunkGrid,
  type FloatingOrigin,
  type JoinedDraw,
  type SeamPieceWire,
  type SurfaceBuffer,
  type InstanceList,
  MATERIAL_ID_MAX,
  SHADER_BORDER_CELLS,
} from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import type { VoxelKitSet } from './voxel-kit-pieces';
import { INSTANCE_MATRIX_FLOATS } from './attribute-instancing';
import { disposeInstancedTrimGeometry, instancedTrimGeometry, PIECE_U_ATTRIBUTE, pieceU, runAxisOf } from './voxel-trim-u';
import { cubeRotationMatrix, pieceMatrix, pieceTurn, type PiecePlacement } from './voxel-piece-placement';
import { gridPhases } from './voxel-surface-projection';
import { PHASE_CELLS, VOXEL_PATTERNS, VOXEL_SURFACE_KEY, type VoxelGridRenderer, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceObject } from './voxel-surface';

/** Stand-in colours, by material id (wrapping): earth, rock and building tones, so neighbouring ids read apart. */
const SWATCHES = [0x8a8f96, 0x7d7f84, 0x7a5a3c, 0x5f8f3e, 0xc8b47c, 0x4a78b8, 0x9a958c, 0xb0a48c, 0xa9a39a, 0x8b5a33, 0xd8d0c0, 0x9c4a3a, 0xb08850, 0xa0523c, 0x6d6a5f, 0x8c7a6b];

/** A material id's stand-in look: a swatch and a test pattern, both by id. */
export function voxelStandInLook(material: number): VoxelMaterialLook {
  return { colour: SWATCHES[material % SWATCHES.length]!, pattern: material % VOXEL_PATTERNS };
}

/** Stand-in piece sizes (metres: along the run, up, across) by family. */
const PIECE_SIZE: Record<number, readonly [number, number, number]> = {
  [PIECE_FAMILY.beam]: [VOXEL_SIZE_M, 0.3, 0.3],
  [PIECE_FAMILY.rail]: [VOXEL_SIZE_M, 0.12, 0.14],
  [PIECE_FAMILY.post]: [0.12, VOXEL_SIZE_M, 0.12],
};
const PIECE_COLOUR: Record<number, number> = { [PIECE_FAMILY.beam]: 0x6b4423, [PIECE_FAMILY.rail]: 0x8a5a2b, [PIECE_FAMILY.post]: 0x7a4e25 };

/** The detail a piece is drawn at: a chunk's pieces high, a level-1 node's low (coarser nodes list none). */
export type VoxelPieceDetail = 'high' | 'low';

/**
 * Where a view gets a detail piece's mesh, by family ({@link PIECE_FAMILY})
 * and detail: a kit's authored high and low meshes are given here; without
 * one the view draws stand-ins. A mesh is in metres for a level-0 cell,
 * centred on the cell, its run along +x (the view turns and scales it to
 * the instance's cell). Null: the family is not drawn. The view never
 * disposes what this gives.
 */
export interface VoxelPieceMeshes {
  geometry(family: number, detail: VoxelPieceDetail): THREE.BufferGeometry | null;
}

/** Axis of a box's longest side (0 x, 1 y, 2 z). */
function longAxis(size: readonly [number, number, number]): number {
  return size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
}

/**
 * The stand-in pieces: a box of the family's size (12 triangles) at high
 * detail; at low detail the same box without its two ends along its long
 * axis (8 triangles: in a run the ends are hidden by the neighbours, and a
 * low piece is only seen from afar).
 */
export function standInPieceGeometry(family: number, detail: VoxelPieceDetail): THREE.BufferGeometry | null {
  const size = PIECE_SIZE[family];
  if (size === undefined) return null;
  const box = new THREE.BoxGeometry(size[0], size[1], size[2]);
  if (detail === 'high') return box;
  // BoxGeometry's index holds 6 faces of 6 indices in the order +x, −x, +y, −y, +z, −z.
  const axis = longAxis(size);
  const src = box.index!.array;
  const keep: number[] = [];
  for (let f = 0; f < 6; f++) if (f >> 1 !== axis) for (let k = 0; k < 6; k++) keep.push(src[f * 6 + k]!);
  box.setIndex(keep);
  box.clearGroups();
  return box;
}

const STAND_IN_PIECES: VoxelPieceMeshes = { geometry: standInPieceGeometry };

/** A surface buffer to place: metres a position step, and the metres added to every position. */
interface PlacedSurface {
  readonly buf: SurfaceBuffer;
  readonly stepMetres: number;
  readonly offset: readonly [number, number, number];
}

/**
 * Surface buffers as one float geometry (null when they hold no triangle):
 * the buffers' vertices one after another, indices offset to match.
 * `cellMetres`: the buffers' cells (a coarser level's for a mip node);
 * positions count from one cell below the object's corner.
 */
export function voxelSurfaceGeometry(bufs: readonly SurfaceBuffer[], cellMetres = VOXEL_SIZE_M): THREE.BufferGeometry | null {
  const offset: [number, number, number] = [-cellMetres, -cellMetres, -cellMetres];
  return placedGeometry(bufs.map((buf) => ({ buf, stepMetres: cellMetres / POSITION_STEPS_PER_CELL, offset })));
}

function placedGeometry(parts: readonly PlacedSurface[]): THREE.BufferGeometry | null {
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
    }
    const src = b.indices;
    if (v0 === 0) index.set(src, i0);
    else for (let k = 0; k < src.length; k++) index[i0 + k] = src[k]! + v0;
    v0 += b.vertexCount;
    i0 += src.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** Bytes a geometry holds on the GPU (its attributes and index). */
function geometryBytes(geo: THREE.BufferGeometry): number {
  let n = geo.index?.array.byteLength ?? 0;
  for (const a of Object.values(geo.attributes)) n += (a as THREE.BufferAttribute).array.byteLength;
  return n;
}

/** What a chunk's (or node's) draw is made of: its joined sections' surfaces, pieces and shader grid (a join, or a batch's copy of one). */
export type VoxelChunkDraw = Pick<JoinedDraw, 'ground' | 'base' | 'instances' | 'solid'>;

/** A seam piece: positions in the finer level's steps from its origin (finer-level cells). */
export type VoxelSeamPiece = SeamPieceWire;

interface ChunkDraw {
  readonly group: THREE.Group;
  /** The object's corner, level-0 cells. */
  readonly cell: readonly [number, number, number];
  readonly level: number;
  bytes: number;
  /** What the object's surface passes the shader. */
  readonly surface: VoxelSurfaceObject;
  /** The object's grid region (null: none, its one solid entry is passed instead). */
  region: THREE.Vector3 | null;
  /** Its detail instances (a copy) and each one's material (0 for a default piece), kept to build its kit pieces again. */
  readonly instances: InstanceList;
  readonly materials: Uint16Array;
  readonly cellMetres: number;
  /** Kit pieces whose meshes were still loading when its pieces were built. */
  waiting: boolean;
}

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
const NO_SURFACE: VoxelSurfaceObject = { slot: new THREE.Vector4(0, 0, 0, 0), phase: new THREE.Vector3(), slopePhase: new THREE.Vector3(), cellMetres: VOXEL_SIZE_M };

export interface VoxelChunkViewOptions {
  /** The storage chunks' grid (32³). */
  readonly grid: ChunkGrid;
  readonly origin: FloatingOrigin;
  /** The surface material and its grid store (a grid side of the chunk's: edge + 2 · border). */
  readonly surface: VoxelSurface;
  readonly renderer: VoxelGridRenderer;
  /** The default pieces' meshes by family; stand-ins when left out. */
  readonly pieces?: VoxelPieceMeshes;
  /** Kit pieces' meshes (the world's piece table and kits); absent: kit pieces are not drawn ({@link VoxelChunkView.setKits}). */
  readonly kits?: VoxelKitSet | null;
}

/** GPU bytes of one instanced piece draw: a matrix an instance, and a trim draw's world-anchored U (voxel-trim-u.ts). */
function pieceDrawBytes(mesh: THREE.InstancedMesh): number {
  const u = mesh.geometry.getAttribute(PIECE_U_ATTRIBUTE);
  return mesh.count * INSTANCE_MATRIX_FLOATS * Float32Array.BYTES_PER_ELEMENT + (u === undefined ? 0 : u.array.byteLength);
}

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
  private readonly pieceMaterials = new Map<number, MeshLambertNodeMaterial>();
  /** Piece meshes by family and detail (key family · 2 + low), and whether this view made them (stand-ins: it disposes those). */
  private readonly pieceMeshes = new Map<number, THREE.BufferGeometry | null>();
  private readonly pieceSource: VoxelPieceMeshes;
  private readonly ownsPieces: boolean;
  /** Pieces drawn, by detail, and of them kit pieces. */
  readonly piecesDrawn = { high: 0, low: 0, kit: 0 };
  /** Instanced piece meshes drawn (each one draw call). */
  pieceDraws = 0;
  private kitSet: VoxelKitSet | null;
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
  /** Triangles drawn (seams included), and of them the seams'. */
  triangles = 0;
  seamTriangles = 0;
  instances = 0;
  /** Objects whose meshes were built (chunks and nodes), and shader grids uploaded or set (one solid entry). */
  meshBuilds = 0;
  shaderSets = 0;
  /** ms to upload one grid. */
  readonly uploadMs = new SampleRing();

  constructor(opts: VoxelChunkViewOptions) {
    this.grid = opts.grid;
    this.origin = opts.origin;
    this.shading = opts.surface;
    this.renderer = opts.renderer;
    this.cells = new Uint16Array(opts.surface.grids.layout.side ** 3);
    this.pieceSource = opts.pieces ?? STAND_IN_PIECES;
    this.ownsPieces = opts.pieces === undefined;
    this.kitSet = null;
    this.setKits(opts.kits ?? null);
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
   * set's meshes finish loading.
   */
  setKits(set: VoxelKitSet | null): void {
    this.kitLoaded?.();
    this.kitLoaded = null;
    this.kitSet = set;
    if (set !== null) {
      const off = set.meshes.onLoaded(() => this.buildWaiting());
      this.kitLoaded = off;
    }
    this.buildWaiting();
  }

  /** Builds again the pieces of every drawn chunk and node that waited for kit meshes, then tells {@link rebuilt}. */
  private buildWaiting(): void {
    for (const map of this.levels) for (const m of map?.values() ?? []) if (m.waiting) this.buildPieces(m);
    this.rebuilt?.();
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
  }

  /**
   * Replaces a chunk's draw (or, with `level` ≥ 1, a mip node's) with its
   * joined sections' (null: nothing to draw, it is removed); the shader
   * grid's entries are read from {@link cells} when the draw has no solid
   * entry. Returns the bytes it holds (meshes and grid).
   */
  set(cx: number, cy: number, cz: number, d: VoxelChunkDraw | null, level = 0): number {
    this.remove(cx, cy, cz, level);
    if (d === null) return 0;
    const key = chunkKey(this.grid, cx, cy, cz);
    this.meshBuilds++;
    const group = new THREE.Group();
    group.name = level === 0 ? `voxel-chunk ${cx},${cy},${cz}` : `voxel-node ${level}:${cx},${cy},${cz}`;
    group.matrixAutoUpdate = false;
    let bytes = 0;
    const cellM = mipCellMetres(level);
    const surface = this.shading.objectValues(cellM);
    const cell = this.at0(level, cx, cy, cz);
    gridPhases(cell, VOXEL_SIZE_M, PHASE_CELLS, surface.phase, surface.slopePhase);
    const geo = voxelSurfaceGeometry([d.ground, d.base], cellM);
    if (geo !== null) {
      const mesh = new THREE.Mesh(geo, this.shading.material);
      mesh.matrixAutoUpdate = false;
      mesh.userData['voxelChunk'] = key;
      mesh.userData['voxelLevel'] = level;
      mesh.userData[VOXEL_SURFACE_KEY] = surface;
      group.add(mesh);
      if (level === 0) this.pickable.push(mesh);
      bytes += geometryBytes(geo);
      this.triangles += (geo.index?.count ?? 0) / 3;
    }
    const kept = keptInstances(d.instances, this.kitMaterialsOf(d));
    const m: ChunkDraw = { group, cell, level, bytes, surface, region: null, instances: kept.instances, materials: kept.materials, cellMetres: cellM, waiting: false };
    this.buildPieces(m);
    if (group.children.length === 0 && !m.waiting) return 0;
    this.place(group, cell);
    this.root.add(group);
    let map = this.levels[level];
    if (map === undefined) {
      for (let l = this.levels.length; l <= level; l++) this.levels[l] = new Map();
      map = this.levels[level]!;
    }
    map.set(key, m);
    this.applyShader(m, d.solid);
    return m.bytes;
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
    return m.bytes;
  }

  private applyShader(m: ChunkDraw, solid: number): void {
    this.shaderSets++;
    const grids = this.shading.grids;
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

  /** Reads each kit instance's cell material from the shader data the draw arrived with ({@link cells}, or its one solid entry). */
  private kitMaterialsOf(d: VoxelChunkDraw): (x: number, y: number, z: number) => number {
    if (d.solid >= 0) return () => d.solid & MATERIAL_ID_MAX;
    const side = this.shading.grids.layout.side;
    const b = SHADER_BORDER_CELLS;
    const cells = this.cells;
    return (x, y, z) => cells[((x + b) * side + (z + b)) * side + (y + b)]! & MATERIAL_ID_MAX;
  }

  /** Removes a draw's instanced pieces and builds them again from its instances and the pieces the view has now. */
  private buildPieces(m: ChunkDraw): void {
    for (const child of [...m.group.children]) {
      if (!(child instanceof THREE.InstancedMesh)) continue;
      m.group.remove(child);
      m.bytes -= pieceDrawBytes(child);
      this.dropPieceMesh(child);
    }
    m.waiting = false;
    const list = m.instances;
    if (list.count === 0) return;
    // One instanced mesh a draw: a default family and detail, or a kit piece's resolved key.
    const byMesh = new Map<string, PiecePlacement & { geometry: THREE.BufferGeometry; material: THREE.Material; kit: boolean; low: boolean; offsets: number[]; uPerMetre?: number; runAxis: 0 | 1 }>();
    for (let k = 0; k < list.count; k++) {
      const o = k * INSTANCE_BYTES;
      const piece = list.data[o + 4]! | (list.data[o + 5]! << 8);
      const low = (list.data[o + 3]! & INSTANCE_FLAG.low) !== 0;
      const family = defaultPieceFamily(piece);
      let key: string;
      if (family !== 0) {
        key = `f${family}:${low ? 1 : 0}`;
        if (!byMesh.has(key)) {
          const mk = family * 2 + (low ? 1 : 0);
          let box = this.pieceMeshes.get(mk);
          if (box === undefined) this.pieceMeshes.set(mk, (box = this.pieceSource.geometry(family, low ? 'low' : 'high')));
          if (box === null) continue;
          let mat = this.pieceMaterials.get(family);
          if (mat === undefined) this.pieceMaterials.set(family, (mat = cameraRelative(new MeshLambertNodeMaterial({ color: PIECE_COLOUR[family] ?? 0x888888 }))));
          // The stand-ins are symmetric under a half turn: their turn sign is the one they were always drawn with.
          byMesh.set(key, { geometry: box, material: mat, kit: false, low, turnSign: 1, rotation: 0, stagger: null, runAxis: 0, offsets: [] });
        }
      } else {
        const r = this.kitSet?.resolve(m.materials[k]!, piece, list.data[o + 6]! | (list.data[o + 7]! << 8), low) ?? null;
        if (r === 'pending') {
          m.waiting = true;
          continue;
        }
        if (r === null) continue;
        key = r.key;
        // A case's quarter turn takes its +x to +z (kit-cases.ts applyFold): a negative turn about +y in three.
        if (!byMesh.has(key)) byMesh.set(key, { geometry: r.geometry, material: r.material, kit: true, low, turnSign: -1, rotation: r.rotation, stagger: r.stagger, runAxis: r.runAxis, offsets: [], ...(r.uPerMetre === undefined ? {} : { uPerMetre: r.uPerMetre }) });
      }
      byMesh.get(key)?.offsets.push(o);
    }
    // A level-1 node's pieces are drawn at its cell's size: one piece a 1 m cell, its low mesh scaled with the cell.
    const cellM = m.cellMetres;
    const k0 = cellM / VOXEL_SIZE_M;
    for (const g of byMesh.values()) {
      const n = g.offsets.length;
      if (n === 0) continue;
      // A trim piece's draw has its own geometry for the instances' world-anchored U (voxel-trim-u.ts).
      const trim = g.uPerMetre === undefined ? null : instancedTrimGeometry(g.geometry, n);
      const mesh = new THREE.InstancedMesh(trim?.geometry ?? g.geometry, g.material, n);
      mesh.matrixAutoUpdate = false;
      if (trim !== null) {
        mesh.userData['voxelTrimGeometry'] = true;
        g.offsets.forEach((o, i) => {
          const local = [list.data[o]!, list.data[o + 1]!, list.data[o + 2]!];
          const mirror = ((list.data[o + 6]! | (list.data[o + 7]! << 8)) & PIECE_VARIANT_MIRROR) !== 0;
          const rot = list.data[o + 3]!;
          // The mesh's run through the alias's rotation, the tip and the turns: a vertical edge's U runs up y.
          const q = pieceTurn(this.quat, rot, instancePlaceOf(rot), g.turnSign);
          if (g.rotation !== 0) q.multiply(this.tip.setFromRotationMatrix(cubeRotationMatrix(g.rotation)));
          const [axis, sign] = runAxisOf(q, g.runAxis, mirror);
          const [offset, factor] = pieceU(g.uPerMetre!, m.cell, local, cellM, axis, sign);
          trim.u.setXY(i, offset, factor);
        });
      }
      g.offsets.forEach((o, i) => {
        const rot = list.data[o + 3]!;
        this.at.set((list.data[o]! + 0.5) * cellM, (list.data[o + 1]! + 0.5) * cellM, (list.data[o + 2]! + 0.5) * cellM);
        const cell0 = [m.cell[0]! + list.data[o]! * k0, m.cell[1]! + list.data[o + 1]! * k0, m.cell[2]! + list.data[o + 2]! * k0];
        mesh.setMatrixAt(i, pieceMatrix(this.matrix, rot, instancePlaceOf(rot), this.at, cellM, cell0, m.level, g));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.userData['voxelPieceDetail'] = g.low ? 'low' : 'high';
      mesh.userData['voxelKitPiece'] = g.kit;
      m.group.add(mesh);
      this.instances += n;
      this.pieceDraws++;
      this.piecesDrawn[g.low ? 'low' : 'high'] += n;
      if (g.kit) this.piecesDrawn.kit += n;
      m.bytes += pieceDrawBytes(mesh);
    }
  }

  private dropPieceMesh(child: THREE.InstancedMesh): void {
    this.instances -= child.count;
    this.pieceDraws--;
    this.piecesDrawn[child.userData['voxelPieceDetail'] === 'low' ? 'low' : 'high'] -= child.count;
    if (child.userData['voxelKitPiece'] === true) this.piecesDrawn.kit -= child.count;
    if (child.userData['voxelTrimGeometry'] === true) disposeInstancedTrimGeometry(child.geometry);
    child.dispose();
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
    if (m.region !== null) this.shading.grids.release(m.region);
    for (const child of m.group.children) {
      const i = this.pickable.indexOf(child);
      if (i >= 0) this.pickable.splice(i, 1);
      if (child instanceof THREE.InstancedMesh) this.dropPieceMesh(child);
      else if (child instanceof THREE.Mesh) {
        this.triangles -= ((child.geometry as THREE.BufferGeometry).index?.count ?? 0) / 3;
        (child.geometry as THREE.BufferGeometry).dispose();
      }
    }
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
    const mesh = new THREE.Mesh(geo, this.shading.material);
    mesh.name = `voxel-seam ${seamId(level, nx, ny, nz, face)}`;
    mesh.matrixAutoUpdate = false;
    const key = chunkKey(this.grid, nx, ny, nz);
    const map = (): Map<number, ChunkDraw> | undefined => this.levels[level];
    // The node's draw is replaced on its own (a new result, a shader change): the seam reads whichever is drawn.
    Object.defineProperty(mesh.userData, VOXEL_SURFACE_KEY, { get: () => map()?.get(key)?.surface ?? NO_SURFACE, enumerable: false });
    this.place(mesh, cell);
    this.root.add(mesh);
    const triangles = (geo.index?.count ?? 0) / 3;
    const bytes = geometryBytes(geo);
    this.seams.set(seamId(level, nx, ny, nz, face), { mesh, cell, level, node: [nx, ny, nz, face], triangles, bytes });
    this.triangles += triangles;
    this.seamTriangles += triangles;
    return bytes;
  }

  removeSeam(level: number, nx: number, ny: number, nz: number, face: number): void {
    const id = seamId(level, nx, ny, nz, face);
    const s = this.seams.get(id);
    if (s === undefined) return;
    this.seams.delete(id);
    this.root.remove(s.mesh);
    s.mesh.geometry.dispose();
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
    if (this.ownsPieces) for (const b of this.pieceMeshes.values()) b?.dispose();
    this.pieceMeshes.clear();
    for (const mt of this.pieceMaterials.values()) mt.dispose();
  }
}

/**
 * A draw's instances copied (a batch's buffers may be reused once applied)
 * with each kit piece's cell material read now, while the draw's shader
 * data is in the view's grid buffer; default pieces get material 0.
 */
function keptInstances(list: InstanceList, materialAt: (x: number, y: number, z: number) => number): { instances: InstanceList; materials: Uint16Array } {
  const data = list.data.slice(0, list.count * INSTANCE_BYTES);
  const materials = new Uint16Array(list.count);
  for (let k = 0; k < list.count; k++) {
    const o = k * INSTANCE_BYTES;
    if (defaultPieceFamily(data[o + 4]! | (data[o + 5]! << 8)) === 0) materials[k] = materialAt(data[o]!, data[o + 1]!, data[o + 2]!);
  }
  return { instances: { count: list.count, data }, materials };
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
}

/**
 * Applies one batch of a world's draws to its view, all in this task: the
 * chunks' and nodes' draws, shader data and removals, then the seams. A
 * change of the levels drawn arrives whole in one batch, so the old level
 * stays drawn until the frame after the new one is complete.
 */
export function applyChunkDrawBatch(view: VoxelChunkView, b: ChunkDrawBatch): VoxelBatchApplied {
  const chunkBytes: number[] = [];
  let replaced = 0;
  for (const c of b.chunks) {
    const level = c.level ?? 0;
    replaced++;
    if (c.kind === 'remove') {
      view.remove(c.cx, c.cy, c.cz, level);
      continue;
    }
    if (c.cells !== undefined) view.cells.set(c.cells);
    const solid = c.solid ?? 0;
    const n = c.kind === 'shader' ? view.setShader(c.cx, c.cy, c.cz, solid, level) : view.set(c.cx, c.cy, c.cz, { ground: c.ground!, base: c.base!, instances: c.instances!, solid }, level);
    if (level === 0) chunkBytes.push(c.cx, c.cy, c.cz, n);
  }
  let seams = 0;
  for (const s of b.seams ?? []) {
    seams++;
    if (s.kind === 'remove') view.removeSeam(s.level, s.nx, s.ny, s.nz, s.face);
    else view.setSeam(s.level, s.nx, s.ny, s.nz, s.face, s.pieces ?? null);
  }
  return { chunkBytes, coarseBytes: view.coarseBytes(), replaced, seams };
}
