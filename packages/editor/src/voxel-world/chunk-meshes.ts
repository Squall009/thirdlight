/**
 * Three meshes for derived voxel chunks: the projected ground and the
 * modular base surfaces from their surface buffers, and stand-in boxes for
 * the detail instances the assembly evaluation resolved (beams, rails,
 * posts). One group per chunk, placed relative to the floating origin;
 * rebuilt whole when the chunk's derived result changes.
 *
 * The surface buffers' packed vertices are unpacked to float attributes
 * here (positions in metres from the chunk's corner, normals). They carry
 * no material: the surface shader (three-adapter's voxel surface) blends
 * the materials it finds in the chunk's shader grid, which is uploaded on
 * its own when only the shader data changes (a material or wetness edit),
 * so such an edit rebuilds no mesh. Colours and patterns are stand-ins
 * picked by material id: materials, kits and detail art come later.
 */
import * as THREE from 'three';
import {
  chunkOrigin,
  INSTANCE_BYTES,
  PIECE_FAMILY,
  POSITION_STEPS_PER_CELL,
  SampleRing,
  shaderGridEntries,
  shaderSolidEntry,
  SURFACE_VERTEX_BYTES,
  VOXEL_SIZE_M,
  type CellGrid,
  type DerivedData,
  type FloatingOrigin,
  type ShaderOut,
  type SurfaceBuffer,
} from '@thirdlight/voxel';
import { PHASE_CELLS, VOXEL_PATTERNS, VOXEL_SURFACE_KEY, type VoxelGridRenderer, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceObject } from '@thirdlight/three-adapter';

/** Stand-in colours, by material id (wrapping): earth, rock and building tones, so neighbouring ids read apart. */
const SWATCHES = [0x8a8f96, 0x7d7f84, 0x7a5a3c, 0x5f8f3e, 0xc8b47c, 0x4a78b8, 0x9a958c, 0xb0a48c, 0xa9a39a, 0x8b5a33, 0xd8d0c0, 0x9c4a3a, 0xb08850, 0xa0523c, 0x6d6a5f, 0x8c7a6b];

/** A material id's stand-in look: a swatch and a test pattern, both by id. */
export function standInLook(material: number): VoxelMaterialLook {
  return { colour: SWATCHES[material % SWATCHES.length]!, pattern: material % VOXEL_PATTERNS };
}

/** Stand-in piece sizes (metres: along the run, up, across) by family. */
const PIECE_SIZE: Record<number, readonly [number, number, number]> = {
  [PIECE_FAMILY.beam]: [VOXEL_SIZE_M, 0.3, 0.3],
  [PIECE_FAMILY.rail]: [VOXEL_SIZE_M, 0.12, 0.14],
  [PIECE_FAMILY.post]: [0.12, VOXEL_SIZE_M, 0.12],
};
const PIECE_COLOUR: Record<number, number> = { [PIECE_FAMILY.beam]: 0x6b4423, [PIECE_FAMILY.rail]: 0x8a5a2b, [PIECE_FAMILY.post]: 0x7a4e25 };

/** A surface buffer as a float geometry (null when it holds no triangle). */
export function surfaceGeometry(buf: SurfaceBuffer): THREE.BufferGeometry | null {
  if (buf.vertexCount === 0 || buf.indices.length === 0) return null;
  const stride = SURFACE_VERTEX_BYTES;
  const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
  const n = buf.vertexCount;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const toM = VOXEL_SIZE_M / POSITION_STEPS_PER_CELL;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    // Positions count from one cell below the chunk's corner.
    for (let a = 0; a < 3; a++) {
      pos[i * 3 + a] = view.getUint16(o + a * 2, true) * toM - VOXEL_SIZE_M;
      nor[i * 3 + a] = Math.max(-1, view.getInt8(o + 8 + a) / 127);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(buf.indices.slice(), 1));
  geo.computeBoundingSphere();
  return geo;
}

/** Bytes a geometry holds on the GPU (its attributes and index). */
function geometryBytes(geo: THREE.BufferGeometry): number {
  let n = geo.index?.array.byteLength ?? 0;
  for (const a of Object.values(geo.attributes)) n += (a as THREE.BufferAttribute).array.byteLength;
  return n;
}

interface ChunkMesh {
  readonly group: THREE.Group;
  readonly cell: readonly [number, number, number];
  bytes: number;
  /** What the chunk's surface objects pass the shader (shared by them). */
  readonly surface: VoxelSurfaceObject;
  /** The chunk's grid region (null: none, its one solid entry is passed instead). */
  region: THREE.Vector3 | null;
}

