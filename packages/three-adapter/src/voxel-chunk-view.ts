/**
 * The voxel world's draws: one object a 32³ storage chunk, built from the
 * chunk's joined derive sections (the streamer's `joinedChunk`), so the
 * object count, and with it the render CPU and the work a swap does on the
 * main thread, follows the chunk count however small the derive sections
 * are. Play, an exported game and the editor draw through this one view.
 *
 * A chunk is one mesh holding its ground and its modular base surfaces (the
 * same material, so one draw), plus stand-in boxes for the detail instances
 * the assembly rules resolved (beams, rails, posts), one instanced mesh a
 * piece family. The surface buffers' packed vertices are unpacked to float
 * attributes here (positions in metres from the chunk's corner, normals).
 * They carry no material: the voxel surface shader blends the materials it
 * finds in the chunk's shader grid, uploaded as the join wrote its entries
 * (no palette packed only to be expanded again), on its own when only the
 * shader data changed, so such an edit rebuilds no mesh.
 *
 * Chunks are placed relative to the floating origin from their integer
 * cell; after a re-base every chunk is placed again. Objects keep their
 * matrices until placed (no per-frame matrix work for a still world). The
 * surface and the pieces draw with a camera-relative model-view made in 64
 * bits (camera-relative.ts), so a view whose origin is never moved (a game
 * view kilometres out) draws as exactly as one kept near its origin.
 *
 * A swap's chunks are replaced in the task that announces them (the
 * streamer emits every `chunk` event of a swap in one task, just before the
 * swap), so all of them change between the same two frames.
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
  MESH_PART,
  PIECE_FAMILY,
  POSITION_STEPS_PER_CELL,
  SampleRing,
  SURFACE_VERTEX_BYTES,
  VOXEL_SIZE_M,
  type ChunkGrid,
  type FloatingOrigin,
  type JoinedDraw,
  type StreamEvent,
  type SurfaceBuffer,
  type JoinTimes,
} from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
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

/**
 * Surface buffers as one float geometry (null when they hold no triangle):
 * the buffers' vertices one after another, indices offset to match.
 */
