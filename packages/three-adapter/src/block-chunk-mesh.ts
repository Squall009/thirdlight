/**
 * Meshing one block chunk for drawing, without three.js: the same code runs
 * on the page (an edit's chunk, or no mesh worker) and in the mesh workers
 * (`block-mesh-worker.ts`), so a chunk is meshed byte for byte the same either
 * way. The page turns the result into three.js meshes (`block-layers.ts`).
 *
 * A chunk's result: its parts at full detail, the model looks' coarser levels
 * (each with the distance it takes over at), its lightmap layout when asked
 * for one, the looks its parts draw, and the models it needed but did not
 * have (still loading, or never sent to this worker): the page loads them and
 * meshes the chunk again. A painted layer's parts carry their paint colours
 * (`chunkMeshPaint`), and a layer with corner shading its per-vertex
 * occlusion (`chunkMeshAO`), made here so the workers make them too.
 */
import {
  blockTopOptions,
  cutawaySeams,
  cutawayZones,
  blockVariantUv,
  chunkLightmapLayout,
  chunkMeshAO,
  chunkMeshPaint,
  meshBlockChunk,
  shapeSource,
  type BlockGridReader,
  type BlockLayerComponent,
  type BlockMeshSource,
  type BlockType,
  type ChunkMeshPart,
} from '@thirdlight/runtime';

/** A model a block variant draws (an asset, optionally one piece of it). */
export interface ChunkModelRef {
  readonly assetId: string;
  readonly piece?: string;
}

/** A model's geometry in the block frame and its coarser levels (each with the camera distance it takes over at). */
export interface ChunkModelGeometry {
  readonly source: BlockMeshSource;
  readonly levels?: readonly { readonly source: BlockMeshSource; readonly distance: number }[];
}

/** The key a model's geometry is kept under (pages and workers alike). */
export const chunkModelKey = (ref: ChunkModelRef): string => `${ref.assetId}|${ref.piece ?? ''}`;

/** Where the mesher finds a variant's model and a model's geometry. */
export interface ChunkLooks {
  /** The model a block type's variant draws; null: a stand-in in the variant's colour (for a prefab look whose root has no model: nothing). */
  variantModel(type: BlockType, variant: number): ChunkModelRef | null;
  /** A model's geometry; null while it is not there (the chunk draws without it). */
  model(ref: ChunkModelRef): ChunkModelGeometry | null;
}

/** One look a chunk's parts draw: by part key prefix (`<look key>#<material>`). */
export interface ChunkLookUse {
  readonly key: string;
  readonly blockId: string;
  /** The model (null: a stand-in in `color`). */
  readonly model: ChunkModelRef | null;
  readonly color: string | null;
}

export interface ChunkMeshRequest {
  readonly cx: number;
  readonly cz: number;
  /** Build lightmap UVs (one square layout per chunk). */
  readonly uv: boolean;
}

export interface ChunkMeshResult {
  readonly parts: ChunkMeshPart[];
  /** The model looks' coarser levels: level L+1's parts (model parts only) and its switch distance. */
  readonly coarse: { parts: ChunkMeshPart[]; distance: number }[];
  readonly lightmap: { layout: string; area: number; side: number } | null;
  readonly looks: ChunkLookUse[];
  /** Models a cell asked for and this mesher did not have. */
  readonly missing: ChunkModelRef[];
}

/** Stand-in shapes per shape, footprint and boxes, built once. */
export class StandInShapes {
  private readonly cache = new Map<string, BlockMeshSource>();

  of(type: BlockType, fm: readonly [number, number, number]): BlockMeshSource {
    const key = `${type.shape}|${fm.join(',')}|${JSON.stringify(type.boxes ?? null)}`;
    let s = this.cache.get(key);
    if (s === undefined) {
      s = shapeSource(type.shape === 'none' ? 'full' : type.shape, fm[0], fm[1], fm[2], type.boxes);
      this.cache.set(key, s);
    }
    return s;
  }
}

/** The model a variant draws: its own, or its prefab's (resolved by `prefabModel`). */
export function variantModelOf(type: BlockType, variant: number, prefabModel: (prefabId: string) => ChunkModelRef | null): ChunkModelRef | null {
  const v = type.variants[variant] ?? type.variants[0];
  if (v === undefined) return null;
  if (v.model !== undefined) return v.model;
  if (v.prefab !== undefined) return prefabModel(v.prefab);
  return null;
}