/** Every derived chunk's meshes in one scene group. */
export class ChunkMeshes {
  readonly root = new THREE.Group();
  /** The surfaces raycasts hit (picking a cell to edit). */
  readonly pickable: THREE.Object3D[] = [];
  private readonly chunks = new Map<number, ChunkMesh>();
  private entries: Uint16Array = new Uint16Array(0);
  private readonly pieceMaterials = new Map<number, THREE.MeshLambertMaterial>();
  private readonly pieceBoxes = new Map<number, THREE.BoxGeometry>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly at = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  triangles = 0;
  instances = 0;
  /** Chunks whose meshes were built, and shader grids uploaded or set (one solid entry). */
  meshBuilds = 0;
  shaderSets = 0;
  /** ms to expand and upload one grid. */
  readonly uploadMs = new SampleRing();

  constructor(
    private readonly grid: CellGrid,
    private readonly origin: FloatingOrigin,
    private readonly shading: VoxelSurface,
    private readonly renderer: VoxelGridRenderer,
  ) {}

  /** Chunks drawing with a grid region. */
  get regions(): number {
    return this.shading.grids.count;
  }

  get count(): number {
    return this.chunks.size;
  }

  private place(m: ChunkMesh): void {
    const o = this.origin.origin;
    m.group.position.set((m.cell[0] - o.x) * VOXEL_SIZE_M, (m.cell[1] - o.y) * VOXEL_SIZE_M, (m.cell[2] - o.z) * VOXEL_SIZE_M);
  }

  /** After a floating-origin re-base: every chunk's 32-bit position again, from its integer cell. */
  rebase(): void {
    for (const m of this.chunks.values()) this.place(m);
  }

  /**
   * Replaces a chunk's meshes with its derived result's and gives the
   * surface its shader data; returns the bytes they hold (meshes and grid).
   */
  set(key: number, cx: number, cy: number, cz: number, d: DerivedData | null): number {
    this.remove(key);
    if (d === null) return 0;
    this.meshBuilds++;
    const group = new THREE.Group();
    group.name = `voxel-chunk ${cx},${cy},${cz}`;
    let bytes = 0;
    const surface = this.shading.objectValues();
    const cell: [number, number, number] = [chunkOrigin(this.grid, cx), chunkOrigin(this.grid, cy), chunkOrigin(this.grid, cz)];
    const wrap = (v: number): number => v - Math.floor(v / PHASE_CELLS) * PHASE_CELLS;
    surface.phase.set(wrap(cell[0]), wrap(cell[1]), wrap(cell[2]));
    for (const buf of [d.ground, d.base]) {
      const geo = surfaceGeometry(buf);
      if (geo === null) continue;
      const mesh = new THREE.Mesh(geo, this.shading.material);
      mesh.userData['voxelChunk'] = key;
      mesh.userData[VOXEL_SURFACE_KEY] = surface;
      group.add(mesh);
      this.pickable.push(mesh);
      bytes += geometryBytes(geo);
      this.triangles += (geo.index?.count ?? 0) / 3;
    }
    bytes += this.addPieces(group, d);
    if (group.children.length === 0) return 0;
    const m: ChunkMesh = { group, cell, bytes, surface, region: null };
    this.place(m);
    this.root.add(group);
    this.chunks.set(key, m);
    this.applyShader(m, d.shader);
    return m.bytes;
  }

  /**
   * Gives a drawn chunk's surface its new shader data (a material or
   * wetness change): its grid region uploaded again, or its one solid
   * entry passed; no mesh is touched. Returns the chunk's bytes now (0: not
   * drawn).
   */
  setShader(key: number, shader: ShaderOut): number {
    const m = this.chunks.get(key);
    if (m === undefined) return 0;
    this.applyShader(m, shader);
    return m.bytes;
  }

  private applyShader(m: ChunkMesh, shader: ShaderOut): void {
    this.shaderSets++;
    const grids = this.shading.grids;
    const solid = shaderSolidEntry(shader);
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
    const cells = shader.side ** 3;
    if (this.entries.length < cells) this.entries = new Uint16Array(cells);
    grids.upload(this.renderer, m.region, shaderGridEntries(shader, this.entries));
    m.surface.slot.set(m.region.x, m.region.y, m.region.z, -1);
    this.uploadMs.add(performance.now() - t0);
  }

  private addPieces(group: THREE.Group, d: DerivedData): number {
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
      if (mat === undefined) this.pieceMaterials.set(family, (mat = new THREE.MeshLambertMaterial({ color: PIECE_COLOUR[family] ?? 0x888888 })));
      const mesh = new THREE.InstancedMesh(box, mat, offsets.length);
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

  remove(key: number): void {
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
}
