/**
 * Drawing block layers — one merged mesh per block look and
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
 *
 * Levels of detail: when a model look has coarser levels (`<piece>_LOD1..n`),
 * the chunk is meshed once per level and its model meshes go into one
 * `THREE.LOD` at the chunk's centre (each level shows every model at that
 * level, or its last), switching at the farthest of those models' own
 * distances plus the chunk's radius; stand-ins stay at full detail.
 *
 * Materials: a block type's material mapping (`materials`: a source material
 * name or "*" → a project material) applies to model looks and
 * to stand-ins too ("*": a stand-in has one material) — a painted terrain
 * material on plain sloped blocks.
 *
 * Tops: a layer's crease angle and top subdivision (`smoothAngle`,
 * `topSubdivision`) go to the mesher, so every level of detail is smoothed
 * and cut the same way; a change of either re-meshes the layer (it is a
 * component change).
 *
 * Paint: the chunks of a painted layer carry its paint as vertex
 * colours — COLOR_0 the four layer weights, COLOR_1.r the wetness
 * (`chunkPaintColors`) — unless their material draws vertex colours as a tint.
 *
 * Baked lighting: the chunks of a layer a bake covers get lightmap UVs (one
 * square layout per chunk, `chunkLightmapLayout`), and the host puts each
 * chunk's lightmap on when the chunk's layout is the one the bake was made
 * for (a chunk changed since is drawn without it).
 */
import * as THREE from 'three';
import {
  BlockGrid,
  CHUNK_SIZE,
  blockTopOptions,
  chunkLightmapLayout,
  chunkPaintColors,
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

import { currentLodLevel } from './lod-switch';

/** A model look: its LOD0 geometry in the block frame and its materials (by the source's material index). */
export interface BlockModelLook {
  readonly source: BlockMeshSource;
  readonly materials: readonly THREE.Material[];
  /**
   * The model's coarser levels (`<piece>_LOD1..n`), each with the camera
   * distance it takes over at (the model's own switch distance); absent or
   * empty: one level. Their sources index the same `materials`.
   */
  readonly levels?: readonly { readonly source: BlockMeshSource; readonly distance: number }[];
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
  /** Apply a block type's material mapping to a chunk mesh of a model look or (assetId null) a stand-in (the host's material library). */
  applyMaterials?(mesh: THREE.Mesh, type: BlockType, assetId: string | null): void;
  /** Whether a layer's chunks get lightmap UVs (a bake has lightmaps for them). */
  lightmapped?(entityId: string): boolean;
  /** A chunk was (re)built with lightmap UVs: its group and its layout digest (the host puts the lightmap on). */
  chunkBuilt?(entityId: string, cx: number, cz: number, group: THREE.Group, layout: string): void;
  /** A chunk with lightmap UVs goes away (rebuilt or removed). */
  chunkDropped?(entityId: string, cx: number, cz: number): void;
  /**
   * A chunk was built (`shown`) or is going: a host that draws a flat scene
   * lists its drawables (the chunk's children, world matrices current) itself
   * and leaves {@link BlockLayerView.root} out of its scene.
   */
  place?(chunk: THREE.Group, shown: boolean): void;
}

/** A chunk's lightmap target: its meshes with UV1 and the layout they follow. */
export interface BlockChunkLightmapTarget {
  cx: number;
  cz: number;
  layout: string;
  /** Surface area in square metres. */
  area: number;
  /** Slots per side of the chunk's square layout (one slot per cell face direction). */
  side: number;
  /** The meshes at full detail (what a bake renders). */
  meshes: THREE.Mesh[];
  /** The meshes of coarser levels of detail (they read the same lightmap). */
  coarse: THREE.Mesh[];
}

interface LayerState {
  readonly group: THREE.Group;
  component: BlockLayerComponent;
  grid: BlockGrid;
  readonly chunks: Map<string, THREE.Group>;
  readonly dirty: Set<string>;
  /** Chunks built with lightmap UVs: their layout digest, area and slots per side. */
  readonly lightmapLayouts: Map<string, { layout: string; area: number; side: number }>;
}

export interface BlockLayerViewDiagnostics {
  layers: number;
  chunks: number;
  /** Meshes and triangles at full detail. */
  meshes: number;
  triangles: number;
  /** Chunks with levels of detail, and how many show each level now (index = level). */
  lods?: { chunks: number; shown: number[] };
}

/**
 * A model's meshes merged into one block look (positions in the model root's
 * frame): its most detailed level, and each coarser level of its LOD groups
 * (a group with fewer levels keeps its last one; meshes outside any group are
 * in every level) with the farthest switch distance of the groups at that
 * level.
 */
export function blockLookFromObject(root: THREE.Object3D): BlockModelLook | null {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const lods: THREE.LOD[] = [];
  const meshesAt = (level: number): THREE.Mesh[] => {
    const meshes: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D): void => {
      if ((o as THREE.LOD).isLOD === true) {
        const lod = o as THREE.LOD;
        if (level === 0 && lod.levels.length > 1) lods.push(lod);
        const pick = lod.levels[Math.min(level, lod.levels.length - 1)]?.object;
        if (pick !== undefined) visit(pick);
        return;
      }
      if ((o as THREE.Mesh).isMesh === true && (o as THREE.SkinnedMesh).isSkinnedMesh !== true) meshes.push(o as THREE.Mesh);
      for (const c of o.children) visit(c);
    };
    visit(root);
    return meshes;
  };
  const first = meshesAt(0);
  if (first.length === 0) return null;
  const count = Math.max(1, ...lods.map((l) => l.levels.length));
  const materials: THREE.Material[] = [];
  const matIndex = new Map<THREE.Material, number>();
  const sources: BlockMeshSource[] = [mergeMeshes(first, inv, materials, matIndex)];
  const levels: { source: BlockMeshSource; distance: number }[] = [];
  for (let level = 1; level < count; level++) {
    const distance = Math.max(...lods.filter((l) => l.levels.length > level).map((l) => l.levels[level]!.distance));
    const source = mergeMeshes(meshesAt(level), inv, materials, matIndex);
    sources.push(source);
    levels.push({ source, distance });
  }
  return { source: sources[0]!, materials, ...(levels.length > 0 ? { levels } : {}) };
}