export function voxelSurfaceGeometry(bufs: readonly SurfaceBuffer[]): THREE.BufferGeometry | null {
  let n = 0;
  let indexCount = 0;
  for (const b of bufs) {
    if (b.indices.length === 0) continue;
    n += b.vertexCount;
    indexCount += b.indices.length;
  }
  if (n === 0 || indexCount === 0) return null;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const index = n < 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  const toM = VOXEL_SIZE_M / POSITION_STEPS_PER_CELL;
  let v0 = 0;
  let i0 = 0;
  for (const b of bufs) {
    if (b.indices.length === 0) continue;
    const view = new DataView(b.vertices.buffer, b.vertices.byteOffset, b.vertices.byteLength);
    for (let i = 0; i < b.vertexCount; i++) {
      const o = i * SURFACE_VERTEX_BYTES;
      const at = (v0 + i) * 3;
      // Positions count from one cell below the chunk's corner.
      for (let a = 0; a < 3; a++) {
        pos[at + a] = view.getUint16(o + a * 2, true) * toM - VOXEL_SIZE_M;
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

/** What a chunk's draw is made of: its joined sections' surfaces, pieces and shader grid (a join, or a batch's copy of one). */
export type VoxelChunkDraw = Pick<JoinedDraw, 'ground' | 'base' | 'instances' | 'solid'>;

interface ChunkDraw {
  readonly group: THREE.Group;
  readonly cell: readonly [number, number, number];
  bytes: number;
  /** What the chunk's surface passes the shader. */
  readonly surface: VoxelSurfaceObject;
  /** The chunk's grid region (null: none, its one solid entry is passed instead). */
  region: THREE.Vector3 | null;
}

export interface VoxelChunkViewOptions {
  /** The storage chunks' grid (32³). */
  readonly grid: ChunkGrid;
  readonly origin: FloatingOrigin;
  /** The surface material and its grid store (a grid side of the chunk's: edge + 2 · border). */
  readonly surface: VoxelSurface;
  readonly renderer: VoxelGridRenderer;
}

/** Every drawn chunk of a voxel world, in one scene group. */
export class VoxelChunkView {
  readonly root = new THREE.Group();
  /** The surfaces raycasts hit (picking a cell to edit). */
  readonly pickable: THREE.Object3D[] = [];
  /** A join writes a chunk's shader grid entries here; the upload reads them. */
  readonly cells: Uint16Array;
  private readonly chunks = new Map<number, ChunkDraw>();
  private readonly pieceMaterials = new Map<number, MeshLambertNodeMaterial>();
  private readonly pieceBoxes = new Map<number, THREE.BoxGeometry>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly at = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly grid: ChunkGrid;
  private readonly origin: FloatingOrigin;
  private readonly shading: VoxelSurface;
  private readonly renderer: VoxelGridRenderer;
  triangles = 0;
  instances = 0;
  /** Chunks whose meshes were built, and shader grids uploaded or set (one solid entry). */
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
  }

  /** Chunks drawing with a grid region. */
  get regions(): number {
    return this.shading.grids.count;
  }

  /** Chunks drawn. */
  get count(): number {
    return this.chunks.size;
  }

  /** Whether a chunk is drawn. */
  has(cx: number, cy: number, cz: number): boolean {
    return this.chunks.has(chunkKey(this.grid, cx, cy, cz));
  }

  private place(m: ChunkDraw): void {
    const o = this.origin.origin;
    m.group.position.set((m.cell[0] - o.x) * VOXEL_SIZE_M, (m.cell[1] - o.y) * VOXEL_SIZE_M, (m.cell[2] - o.z) * VOXEL_SIZE_M);
    // Still chunks keep their matrices (no per-frame matrix work): made here, when set and after a re-base.
    m.group.updateMatrix();
  }

  /** After a floating-origin re-base: every chunk's 32-bit position again, from its integer cell. */
  rebase(): void {
    for (const m of this.chunks.values()) this.place(m);
  }

  /**
   * Replaces a chunk's draw with its joined sections' (null: nothing to
   * draw, the chunk is removed); the shader grid's entries are read from
   * {@link cells} when the draw has no solid entry. Returns the bytes the
   * chunk holds (meshes and grid).
   */
  set(cx: number, cy: number, cz: number, d: VoxelChunkDraw | null): number {
    this.remove(cx, cy, cz);
    if (d === null) return 0;
    const key = chunkKey(this.grid, cx, cy, cz);
    this.meshBuilds++;
    const group = new THREE.Group();
    group.name = `voxel-chunk ${cx},${cy},${cz}`;
    group.matrixAutoUpdate = false;
    let bytes = 0;
    const surface = this.shading.objectValues();
    const cell: [number, number, number] = [chunkOrigin(this.grid, cx), chunkOrigin(this.grid, cy), chunkOrigin(this.grid, cz)];
    const wrap = (v: number): number => v - Math.floor(v / PHASE_CELLS) * PHASE_CELLS;
    surface.phase.set(wrap(cell[0]), wrap(cell[1]), wrap(cell[2]));
    const geo = voxelSurfaceGeometry([d.ground, d.base]);
    if (geo !== null) {
      const mesh = new THREE.Mesh(geo, this.shading.material);
      mesh.matrixAutoUpdate = false;
      mesh.userData['voxelChunk'] = key;
      mesh.userData[VOXEL_SURFACE_KEY] = surface;
      group.add(mesh);
      this.pickable.push(mesh);
      bytes += geometryBytes(geo);
      this.triangles += (geo.index?.count ?? 0) / 3;
    }
    bytes += this.addPieces(group, d);
    if (group.children.length === 0) return 0;
    const m: ChunkDraw = { group, cell, bytes, surface, region: null };
    this.place(m);
    this.root.add(group);
    this.chunks.set(key, m);
    this.applyShader(m, d.solid);
    return m.bytes;
  }

  /**
   * Gives a drawn chunk's surface its new shader data (a material or
   * wetness change): its grid region uploaded again from {@link cells}, or
   * its one solid entry passed; no mesh is touched. Returns the chunk's
   * bytes now (0: not drawn).
   */
  setShader(cx: number, cy: number, cz: number, solid: number): number {
    const m = this.chunks.get(chunkKey(this.grid, cx, cy, cz));
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

  private addPieces(group: THREE.Group, d: VoxelChunkDraw): number {
    const list = d.instances;
    if (list.count === 0) return 0;
    const byFamily = new Map<number, number[]>();
    for (let k = 0; k < list.count; k++) {
      const o = k * INSTANCE_BYTES;
      const family = (list.data[o + 4]! | (list.data[o + 5]! << 8)) >> 2;
      let l = byFamily.get(family);
      if (l === undefined) byFamily.set(family, (l = []));
      l.push(o);
    }
    let bytes = 0;
    for (const [family, offsets] of byFamily) {
      const size = PIECE_SIZE[family];
      if (size === undefined) continue;
      let box = this.pieceBoxes.get(family);
      if (box === undefined) this.pieceBoxes.set(family, (box = new THREE.BoxGeometry(size[0], size[1], size[2])));
      let mat = this.pieceMaterials.get(family);
      if (mat === undefined) this.pieceMaterials.set(family, (mat = cameraRelative(new MeshLambertNodeMaterial({ color: PIECE_COLOUR[family] ?? 0x888888 }))));
      const mesh = new THREE.InstancedMesh(box, mat, offsets.length);
      mesh.matrixAutoUpdate = false;
      offsets.forEach((o, i) => {
        // Quarter turns about +y turn the piece's run (its x) to the cell's run axis.
        this.quat.setFromAxisAngle(this.up, ((list.data[o + 3]! & 3) * Math.PI) / 2);
        this.at.set((list.data[o]! + 0.5) * VOXEL_SIZE_M, (list.data[o + 1]! + 0.5) * VOXEL_SIZE_M, (list.data[o + 2]! + 0.5) * VOXEL_SIZE_M);
        mesh.setMatrixAt(i, this.matrix.compose(this.at, this.quat, this.one));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      this.instances += offsets.length;
      bytes += offsets.length * 64;
    }
    return bytes;
  }

  /** Stops drawing a chunk (unloaded, or nothing left to draw). */
  remove(cx: number, cy: number, cz: number): void {
    this.removeKey(chunkKey(this.grid, cx, cy, cz));
  }

  private removeKey(key: number): void {
    const m = this.chunks.get(key);
    if (m === undefined) return;
    this.chunks.delete(key);
    this.root.remove(m.group);
    if (m.region !== null) this.shading.grids.release(m.region);
    for (const child of m.group.children) {
      const i = this.pickable.indexOf(child);
      if (i >= 0) this.pickable.splice(i, 1);
      if (child instanceof THREE.InstancedMesh) {
        this.instances -= child.count;
        child.dispose();
      } else if (child instanceof THREE.Mesh) {
        this.triangles -= ((child.geometry as THREE.BufferGeometry).index?.count ?? 0) / 3;
        (child.geometry as THREE.BufferGeometry).dispose();
      }
    }
  }

  /** Removes every chunk; the piece boxes and materials are disposed (the surface is its owner's). */
  dispose(): void {
    for (const key of [...this.chunks.keys()]) this.removeKey(key);
    for (const b of this.pieceBoxes.values()) b.dispose();
    for (const mt of this.pieceMaterials.values()) mt.dispose();
  }
}

/** What the chunk view needs of a voxel streamer (its events, the joins, and the budget's parts). */
export interface VoxelChunkFeed {
  on(listener: (e: StreamEvent) => void): void;
  /** The chunk's sections joined, the shader grid's entries written into `cells` (the streamer's `joinedChunk` given cells). */
  joinedChunk(cx: number, cy: number, cz: number, times: JoinTimes | undefined, cells: Uint16Array): JoinedDraw | null;
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean;
}

/** A chunk the view replaced: its coordinates, whether only its shader data changed, and the main-thread ms it took (join included). */
export interface VoxelChunkReplaced {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly shaderOnly: boolean;
  readonly ms: number;
  /** The chunk's joined sections the draw was made from (null: nothing derived), for what else is built per chunk with it (its collision). */
  readonly joined: JoinedDraw | null;
}

/**
 * Draws a streamer's world through a chunk view: each `chunk` event joins
 * the chunk's sections and replaces its draw (its grid alone when only
 * shader data changed), an unloaded chunk is removed, and the chunk's
 * draw bytes are counted as its `mesh` part of the stream budget.
 */
export function feedVoxelChunkView(view: VoxelChunkView, feed: VoxelChunkFeed, onReplaced?: (r: VoxelChunkReplaced) => void): void {
  feed.on((e) => {
    if (e.type === 'unloaded') {
      view.remove(e.cx, e.cy, e.cz);
      return;
    }
    if (e.type !== 'chunk') return;
    const t0 = performance.now();
    const d = feed.joinedChunk(e.cx, e.cy, e.cz, undefined, view.cells);
    const shaderOnly = e.shaderOnly && d !== null && view.has(e.cx, e.cy, e.cz);
    const bytes = shaderOnly ? view.setShader(e.cx, e.cy, e.cz, d.solid) : view.set(e.cx, e.cy, e.cz, d);
    feed.setPart(e.cx, e.cy, e.cz, MESH_PART, bytes);
    onReplaced?.({ cx: e.cx, cy: e.cy, cz: e.cz, shaderOnly, ms: performance.now() - t0, joined: d });
  });
}
