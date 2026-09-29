/**
 * Phase 23.5 (E8): drawing block layers — one merged mesh per block look and
 * material per chunk of 16 × 16 columns (a few draw calls per chunk), the
 * faces hidden by neighbours left out (the project-model mesher), each chunk
 * with its own bounds so three.js culls whole chunks outside the view. The
 * Play/export adapter and the editor's Scene view draw layers through this
 * one class, so they look the same.
 *
 * Looks: a variant with a colour is a stand-in shaped like the block's
 * collision shape (a Lambert material per colour, like a box); a model (or a
 * prefab's model) variant draws the model's LOD0 geometry, turned and placed
 * per cell, with its own materials (a material mapping applied by the host).
 * Model geometry arrives asynchronously: chunks re-mesh when it is ready.
 */
import * as THREE from 'three';
import {
  BlockGrid,
  CHUNK_SIZE,
  meshBlockChunk,
  shapeSource,
  type BlockChunk,
  type BlockLayerComponent,
  type BlockLayerData,
  type BlockMeshSource,
  type BlockType,
  type ChunkMeshPart,
  type GridRenderChange,
} from '@thirdlight/runtime';

/** A model look: its LOD0 geometry in the block frame and its materials (by the source's material index). */
export interface BlockModelLook {
  readonly source: BlockMeshSource;
  readonly materials: readonly THREE.Material[];
}

export interface BlockLayerViewDeps {
  /**
   * The geometry of a model (asset, optional piece) — null while it loads
   * (`onReady` is called once when it is ready; the view re-meshes then) or
   * when it cannot be drawn.
   */
  modelLook?(assetId: string, piece: string | undefined, onReady: () => void): BlockModelLook | null;
  /** A prefab's model (its root entity's model), for a prefab variant. */
  prefabModel?(prefabId: string): { assetId: string; piece?: string } | null;
  /** Apply a block type's material mapping to a chunk mesh of a model look (the host's material library). */
  applyMaterials?(mesh: THREE.Mesh, type: BlockType, assetId: string): void;
}

interface LayerState {
  readonly group: THREE.Group;
  component: BlockLayerComponent;
  grid: BlockGrid;
  readonly chunks: Map<string, THREE.Group>;
  readonly dirty: Set<string>;
}

export interface BlockLayerViewDiagnostics {
  layers: number;
  chunks: number;
  meshes: number;
  triangles: number;
}

/** A model's LOD0 meshes merged into one block look (positions in the model root's frame). */
export function blockLookFromObject(root: THREE.Object3D): BlockModelLook | null {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D): void => {
    if ((o as THREE.LOD).isLOD === true) {
      const first = (o as THREE.LOD).levels[0]?.object;
      if (first !== undefined) visit(first);
      return;
    }
    if ((o as THREE.Mesh).isMesh === true && (o as THREE.SkinnedMesh).isSkinnedMesh !== true) meshes.push(o as THREE.Mesh);
    for (const c of o.children) visit(c);
  };
  visit(root);
  if (meshes.length === 0) return null;
  const materials: THREE.Material[] = [];
  const matIndex = new Map<THREE.Material, number>();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const byMaterial = new Map<number, number[]>();
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    if (pos === undefined) continue;
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    m.multiplyMatrices(inv, mesh.matrixWorld);
    nm.getNormalMatrix(m);
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      positions.push(v.x, v.y, v.z);
      if (nor !== undefined) {
        v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        normals.push(v.x, v.y, v.z);
      } else normals.push(0, 1, 0);
      if (uv !== undefined) uvs.push(uv.getX(i), uv.getY(i));
      else uvs.push(0, 0);
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const index = g.getIndex();
    const indexAt = (i: number): number => (index !== null ? index.getX(i) : i);
    const count = index !== null ? index.count : pos.count;
    const groups = g.groups.length > 0 ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0] ?? mats[0]!;
      let mi = matIndex.get(mat);
      if (mi === undefined) {
        mi = materials.length;
        matIndex.set(mat, mi);
        materials.push(mat);
      }
      let list = byMaterial.get(mi);
      if (list === undefined) byMaterial.set(mi, (list = []));
      for (let i = grp.start; i < Math.min(grp.start + grp.count, count); i++) list.push(base + indexAt(i));
    }
  }
  const indices: number[] = [];
  const groups: BlockMeshSource['groups'] = [];
  for (const [material, list] of [...byMaterial.entries()].sort(([a], [b]) => a - b)) {
    groups.push({ start: indices.length, count: list.length, material });
    indices.push(...list);
  }
  return { source: { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), groups }, materials };
}