/** Mesh one chunk of a layer (see the module comment). */
export function meshChunkForDrawing(grid: BlockGridReader, component: BlockLayerComponent, types: ReadonlyMap<string, BlockType>, looks: ChunkLooks, standIns: StandInShapes, req: ChunkMeshRequest): ChunkMeshResult {
  const { cx, cz } = req;
  const used = new Map<string, ChunkLookUse & { levels: ChunkModelGeometry['levels'] }>();
  const missing = new Map<string, ChunkModelRef>();
  // A layer with cut-aways keeps the faces between a zone's cells and the rest (the wall's top under a cut roof).
  const seams = component.cutaway !== undefined ? cutawaySeams(cutawayZones(component, grid.regions)) : undefined;
  const tops = { ...blockTopOptions(component), ...(seams !== undefined ? { seams } : {}) };
  /** The chunk meshed at one level of detail: model looks at that level (or their last), stand-ins as they are. */
  const mesh = (level: number): ChunkMeshPart[] =>
    meshBlockChunk(grid, cx, cz, types, {
      source: (type, variant, fm) => {
        const model = looks.variantModel(type, variant);
        if (model !== null) {
          const look = looks.model(model);
          if (look === null) {
            missing.set(chunkModelKey(model), model);
            return null;
          }
          // Two variants drawing one model with different texture coordinates are two looks.
          const world = blockVariantUv(type, variant) === 'world';
          const key = `m:${model.assetId}:${model.piece ?? ''}:${type.blockId}${world ? ':w' : ''}`;
          used.set(key, { key, blockId: type.blockId, model, color: null, levels: look.levels });
          const levels = look.levels ?? [];
          return { key, source: level === 0 || levels.length === 0 ? look.source : levels[Math.min(level, levels.length) - 1]!.source, ...(world ? { uv: 'world' as const, tangents: true } : {}) };
        }
        // A prefab look whose root has no model (a live block's logic-only cell) draws nothing.
        if ((type.variants[variant] ?? type.variants[0])?.prefab !== undefined) return null;
        const color = type.variants[variant]?.color ?? type.variants[0]?.color ?? '#b0b0b0';
        const key = `c:${type.blockId}:${variant}`;
        used.set(key, { key, blockId: type.blockId, model: null, color, levels: undefined });
        // A stand-in is always world-mapped; only a mapped material (a texture, maybe a normal map) reads its tangents.
        return { key, source: standIns.of(type, fm), uv: 'world', tangents: type.materials !== undefined && Object.keys(type.materials).length > 0 };
      },
    }, tops);
  let parts = mesh(0);
  if (parts.length === 0) return { parts, coarse: [], lightmap: null, looks: [], missing: [...missing.values()] };
  // Chunk levels of detail from the model looks' own levels: level L shows each model at its level L (or
  // its last), switching where the farthest of those models would, plus the chunk's radius (added by the
  // page, which knows the bounds; no cell switches earlier than it would alone). Stand-ins have one level.
  const levelCount = Math.max(0, ...[...used.values()].map((l) => l.levels?.length ?? 0));
  const coarse: { parts: ChunkMeshPart[]; distance: number }[] = [];
  for (let level = 1; level <= levelCount; level++) {
    const distance = Math.max(...[...used.values()].filter((l) => (l.levels?.length ?? 0) >= level).map((l) => l.levels![level - 1]!.distance));
    coarse.push({ parts: mesh(level).filter((p) => p.key.startsWith('m:')), distance });
  }
  // Lightmap UVs where a bake has (or is making) this layer's lightmaps: one square per chunk; coarser levels map into it.
  let lightmap: ChunkMeshResult['lightmap'] = null;
  if (req.uv) {
    // Smoothed or subdivided tops light differently: a bake made without them no longer matches the chunk.
    const shading = tops.smoothAngle !== undefined || tops.topSubdivision !== undefined ? `tops:${tops.smoothAngle ?? 0}:${tops.topSubdivision ?? 1}` : undefined;
    const lm = chunkLightmapLayout(parts, grid.cellSize, undefined, shading);
    parts = lm.parts;
    for (const c of coarse) c.parts = chunkLightmapLayout(c.parts, grid.cellSize, lm).parts;
    lightmap = { layout: lm.layout, area: lm.area, side: lm.side };
  }
  // A painted layer (or one whose walls have paint of their own) carries its paint on every chunk, so chunks match at the seams.
  if (component.wallPaint === true || grid.hasPaint()) {
    const options = { wallPaint: component.wallPaint === true, topSubdivision: tops.topSubdivision ?? 1 };
    const paint = (p: ChunkMeshPart): void => {
      const c = chunkMeshPaint(grid, types, cx, cz, options, p);
      p.weights = c.weights;
      p.wetness = c.wetness;
    };
    parts.forEach(paint);
    for (const c of coarse) c.parts.forEach(paint);
  }
  // Corner shading (the layer's vertexAO): a factor of the indirect light per vertex, read by the renderer's lighting.
  const ao = component.vertexAO ?? 0;
  if (ao > 0) {
    const shade = (p: ChunkMeshPart): void => {
      p.ao = chunkMeshAO(grid, types, p, ao);
    };
    parts.forEach(shade);
    for (const c of coarse) c.parts.forEach(shade);
  }
  return { parts, coarse, lightmap, looks: [...used.values()].map(({ key, blockId, model, color }) => ({ key, blockId, model, color })), missing: [...missing.values()] };
}

/** The buffers of a result's arrays, each once (what a worker hands over without copying). */
export function chunkResultBuffers(result: ChunkMeshResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (p: ChunkMeshPart): void => {
    for (const a of [p.positions, p.normals, p.uvs, p.tangents, p.indices, p.uv1, p.weights, p.wetness, p.ao]) if (a !== undefined) out.add(a.buffer as ArrayBuffer);
  };
  for (const p of result.parts) add(p);
  for (const c of result.coarse) for (const p of c.parts) add(p);
  return [...out];
}