/** Merge meshes into one indexed source in `inv`'s frame, grouped by material (indices into `materials`, shared across calls). */
function mergeMeshes(meshes: readonly THREE.Mesh[], inv: THREE.Matrix4, materials: THREE.Material[], matIndex: Map<THREE.Material, number>): BlockMeshSource {
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
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), groups };
}

/** Marks a chunk mesh of a coarser level of detail (its level): bakes, picks and counts use the detailed ones. */
const COARSE_LEVEL = 'tlBlockLodLevel';

/** A chunk's meshes at full detail (the always-drawn ones and its detailed level). */
function detailedMeshes(group: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh === true && m.userData[COARSE_LEVEL] === undefined) out.push(m);
  });
  return out;
}

export class BlockLayerView {
  readonly root = new THREE.Group();
  private readonly deps: BlockLayerViewDeps;
  private types = new Map<string, BlockType>();
  private readonly layers = new Map<string, LayerState>();
  private readonly standIns = new Map<string, BlockMeshSource>();
  private readonly colorMaterials = new Map<string, THREE.MeshLambertMaterial>();
  /** Layers whose chunks get lightmap UVs whatever the host says (a bake in progress). */
  private readonly forcedUv = new Set<string>();
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
      layer = { group, component, grid: BlockGrid.from(component, data), chunks: new Map(), dirty: new Set(), lightmapLayouts: new Map() };
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
    const painted = layer.grid.hasPaint();
    for (const c of chunks) layer.grid.replaceChunk(c.cx, c.cz, c.chunk);
    for (const k of layer.grid.takeDirty().mesh) layer.dirty.add(k);
    // The first paint (or the last one gone) changes every chunk's colours.
    if (layer.grid.hasPaint() !== painted) for (const k of layer.chunks.keys()) layer.dirty.add(k);
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
    for (const [ck, g] of layer.chunks) this.dropChunk(entityId, layer, ck, g);
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
    let lodChunks = 0;
    const shown: number[] = [];
    for (const layer of this.layers.values()) {
      chunks += layer.chunks.size;
      for (const g of layer.chunks.values()) {
        for (const mesh of detailedMeshes(g)) {
          meshes += 1;
          const index = (mesh.geometry as THREE.BufferGeometry).getIndex();
          triangles += index !== null ? index.count / 3 : 0;
        }
        for (const c of g.children) {
          const lod = c as THREE.LOD;
          if (lod.isLOD !== true) continue;
          lodChunks += 1;
          const level = currentLodLevel(lod);
          while (shown.length <= level) shown.push(0);
          shown[level] = shown[level]! + 1;
        }
      }
    }
    return { layers: this.layers.size, chunks, meshes, triangles, ...(lodChunks > 0 ? { lods: { chunks: lodChunks, shown } } : {}) };
  }

  /**
   * Build lightmap UVs for a layer's chunks (for a bake) — also where the
   * host does not want them otherwise — until turned off again. The chunks
   * re-mesh at the next `update`.
   */
  setLightmapUv(entityId: string, on: boolean): void {
    if (on === this.forcedUv.has(entityId)) return;
    if (on) this.forcedUv.add(entityId);
    else this.forcedUv.delete(entityId);
    const layer = this.layers.get(entityId);
    if (layer !== undefined) for (const ck of layer.chunks.keys()) layer.dirty.add(ck);
  }

  /** A layer's chunks with lightmap UVs (their meshes, layout digest and area), in chunk order. */
  lightmapTargets(entityId: string): BlockChunkLightmapTarget[] {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return [];
    const out: BlockChunkLightmapTarget[] = [];
    for (const [ck, g] of [...layer.chunks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const lm = layer.lightmapLayouts.get(ck);
      if (lm === undefined) continue;
      const [cx, cz] = ck.split(',').map(Number) as [number, number];
      const meshes = detailedMeshes(g).filter((m) => m.geometry.getAttribute('uv1') !== undefined);
      const coarse: THREE.Mesh[] = [];
      g.traverse((o) => ((o as THREE.Mesh).isMesh === true && o.userData[COARSE_LEVEL] !== undefined ? coarse.push(o as THREE.Mesh) : undefined));
      out.push({ cx, cz, layout: lm.layout, area: lm.area, side: lm.side, meshes, coarse });
    }
    return out;
  }

  /** One layer's chunk meshes (what a pointer ray hits of it). */
  layerMeshes(entityId: string): THREE.Mesh[] {
    const layer = this.layers.get(entityId);
    const out: THREE.Mesh[] = [];
    if (layer !== undefined) for (const g of layer.chunks.values()) out.push(...detailedMeshes(g));
    return out;
  }

  /** The chunk meshes (static geometry) — e.g. occluders for a light bake. */
  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const layer of this.layers.values()) for (const g of layer.chunks.values()) out.push(...detailedMeshes(g));
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
    if (old !== undefined) this.dropChunk(entityId, layer, ck, old);
    if (layer.component.metadataOnly === true) return;
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    const looks = new Map<string, { materials: readonly THREE.Material[]; type: BlockType; assetId: string | null; color: string | null; levels: BlockModelLook['levels'] }>();
    const tops = blockTopOptions(layer.component);
    /** The chunk meshed at one level of detail: model looks at that level (or their last), stand-ins as they are. */
    const mesh = (level: number): ChunkMeshPart[] =>
      meshBlockChunk(layer.grid, cx, cz, this.types, {
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
            looks.set(key, { materials: look.materials, type, assetId: model.assetId, color: null, levels: look.levels });
            const levels = look.levels ?? [];
            return { key, source: level === 0 || levels.length === 0 ? look.source : levels[Math.min(level, levels.length) - 1]!.source };
          }
          const color = type.variants[variant]?.color ?? type.variants[0]?.color ?? '#b0b0b0';
          const key = `c:${type.blockId}:${variant}`;
          looks.set(key, { materials: [], type, assetId: null, color, levels: undefined });
          return { key, source: this.standIn(type, fm) };
        },
      }, tops);
    let parts = mesh(0);
    if (parts.length === 0) return;
    // Chunk levels of detail from the model looks' own levels: level L shows each model at its level L (or
    // its last), switching where the farthest of those models would, plus the chunk's radius (no cell switches
    // earlier than it would alone). Stand-ins have one level and stay out of the switch.
    const levelCount = Math.max(0, ...[...looks.values()].map((l) => l.levels?.length ?? 0));
    const coarse: { parts: ChunkMeshPart[]; distance: number }[] = [];
    for (let level = 1; level <= levelCount; level++) {
      const distance = Math.max(...[...looks.values()].filter((l) => (l.levels?.length ?? 0) >= level).map((l) => l.levels![level - 1]!.distance));
      coarse.push({ parts: mesh(level).filter((p) => p.key.startsWith('m:')), distance });
    }
    // Lightmap UVs where a bake has (or is making) this layer's lightmaps: one square per chunk; coarser levels map into it.
    let lightmap: { layout: string; area: number; side: number } | null = null;
    if (this.forcedUv.has(entityId) || this.deps.lightmapped?.(entityId) === true) {
      // Smoothed or subdivided tops light differently: a bake made without them no longer matches the chunk.
      const shading = tops.smoothAngle !== undefined || tops.topSubdivision !== undefined ? `tops:${tops.smoothAngle ?? 0}:${tops.topSubdivision ?? 1}` : undefined;
      const lm = chunkLightmapLayout(parts, layer.grid.cellSize, undefined, shading);
      parts = lm.parts;
      for (const c of coarse) c.parts = chunkLightmapLayout(c.parts, layer.grid.cellSize, lm).parts;
      lightmap = { layout: lm.layout, area: lm.area, side: lm.side };
    }
    const group = new THREE.Group();
    group.name = `block-chunk:${entityId}:${ck}`;
    // A painted layer's chunks carry the paint as vertex colours (every chunk, so they match at the seams).
    const painted = layer.grid.hasPaint();
    const lattice = painted ? layer.grid.chunkPaint(cx, cz) : null;
    const build = (p: ChunkMeshPart, level: number): THREE.Mesh | null => {
      const look = looks.get(p.key.slice(0, p.key.lastIndexOf('#')));
      if (look === undefined) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
      if (p.uv1 !== undefined) geometry.setAttribute('uv1', new THREE.BufferAttribute(p.uv1, 2));
      geometry.setIndex(new THREE.BufferAttribute(p.indices, 1));
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      const material = look.color !== null ? this.colorMaterial(look.color) : (look.materials[p.material] ?? look.materials[0] ?? this.colorMaterial('#b0b0b0'));
      const m = new THREE.Mesh(geometry, material);
      m.name = `block:${p.key}`;
      m.castShadow = layer.component.castShadow !== false;
      m.receiveShadow = layer.component.receiveShadow !== false;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      if (level > 0) m.userData[COARSE_LEVEL] = level;
      if (look.assetId !== null) this.deps.applyMaterials?.(m, look.type, look.assetId);
      else if (look.type.materials !== undefined && Object.keys(look.type.materials).length > 0) this.deps.applyMaterials?.(m, look.type, null);
      // A material that tints by vertex colours would be tinted by the paint: its chunks keep none.
      if (painted && (m.material as THREE.Material & { vertexColors?: boolean }).vertexColors !== true) {
        const colours = chunkPaintColors(lattice, cx, cz, layer.grid.cellSize, p.positions);
        geometry.setAttribute('color', new THREE.BufferAttribute(colours.weights, 4, true));
        geometry.setAttribute('color_1', new THREE.BufferAttribute(colours.wetness, 4, true));
      }
      return m;
    };
    const detailed = new THREE.Group();
    for (const p of parts) {
      const m = build(p, 0);
      if (m === null) continue;
      if (coarse.length > 0 && p.key.startsWith('m:')) detailed.add(m);
      else group.add(m);
    }
    if (coarse.length > 0 && detailed.children.length > 0) {
      // One THREE.LOD at the centre of the chunk's model geometry; each level's meshes offset back by it.
      const box = new THREE.Box3();
      for (const c of detailed.children) box.union((c as THREE.Mesh).geometry.boundingBox!);
      const centre = box.getCenter(new THREE.Vector3());
      const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
      const lod = new THREE.LOD();
      lod.name = `block-chunk-lod:${entityId}:${ck}`;
      lod.position.copy(centre);
      const level = (g: THREE.Group): THREE.Group => {
        g.position.copy(centre).negate();
        g.matrixAutoUpdate = false;
        g.updateMatrix();
        return g;
      };
      lod.addLevel(level(detailed), 0);
      coarse.forEach((c, i) => {
        const g = new THREE.Group();
        for (const p of c.parts) {
          const m = build(p, i + 1);
          if (m !== null) g.add(m);
        }
        lod.addLevel(level(g), c.distance + radius);
      });
      lod.matrixAutoUpdate = false;
      lod.updateMatrix();
      group.add(lod);
    } else for (const c of [...detailed.children]) group.add(c);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    layer.group.add(group);
    group.updateMatrixWorld(true);
    layer.chunks.set(ck, group);
    this.deps.place?.(group, true);
    if (lightmap !== null) {
      layer.lightmapLayouts.set(ck, lightmap);
      this.deps.chunkBuilt?.(entityId, cx, cz, group, lightmap.layout);
    }
  }

  private dropChunk(entityId: string, layer: LayerState, ck: string, group: THREE.Group): void {
    if (layer.lightmapLayouts.delete(ck)) {
      const [cx, cz] = ck.split(',').map(Number) as [number, number];
      this.deps.chunkDropped?.(entityId, cx, cz);
    }
    this.deps.place?.(group, false);
    group.traverse((o) => ((o as THREE.Mesh).isMesh === true ? (o as THREE.Mesh).geometry.dispose() : undefined));
    group.removeFromParent();
    layer.chunks.delete(ck);
  }
}

/** The chunk key of a cell column (for callers mapping cells to chunks). */
export const blockChunkKey = (x: number, z: number): string => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