export class BlockLayerView {
  readonly root = new THREE.Group();
  private readonly deps: BlockLayerViewDeps;
  private types = new Map<string, BlockType>();
  private readonly layers = new Map<string, LayerState>();
  private readonly standIns = new Map<string, BlockMeshSource>();
  private readonly colorMaterials = new Map<string, THREE.MeshLambertMaterial>();
  private disposed = false;

  constructor(deps: BlockLayerViewDeps = {}) {
    this.deps = deps;
    this.root.name = 'block-layers';
  }

  /** The block types (every chunk re-meshes when they change). */
  setTypes(types: readonly BlockType[]): void {
    const next = new Map(types.map((t) => [t.blockId, t]));
    if (JSON.stringify([...next.entries()]) === JSON.stringify([...this.types.entries()])) return;
    this.types = next;
    for (const layer of this.layers.values()) for (const ck of layer.grid.chunkKeys()) layer.dirty.add(ck);
    for (const layer of this.layers.values()) for (const ck of layer.chunks.keys()) layer.dirty.add(ck);
  }

  /** Show (or replace) a layer: its component, origin and stored cells. */
  setLayer(entityId: string, component: BlockLayerComponent, origin: readonly number[], data: BlockLayerData | null): void {
    let layer = this.layers.get(entityId);
    if (layer === undefined) {
      const group = new THREE.Group();
      group.name = `block-layer:${entityId}`;
      this.root.add(group);
      layer = { group, component, grid: BlockGrid.from(component, data), chunks: new Map(), dirty: new Set() };
      this.layers.set(entityId, layer);
    } else {
      layer.component = component;
      layer.grid = BlockGrid.from(component, data);
    }
    layer.group.position.set(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
    layer.group.updateMatrixWorld(true);
    for (const ck of layer.grid.chunkKeys()) layer.dirty.add(ck);
    for (const ck of layer.chunks.keys()) layer.dirty.add(ck);
  }

  /** Move a layer (its entity moved in the editor). */
  setOrigin(entityId: string, origin: readonly number[]): void {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return;
    layer.group.position.set(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
    layer.group.updateMatrixWorld(true);
  }

  hasLayer(entityId: string): boolean {
    return this.layers.has(entityId);
  }

  layerIds(): string[] {
    return [...this.layers.keys()];
  }

  /** Replace some chunks of a layer (stored form; null empties one) and re-mesh them and their neighbours. */
  replaceChunks(entityId: string, chunks: readonly { cx: number; cz: number; chunk: BlockChunk | null }[]): void {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return;
    for (const c of chunks) layer.grid.replaceChunk(c.cx, c.cz, c.chunk);
    for (const k of layer.grid.takeDirty().mesh) layer.dirty.add(k);
  }

  /** The simulation's chunk changes (the runtime's `takeGridChanges`). */
  applyRuntimeChanges(changes: readonly GridRenderChange[]): void {
    const byLayer = new Map<string, { cx: number; cz: number; chunk: BlockChunk | null }[]>();
    for (const c of changes) {
      let list = byLayer.get(c.entityId);
      if (list === undefined) byLayer.set(c.entityId, (list = []));
      list.push(c);
    }
    for (const [id, list] of byLayer) this.replaceChunks(id, list);
  }

  removeLayer(entityId: string): void {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return;
    for (const g of layer.chunks.values()) this.disposeChunk(g);
    layer.group.removeFromParent();
    this.layers.delete(entityId);
  }

  /** Re-mesh the chunks that changed. Returns whether anything was rebuilt. */
  update(): boolean {
    if (this.disposed) return false;
    let changed = false;
    for (const [entityId, layer] of this.layers) {
      if (layer.dirty.size === 0) continue;
      const keys = [...layer.dirty];
      layer.dirty.clear();
      for (const ck of keys) {
        this.rebuildChunk(entityId, layer, ck);
        changed = true;
      }
    }
    return changed;
  }

  diagnostics(): BlockLayerViewDiagnostics {
    let chunks = 0;
    let meshes = 0;
    let triangles = 0;
    for (const layer of this.layers.values()) {
      chunks += layer.chunks.size;
      for (const g of layer.chunks.values()) {
        for (const c of g.children) {
          const mesh = c as THREE.Mesh;
          meshes += 1;
          const index = (mesh.geometry as THREE.BufferGeometry).getIndex();
          triangles += index !== null ? index.count / 3 : 0;
        }
      }
    }
    return { layers: this.layers.size, chunks, meshes, triangles };
  }

  /** One layer's chunk meshes (what a pointer ray hits of it). */
  layerMeshes(entityId: string): THREE.Mesh[] {
    const layer = this.layers.get(entityId);
    const out: THREE.Mesh[] = [];
    if (layer !== undefined) for (const g of layer.chunks.values()) g.traverse((o) => ((o as THREE.Mesh).isMesh === true ? out.push(o as THREE.Mesh) : undefined));
    return out;
  }

  /** The chunk meshes (static geometry) — e.g. occluders for a light bake. */
  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const layer of this.layers.values()) for (const g of layer.chunks.values()) for (const c of g.children) out.push(c as THREE.Mesh);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const m of this.colorMaterials.values()) m.dispose();
    this.colorMaterials.clear();
    this.root.removeFromParent();
  }

  // ---- internals ---------------------------------------------------------------------

  private colorMaterial(color: string): THREE.MeshLambertMaterial {
    let m = this.colorMaterials.get(color);
    if (m === undefined) {
      m = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
      m.name = `block:${color}`;
      this.colorMaterials.set(color, m);
    }
    return m;
  }

  private standIn(type: BlockType, fm: [number, number, number]): BlockMeshSource {
    const key = `${type.shape}|${fm.join(',')}|${JSON.stringify(type.boxes ?? null)}`;
    let s = this.standIns.get(key);
    if (s === undefined) {
      s = shapeSource(type.shape === 'none' ? 'full' : type.shape, fm[0], fm[1], fm[2], type.boxes);
      this.standIns.set(key, s);
    }
    return s;
  }

  private modelOf(type: BlockType, variant: number): { assetId: string; piece?: string } | null {
    const v = type.variants[variant] ?? type.variants[0];
    if (v === undefined) return null;
    if (v.model !== undefined) return v.model;
    if (v.prefab !== undefined) return this.deps.prefabModel?.(v.prefab) ?? null;
    return null;
  }

  private rebuildChunk(entityId: string, layer: LayerState, ck: string): void {
    const old = layer.chunks.get(ck);
    if (old !== undefined) {
      this.disposeChunk(old);
      layer.chunks.delete(ck);
    }
    if (layer.component.metadataOnly === true) return;
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    const looks = new Map<string, { materials: readonly THREE.Material[]; type: BlockType; assetId: string | null; color: string | null }>();
    const parts: ChunkMeshPart[] = meshBlockChunk(layer.grid, cx, cz, this.types, {
      source: (type, variant, fm) => {
        const model = this.modelOf(type, variant);
        if (model !== null) {
          const look = this.deps.modelLook?.(model.assetId, model.piece, () => {
            if (this.disposed) return;
            const l = this.layers.get(entityId);
            if (l === undefined) return;
            for (const k of l.grid.chunkKeys()) l.dirty.add(k);
          });
          if (look === null || look === undefined) return null;
          const key = `m:${model.assetId}:${model.piece ?? ''}:${type.blockId}`;
          looks.set(key, { materials: look.materials, type, assetId: model.assetId, color: null });
          return { key, source: look.source };
        }
        const color = type.variants[variant]?.color ?? type.variants[0]?.color ?? '#b0b0b0';
        const key = `c:${type.blockId}:${variant}`;
        looks.set(key, { materials: [], type, assetId: null, color });
        return { key, source: this.standIn(type, fm) };
      },
    });
    if (parts.length === 0) return;
    const group = new THREE.Group();
    group.name = `block-chunk:${entityId}:${ck}`;
    for (const p of parts) {
      const lookKey = p.key.slice(0, p.key.lastIndexOf('#'));
      const look = looks.get(lookKey);
      if (look === undefined) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(p.indices, 1));
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      const material = look.color !== null ? this.colorMaterial(look.color) : (look.materials[p.material] ?? look.materials[0] ?? this.colorMaterial('#b0b0b0'));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `block:${p.key}`;
      mesh.castShadow = layer.component.castShadow !== false;
      mesh.receiveShadow = layer.component.receiveShadow !== false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (look.assetId !== null) this.deps.applyMaterials?.(mesh, look.type, look.assetId);
      group.add(mesh);
    }
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    layer.group.add(group);
    group.updateMatrixWorld(true);
    layer.chunks.set(ck, group);
  }

  private disposeChunk(group: THREE.Group): void {
    for (const c of group.children) (c as THREE.Mesh).geometry.dispose();
    group.removeFromParent();
  }
}

/** The chunk key of a cell column (for callers mapping cells to chunks). */
export const blockChunkKey = (x: number, z: number): string => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
