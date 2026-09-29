/**
 * Phase 23.5 (E8): block layers in the running game — the cells of every
 * loaded layer, their colliders on the 3D physics port (one triangle mesh per
 * chunk, rebuilt when cells change), the script API `ctx.grid`, the change
 * events scripts observe, the runtime diff for saves and the chunk changes
 * the renderer re-meshes.
 *
 * Deterministic: integer cell maths, a DDA ray pick over cells (independent
 * of physics), writes applied in call order; the page and the simulation
 * worker run the same code on the same data.
 *
 * Timing: a write changes the cells (and every query) at once; the colliders
 * of the chunks it touched are rebuilt before the step's physics phase (and
 * at the end of the step for writes after it), so the character collides
 * with the new cells in the same step; the renderer re-meshes the chunks at
 * its next frame; other scripts see the change events one step later.
 */
import {
  BlockGrid,
  CHUNK_SIZE,
  autoVariant,
  blockTypeSlopes,
  cellCorners,
  cellOfKey,
  canonicalBlockCell,
  cellCenter,
  cellFieldValueError,
  cellKeyOf,
  collisionMeshChunk,
  effectiveCellMeta,
  pickCell,
  regionCells,
  regionContains,
  rotatedFootprint,
  surfaceBelow,
  validateBlockCell,
  worldToCell,
  type BlockCell,
  type BlockChunk,
  type BlockLayerComponent,
  type BlockLayerData,
  type BlockType,
  type CellField,
  type CellMetaValue,
  type EntityV3,
  type ModelErrorV2,
} from '@thirdlight/project-model';

import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';

// ---- the script API types (public: `ctx.grid`) -------------------------------------

/** A position or direction in world space (metres). */
export interface GridVec3 {
  x: number;
  y: number;
  z: number;
}

/** A cell as scripts read it: its block (null: a metadata-only cell), rotation, variant and effective metadata. */
export interface GridCell {
  readonly block: string | null;
  /** Degrees about +Y: 0, 90, 180 or 270. */
  readonly rot: number;
  /** The variant shown (an unset variant resolved from the weights and the position). */
  readonly variant: number;
  /** The effective metadata (schema defaults, then the block's defaults, then the cell's own values). */
  readonly meta: Readonly<Record<string, number | string | boolean>>;
  /** For a cell covered by a larger block's footprint: that block's anchor cell (absent otherwise). */
  readonly anchor?: GridVec3;
  /**
   * A sloped top: the heights of its corners (−x−z, +x−z, +x+z, −x+z) as fractions of the cell height (absent: a flat full top).
   * @graphType list
   */
  readonly corners?: readonly number[];
}

/** What `ctx.grid.set` writes: a block (with rotation and variant) and/or metadata overrides. */
export interface GridCellInput {
  /** A block type id (absent: a metadata-only cell). */
  block?: string;
  /** Degrees about +Y: 0, 90, 180 or 270. */
  rot?: number;
  /** A variant index (absent: picked from the weights by position). */
  variant?: number;
  /**
   * A sloped top (a single-cell full block): the heights of its corners −x−z, +x−z, +x+z, −x+z as fractions of the cell height, in steps of 1/64 (absent: flat).
   * @graphType list
   */
  corners?: readonly number[];
  /**
   * Metadata overrides (field key → value).
   * @graphType map
   */
  meta?: Record<string, number | string | boolean>;
}

/** The ground of a layer at a point (`ctx.grid.surface`, `columnSurface`). */
export interface GridSurface {
  readonly layer: string;
  /** The cell whose top it is. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The world height of the surface there (metres). */
  readonly height: number;
  /** The surface point in world space. */
  readonly point: GridVec3;
  /** The surface's unit normal. */
  readonly normal: GridVec3;
  /** Degrees from level. */
  readonly slope: number;
  /** Whether the slope is at most the layer's maxSlope (absent: the project's steepest walkable slope). */
  readonly walkable: boolean;
}

/** One cell written by a script (`ctx.grid.changes()`). */
export interface GridChange {
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The block before and after (null: none). */
  readonly before: string | null;
  readonly after: string | null;
  readonly stepIndex: number;
}

/** A ray pick's result. */
export interface GridPick {
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The face the ray entered through (a unit axis vector). */
  readonly normal: GridVec3;
  /** Metres along the ray. */
  readonly distance: number;
  readonly point: GridVec3;
}

/** The cells scripts changed, as plain data (store it in a save, give it back with `applyDiff`). */
export interface GridDiff {
  readonly version: 1;
  readonly layers: readonly { readonly layer: string; readonly cells: readonly (readonly [number, number, number, BlockCell | null])[] }[];
}

/**
 * `ctx.grid` — the block layers of the loaded scenes. Coordinates are cell
 * indices of a layer (x, y, z); a layer is named by its entity id. Writes
 * change cells, queries, rendering and (in a 3D project) collision within the
 * same step; they are refused (`false`) when a value does not fit (unknown
 * block type or field, a rotation the block does not allow, outside the
 * layer's bounds, a larger block's footprint over other cells) or at the
 * engine limit of 4,096 writes per step.
 */
export interface BehaviorGrid {
  /**
   * The block layers of the loaded scenes (their entity ids, in load order).
   * @graphPure
   * @graphNode Block layers
   */
  layers(): readonly string[];
  /**
   * The cell at [x, y, z] of a layer, or null when it is empty (or no such layer).
   * @graphPure
   * @graphNode Get cell
   */
  get(layer: string, x: number, y: number, z: number): GridCell | null;
  /**
   * Write a cell: a block and/or metadata overrides. False when refused.
   * @graphNode Set cell
   */
  set(layer: string, x: number, y: number, z: number, cell: GridCellInput): boolean;
  /**
   * Empty a cell (its block and metadata). False when refused or already empty.
   * @graphNode Clear cell
   */
  clear(layer: string, x: number, y: number, z: number): boolean;
  /**
   * The highest cell of a column holding a block (its y), or null.
   * @graphPure
   * @graphNode Column top
   */
  columnTop(layer: string, x: number, z: number): number | null;
  /**
   * The ground straight down from a world position: the top of the layer's blocks at or below it (sloped tops, ramps and half blocks included; inside the blocks: the top of the blocks there), with its height, normal, slope and whether it is walkable; null when the column holds no block.
   * @graphPure
   * @graphNode Surface below
   */
  surface(layer: string, position: readonly [number, number, number]): GridSurface | null;
  /**
   * The top surface of a column at its centre (cell x, z): the highest block's top, its height, normal, slope and whether it is walkable; null when the column holds no block.
   * @graphPure
   * @graphNode Column surface
   */
  columnSurface(layer: string, x: number, z: number): GridSurface | null;
  /**
   * The cell holding a world position (it may lie outside the layer's bounds), or null for no such layer.
   * @graphPure
   * @graphNode World to cell
   */
  worldToCell(layer: string, position: readonly [number, number, number]): GridVec3 | null;
  /**
   * The world position of a cell's centre, or null for no such layer.
   * @graphPure
   * @graphNode Cell to world
   */
  cellToWorld(layer: string, x: number, y: number, z: number): GridVec3 | null;
  /**
   * One effective metadata value of a cell (defaults included), or null for an unknown field or layer.
   * @graphPure
   * @graphNode Cell metadata
   */
  meta(layer: string, x: number, y: number, z: number, key: string): number | string | boolean | null;
  /**
   * Set one metadata value of a cell (null removes the override; an empty cell becomes a metadata-only cell). False when refused.
   * @graphNode Set cell metadata
   */
  setMeta(layer: string, x: number, y: number, z: number, key: string, value: number | string | boolean | null): boolean;
  /**
   * The first block cell a ray enters (every layer, or one), with the face it entered through; null when none within maxDistance (default 100 m).
   * @graphPure
   * @graphNode Pick cell
   * @graphDefault direction [0, -1, 0]
   */
  pick(origin: readonly [number, number, number], direction: readonly [number, number, number], maxDistance?: number, layer?: string): GridPick | null;
  /**
   * The cells next to [x, y, z] inside the layer's bounds: the 6 face neighbours, or all 26 with diagonal.
   * @graphPure
   * @graphNode Neighbour cells
   */
  neighbours(layer: string, x: number, y: number, z: number, diagonal?: boolean): readonly GridVec3[];
  /**
   * The region ids of a layer.
   * @graphPure
   * @graphNode Regions
   */
  regions(layer: string): readonly string[];
  /**
   * The cells of a named region (at most 65,536), or null when the layer has no such region.
   * @graphPure
   * @graphNode Region cells
   */
  region(layer: string, regionId: string): readonly GridVec3[] | null;
  /**
   * Whether a cell lies in a named region.
   * @graphPure
   * @graphNode In region
   */
  inRegion(layer: string, regionId: string, x: number, y: number, z: number): boolean;
  /**
   * The cells scripts wrote in the previous step, in write order.
   * @graphNode skip scripts read the list with a loop
   */
  changes(): readonly GridChange[];
  /**
   * The cells changed since the run started, as plain data for a save.
   * @graphNode skip saves store it as data
   */
  diff(): GridDiff;
  /**
   * Re-apply a saved diff (after loading a save). False when it does not fit the loaded layers.
   * @graphNode skip saves store it as data
   */
  applyDiff(diff: GridDiff): boolean;
}

/** One chunk the renderer re-meshes (its cells now; null: it holds none). */
export interface GridRenderChange {
  readonly entityId: string;
  readonly cx: number;
  readonly cz: number;
  readonly chunk: BlockChunk | null;
}

/** At most this many script writes per step (an engine limit protecting the step budget). */
export const GRID_WRITES_PER_STEP = 4096;

interface Layer {
  readonly entityId: string;
  readonly component: BlockLayerComponent;
  readonly origin: GridVec3;
  readonly authored: BlockLayerData | null;
  grid: BlockGrid;
  /** Footprint coverage: covered cell key → anchor key. */
  covers: Map<number, number>;
  /** Cells written since the run started (for the diff). */
  touched: Set<number>;
  /** The collider ids per chunk key. */
  colliders: Map<string, string[]>;
}

const freezeVec = (x: number, y: number, z: number): GridVec3 => Object.freeze({ x, y, z });

/** The id of one chunk collider piece on the physics port. */
export function gridColliderId(entityId: string, ck: string, piece: number): string {
  return `${entityId}#blocks:${ck}:${piece}`;
}

export class RuntimeGrid {
  private readonly types: Map<string, BlockType>;
  private readonly fields: readonly CellField[];
  private readonly fieldByKey: Map<string, CellField>;
  private readonly layerMap = new Map<string, Layer>();
  private readonly collide: boolean;
  private collisionDirty = new Map<string, Set<string>>();
  private renderDirty = new Map<string, Set<string>>();
  private current: GridChange[] = [];
  private previous: readonly GridChange[] = Object.freeze([]);
  private writes = 0;
  /** Phase 23.19: a save's restore is writing (no per-step limit). */
  private unlimited = false;
  private stepIndex = 0;
  readonly api: BehaviorGrid;

  /** Degrees: what surface queries call walkable on a layer without its own maxSlope (the project's steepest walkable slope). */
  private readonly defaultMaxSlope: number;

  constructor(types: readonly BlockType[], fields: readonly CellField[], collide: boolean, defaultMaxSlope = 45) {
    this.types = new Map(types.map((t) => [t.blockId, t]));
    this.fields = fields;
    this.fieldByKey = new Map(fields.map((f) => [f.key, f]));
    this.collide = collide;
    this.defaultMaxSlope = defaultMaxSlope;
    this.api = this.buildApi();
  }

  /** Whether any layer is loaded. */
  get empty(): boolean {
    return this.layerMap.size === 0;
  }

  /** The layers of entities that carry `blockLayer` (their cells from the resolved component's `data`). */
  addLayers(entities: readonly EntityV3[]): string[] {
    const added: string[] = [];
    for (const e of entities) {
      const comp = (e.components as { blockLayer?: BlockLayerComponent & { data?: BlockLayerData } }).blockLayer;
      if (comp === undefined || this.layerMap.has(e.id)) continue;
      const p = e.components.transform?.position ?? [0, 0, 0];
      const data = comp.data ?? null;
      const layer: Layer = { entityId: e.id, component: comp, origin: freezeVec(p[0], p[1], p[2]), authored: data, grid: BlockGrid.from(comp, data), covers: new Map(), touched: new Set(), colliders: new Map() };
      this.rebuildCovers(layer);
      this.layerMap.set(e.id, layer);
      this.markAll(layer);
      added.push(e.id);
    }
    return added;
  }

  /** Forget unloaded layers; returns their collider ids (the caller removes them from the port). */
  removeLayers(ids: ReadonlySet<string>): string[] {
    const colliders: string[] = [];
    for (const id of ids) {
      const layer = this.layerMap.get(id);
      if (layer === undefined) continue;
      for (const list of layer.colliders.values()) colliders.push(...list);
      this.layerMap.delete(id);
      this.collisionDirty.delete(id);
      this.renderDirty.delete(id);
    }
    return colliders;
  }

  /** A new run (start, replay): every layer back to its authored cells. */
  reset(): void {
    for (const layer of this.layerMap.values()) {
      if (layer.touched.size === 0) continue;
      layer.grid = BlockGrid.from(layer.component, layer.authored);
      layer.touched.clear();
      this.rebuildCovers(layer);
      this.markAll(layer);
    }
    this.current = [];
    this.previous = Object.freeze([]);
    this.writes = 0;
  }

  /**
   * Phase 23.19: a loaded save's cells (`grid` section, a `diff()`): every
   * layer back to its authored cells, then the saved ones. Atomic — when a
   * cell does not fit (an unknown layer or block, a footprint clash) nothing
   * changes and the reason is returned; null: restored. The restore's writes
   * are not counted against the per-step limit (a save may hold many cells).
   */
  restoreDiff(diff: unknown): string | null {
    const d = (diff ?? { version: 1, layers: [] }) as GridDiff;
    if (typeof d !== 'object' || d === null || d.version !== 1 || !Array.isArray(d.layers)) return 'the grid section is not a grid diff (version 1)';
    for (const entry of d.layers) {
      if (typeof entry !== 'object' || entry === null || typeof entry.layer !== 'string' || !Array.isArray(entry.cells)) return 'a grid diff layer is { layer, cells }';
      if (!this.layerMap.has(entry.layer)) return `block layer "${entry.layer.slice(0, 64)}" is not loaded`;
      for (const c of entry.cells) if (!Array.isArray(c) || c.length !== 4 || !Number.isSafeInteger(c[0]) || !Number.isSafeInteger(c[1]) || !Number.isSafeInteger(c[2])) return 'a grid diff cell is [x, y, z, cell | null]';
    }
    const involved = new Set<string>(d.layers.map((e) => e.layer));
    for (const l of this.layerMap.values()) if (l.touched.size > 0) involved.add(l.entityId);
    const saved = new Map<string, { grid: BlockGrid; covers: Map<number, number>; touched: Set<number> }>();
    for (const id of involved) {
      const l = this.layerMap.get(id)!;
      saved.set(id, { grid: l.grid, covers: l.covers, touched: l.touched });
      l.grid = BlockGrid.from(l.component, l.authored);
      l.touched = new Set();
      this.rebuildCovers(l);
    }
    const writes = this.writes;
    const changes = this.current.length;
    this.unlimited = true;
    let problem: string | null = null;
    try {
      // Clears first, so a moved larger block never meets its own old footprint.
      outer: for (const pass of [0, 1]) {
        for (const entry of d.layers) {
          for (const c of entry.cells) {
            if ((c[3] === null) !== (pass === 0)) continue;
            if (!this.write(entry.layer, c[0], c[1], c[2], c[3] as BlockCell | null)) {
              const l = this.layerMap.get(entry.layer)!;
              problem = `cell [${c[0]}, ${c[1]}, ${c[2]}] of layer "${entry.layer.slice(0, 64)}": ${this.refusal(l, c[0], c[1], c[2], c[3] === null ? null : canonicalBlockCell(c[3] as BlockCell)) ?? 'does not fit'}`;
              break outer;
            }
          }
        }
      }
    } finally {
      this.unlimited = false;
      this.writes = writes;
    }
    if (problem !== null) {
      for (const [id, st] of saved) {
        const l = this.layerMap.get(id)!;
        l.grid = st.grid;
        l.covers = st.covers;
        l.touched = st.touched;
        l.grid.takeDirty();
      }
      this.current.length = changes;
      return problem;
    }
    for (const id of involved) this.markAll(this.layerMap.get(id)!);
    return null;
  }

  /** At the start of a step: the last step's writes become the visible changes. */
  beginStep(stepIndex: number): void {
    this.previous = Object.freeze(this.current);
    this.current = [];
    this.writes = 0;
    this.stepIndex = stepIndex;
  }

  /** Rebuild the colliders of the chunks written since the last flush (batched: one remove, one add). */
  flushCollision(port: PhysicsPort3D | undefined): void {
    if (this.collisionDirty.size === 0) return;
    const dirty = this.collisionDirty;
    this.collisionDirty = new Map();
    if (port === undefined || !this.collide) return;
    const remove: string[] = [];
    const add: StaticColliderSpec3D[] = [];
    for (const [entityId, keys] of [...dirty.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const layer = this.layerMap.get(entityId);
      if (layer === undefined || layer.component.collision === false || layer.component.metadataOnly === true) continue;
      for (const ck of [...keys].sort()) {
        const old = layer.colliders.get(ck);
        if (old !== undefined) remove.push(...old);
        const [cx, cz] = ck.split(',').map(Number) as [number, number];
        const pieces = collisionMeshChunk(layer.grid, cx, cz, this.types);
        const ids: string[] = [];
        pieces.forEach((p, i) => {
          const id = gridColliderId(entityId, ck, i);
          ids.push(id);
          add.push({
            entityId: id,
            shape: { type: 'mesh', vertices: p.vertices, indices: p.indices },
            position: { x: layer.origin.x, y: layer.origin.y, z: layer.origin.z },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            ...(layer.component.maxSlope !== undefined ? { maxSlope: (layer.component.maxSlope * Math.PI) / 180 } : {}),
          });
        });
        if (ids.length > 0) layer.colliders.set(ck, ids);
        else layer.colliders.delete(ck);
      }
    }
    if (remove.length > 0) port.removeStaticColliders?.(remove);
    if (add.length > 0) port.addStaticColliders?.(add);
  }

  /** The chunks to re-mesh since the last call, with their cells now. */
  takeRenderChanges(): GridRenderChange[] {
    if (this.renderDirty.size === 0) return [];
    const out: GridRenderChange[] = [];
    for (const [entityId, keys] of this.renderDirty) {
      const layer = this.layerMap.get(entityId);
      if (layer === undefined) continue;
      for (const ck of [...keys].sort()) {
        const [cx, cz] = ck.split(',').map(Number) as [number, number];
        out.push({ entityId, cx, cz, chunk: layer.grid.encodeChunk(ck) });
      }
    }
    this.renderDirty = new Map();
    return out;
  }

  /** A layer's current grid (the renderer's own copy starts from the entity's data). */
  gridOf(entityId: string): BlockGrid | null {
    return this.layerMap.get(entityId)?.grid ?? null;
  }

  // ---- internals -----------------------------------------------------------------------

  private markAll(layer: Layer): void {
    const keys = new Set(layer.grid.chunkKeys());
    for (const ck of layer.colliders.keys()) keys.add(ck);
    if (keys.size === 0) return;
    this.collisionDirty.set(layer.entityId, new Set([...(this.collisionDirty.get(layer.entityId) ?? []), ...keys]));
    this.renderDirty.set(layer.entityId, new Set([...(this.renderDirty.get(layer.entityId) ?? []), ...keys]));
  }

  private markWritten(layer: Layer): void {
    const d = layer.grid.takeDirty();
    if (d.mesh.length === 0) return;
    let c = this.collisionDirty.get(layer.entityId);
    if (c === undefined) this.collisionDirty.set(layer.entityId, (c = new Set()));
    let r = this.renderDirty.get(layer.entityId);
    if (r === undefined) this.renderDirty.set(layer.entityId, (r = new Set()));
    for (const k of d.mesh) {
      c.add(k);
      r.add(k);
    }
  }

  private footprintOf(cell: BlockCell | null): [number, number, number] | null {
    if (cell?.block === undefined) return null;
    const t = this.types.get(cell.block);
    if (t?.footprint === undefined) return null;
    const f = rotatedFootprint(t, cell.rot);
    return f[0] === 1 && f[1] === 1 && f[2] === 1 ? null : f;
  }

  private rebuildCovers(layer: Layer): void {
    layer.covers = new Map();
    layer.grid.forEach((x, y, z, idx) => this.addCover(layer, x, y, z, layer.grid.valueOf(idx)));
  }

  private addCover(layer: Layer, x: number, y: number, z: number, cell: BlockCell | null): void {
    const f = this.footprintOf(cell);
    if (f === null) return;
    const anchor = cellKeyOf(x, y, z);
    for (let dx = 0; dx < f[0]; dx++) for (let dy = 0; dy < f[1]; dy++) for (let dz = 0; dz < f[2]; dz++) if (dx !== 0 || dy !== 0 || dz !== 0) layer.covers.set(cellKeyOf(x + dx, y + dy, z + dz), anchor);
  }

  private removeCover(layer: Layer, x: number, y: number, z: number, cell: BlockCell | null): void {
    const f = this.footprintOf(cell);
    if (f === null) return;
    for (let dx = 0; dx < f[0]; dx++) for (let dy = 0; dy < f[1]; dy++) for (let dz = 0; dz < f[2]; dz++) if (dx !== 0 || dy !== 0 || dz !== 0) layer.covers.delete(cellKeyOf(x + dx, y + dy, z + dz));
  }

  /** Why a value cannot go to a cell (null: it can). */
  private refusal(layer: Layer, x: number, y: number, z: number, cell: BlockCell | null): string | null {
    if (!layer.grid.inBounds(x, y, z)) return 'outside the bounds';
    if (cell === null) return null;
    const errors: ModelErrorV2[] = [];
    validateBlockCell(cell, '', errors);
    if (errors.length > 0) return errors[0]!.message;
    if (cell.block !== undefined) {
      if (layer.component.metadataOnly === true) return 'a metadata-only layer';
      const t = this.types.get(cell.block);
      if (t === undefined) return 'an unknown block type';
      if (!(t.rotations ?? [0, 90, 180, 270]).includes(cell.rot ?? 0)) return 'a rotation the block does not allow';
      if (cell.variant !== undefined && cell.variant >= t.variants.length) return 'no such variant';
      if (cell.corners !== undefined && !blockTypeSlopes(t)) return 'corners on a block that cannot slope (a single-cell full block can)';
    }
    for (const [k, v] of Object.entries(cell.meta ?? {})) {
      const f = this.fieldByKey.get(k);
      if (f === undefined || cellFieldValueError(f, v) !== null) return 'a metadata value that does not fit';
    }
    const key = cellKeyOf(x, y, z);
    if (cell.block !== undefined && layer.covers.has(key)) return 'a cell covered by a larger block';
    const f = this.footprintOf(cell);
    if (f !== null) {
      for (let dx = 0; dx < f[0]; dx++)
        for (let dy = 0; dy < f[1]; dy++)
          for (let dz = 0; dz < f[2]; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            if (!layer.grid.inBounds(x + dx, y + dy, z + dz)) return 'a footprint outside the bounds';
            const k = cellKeyOf(x + dx, y + dy, z + dz);
            if (layer.grid.indexAt(x + dx, y + dy, z + dz) >= 0) return 'a footprint over other cells';
            const other = layer.covers.get(k);
            if (other !== undefined && other !== key) return 'a footprint over another block';
          }
    }
    return null;
  }

  /** Write one cell (validated); records the change. */
  private write(layerId: string, x: number, y: number, z: number, cell: BlockCell | null): boolean {
    const layer = this.layerMap.get(layerId);
    if (layer === undefined || ![x, y, z].every((v) => Number.isSafeInteger(v))) return false;
    if (!this.unlimited && this.writes >= GRID_WRITES_PER_STEP) return false;
    const next = cell === null ? null : canonicalBlockCell(cell);
    const normalized = next !== null && next.block === undefined && next.meta === undefined ? null : next;
    if (this.refusal(layer, x, y, z, normalized) !== null) return false;
    const before = layer.grid.get(x, y, z);
    if (!layer.grid.set(x, y, z, normalized)) return false;
    this.writes += 1;
    this.removeCover(layer, x, y, z, before);
    this.addCover(layer, x, y, z, normalized);
    layer.touched.add(cellKeyOf(x, y, z));
    this.markWritten(layer);
    this.current.push(Object.freeze({ layer: layerId, x, y, z, before: before?.block ?? null, after: normalized?.block ?? null, stepIndex: this.stepIndex }));
    return true;
  }

  private view(layer: Layer, x: number, y: number, z: number): GridCell | null {
    let cell = layer.grid.get(x, y, z);
    let anchor: GridVec3 | undefined;
    let [ax, ay, az] = [x, y, z];
    if (cell === null || cell.block === undefined) {
      const a = layer.covers.get(cellKeyOf(x, y, z));
      if (a !== undefined) {
        [ax, ay, az] = cellOfKey(a);
        cell = layer.grid.get(ax, ay, az);
        anchor = freezeVec(ax, ay, az);
      }
    }
    if (cell === null) return null;
    const t = cell.block !== undefined ? this.types.get(cell.block) : undefined;
    const variant = cell.variant ?? (t !== undefined ? autoVariant(t, ax, ay, az) : 0);
    const meta = Object.freeze(effectiveCellMeta(cell, this.types, this.fields));
    const corners = cellCorners(cell);
    return Object.freeze({ block: cell.block ?? null, rot: cell.rot ?? 0, variant, meta, ...(anchor !== undefined ? { anchor } : {}), ...(corners !== null ? { corners: Object.freeze([...corners]) } : {}) });
  }

  /** The ground of a layer at or below a world point (null: none). */
  private surfaceOf(layer: Layer, x: number, y: number, z: number): GridSurface | null {
    const o = layer.origin;
    const hit = surfaceBelow(layer.grid, this.types, x - o.x, y - o.y, z - o.z, (cx, cy, cz) => {
      const a = layer.covers.get(cellKeyOf(cx, cy, cz));
      return a === undefined ? null : cellOfKey(a);
    });
    if (hit === null || layer.component.metadataOnly === true) return null;
    const height = o.y + hit.height;
    const max = layer.component.maxSlope ?? this.defaultMaxSlope;
    return Object.freeze({
      layer: layer.entityId,
      x: hit.cell[0],
      y: hit.cell[1],
      z: hit.cell[2],
      height,
      point: freezeVec(x, height, z),
      normal: freezeVec(hit.normal[0], hit.normal[1], hit.normal[2]),
      slope: hit.slope,
      walkable: hit.slope <= max + 1e-9,
    });
  }

  private buildApi(): BehaviorGrid {
    const g = this;
    const layerOf = (id: unknown): Layer | undefined => (typeof id === 'string' ? g.layerMap.get(id) : undefined);
    const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
    const vec = (v: unknown): v is readonly [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
    const toCell = (c: unknown): BlockCell | null | undefined => {
      if (typeof c !== 'object' || c === null) return undefined;
      const o = c as GridCellInput;
      const out: BlockCell = {};
      if (o.block !== undefined) out.block = o.block;
      if (o.rot !== undefined && o.rot !== 0) out.rot = o.rot as 90;
      if (o.variant !== undefined) out.variant = o.variant;
      if (o.corners !== undefined) {
        if (!Array.isArray(o.corners)) return undefined;
        out.corners = [...o.corners] as [number, number, number, number];
      }
      if (o.meta !== undefined) out.meta = { ...o.meta };
      return out;
    };
    const api: BehaviorGrid = {
      layers: () => Object.freeze([...g.layerMap.keys()]),
      get(layer, x, y, z) {
        const l = layerOf(layer);
        if (l === undefined || !int(x) || !int(y) || !int(z)) return null;
        return g.view(l, x, y, z);
      },
      set(layer, x, y, z, cell) {
        const c = toCell(cell);
        if (c === undefined || c === null) return false;
        const l = layerOf(layer);
        if (l === undefined || !int(x) || !int(y) || !int(z)) return false;
        return g.write(layer, x, y, z, c.block === undefined && c.meta === undefined ? null : c);
      },
      clear(layer, x, y, z) {
        return g.write(layer, x, y, z, null);
      },
      columnTop(layer, x, z) {
        const l = layerOf(layer);
        if (l === undefined || !int(x) || !int(z)) return null;
        return l.grid.columnTop(x, z);
      },
      surface(layer, position) {
        const l = layerOf(layer);
        if (l === undefined || !vec(position)) return null;
        return g.surfaceOf(l, position[0], position[1], position[2]);
      },
      columnSurface(layer, x, z) {
        const l = layerOf(layer);
        if (l === undefined || !int(x) || !int(z)) return null;
        const cs = l.grid.cellSize;
        const o = l.origin;
        return g.surfaceOf(l, o.x + (x + 0.5) * cs[0]!, o.y + l.grid.max[1] * cs[1]!, o.z + (z + 0.5) * cs[2]!);
      },
      worldToCell(layer, position) {
        const l = layerOf(layer);
        if (l === undefined || !vec(position)) return null;
        const [x, y, z] = worldToCell(l.origin, l.grid.cellSize, { x: position[0], y: position[1], z: position[2] });
        return freezeVec(x, y, z);
      },
      cellToWorld(layer, x, y, z) {
        const l = layerOf(layer);
        if (l === undefined || !int(x) || !int(y) || !int(z)) return null;
        const c = cellCenter(l.origin, l.grid.cellSize, x, y, z);
        return freezeVec(c.x, c.y, c.z);
      },
      meta(layer, x, y, z, key) {
        const l = layerOf(layer);
        if (l === undefined || !int(x) || !int(y) || !int(z) || typeof key !== 'string' || !g.fieldByKey.has(key)) return null;
        const v = g.view(l, x, y, z);
        const m = v?.meta ?? effectiveCellMeta(null, g.types, g.fields);
        return (m[key] as CellMetaValue | undefined) ?? null;
      },
      setMeta(layer, x, y, z, key, value) {
        const l = layerOf(layer);
        if (l === undefined || !int(x) || !int(y) || !int(z) || typeof key !== 'string') return false;
        const cur = l.grid.get(x, y, z);
        const meta: Record<string, CellMetaValue> = { ...(cur?.meta ?? {}) };
        if (value === null) delete meta[key];
        else meta[key] = value;
        const next: BlockCell = { ...(cur ?? {}) };
        if (Object.keys(meta).length > 0) next.meta = meta;
        else delete next.meta;
        return g.write(layer, x, y, z, next.block === undefined && next.meta === undefined ? null : next);
      },
      pick(origin, direction, maxDistance, layer) {
        if (!vec(origin) || !vec(direction)) return null;
        const o = { x: origin[0], y: origin[1], z: origin[2] };
        const d = { x: direction[0], y: direction[1], z: direction[2] };
        const max = typeof maxDistance === 'number' && Number.isFinite(maxDistance) && maxDistance > 0 ? Math.min(maxDistance, 10_000) : 100;
        let best: GridPick | null = null;
        for (const l of g.layerMap.values()) {
          if (layer !== undefined && l.entityId !== layer) continue;
          if (l.component.metadataOnly === true) continue;
          const hit = pickCell(l.grid, l.origin, o, d, max, (x, y, z) => l.grid.get(x, y, z)?.block !== undefined || l.covers.has(cellKeyOf(x, y, z)));
          if (hit === null) continue;
          if (best === null || hit.distance < best.distance) {
            best = Object.freeze({ layer: l.entityId, x: hit.cell[0], y: hit.cell[1], z: hit.cell[2], normal: freezeVec(hit.normal[0], hit.normal[1], hit.normal[2]), distance: hit.distance, point: freezeVec(hit.point.x, hit.point.y, hit.point.z) });
          }
        }
        return best;
      },
      neighbours(layer, x, y, z, diagonal) {
        const l = layerOf(layer);
        if (l === undefined || !int(x) || !int(y) || !int(z)) return Object.freeze([]);
        const out: GridVec3[] = [];
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
              const n = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
              if (n === 0 || (diagonal !== true && n !== 1)) continue;
              if (l.grid.inBounds(x + dx, y + dy, z + dz)) out.push(freezeVec(x + dx, y + dy, z + dz));
            }
        return Object.freeze(out);
      },
      regions(layer) {
        const l = layerOf(layer);
        return Object.freeze(l === undefined ? [] : [...l.grid.regions.keys()].sort());
      },
      region(layer, regionId) {
        const boxes = layerOf(layer)?.grid.regions.get(regionId);
        if (boxes === undefined) return null;
        const cells = regionCells(boxes, 65_536);
        return cells === null ? null : Object.freeze(cells.map(([x, y, z]) => freezeVec(x, y, z)));
      },
      inRegion(layer, regionId, x, y, z) {
        const boxes = layerOf(layer)?.grid.regions.get(regionId);
        return boxes !== undefined && int(x) && int(y) && int(z) && regionContains(boxes, x, y, z);
      },
      changes: () => g.previous,
      diff() {
        const layers: { layer: string; cells: (readonly [number, number, number, BlockCell | null])[] }[] = [];
        for (const l of g.layerMap.values()) {
          if (l.touched.size === 0) continue;
          const authored = BlockGrid.from(l.component, l.authored);
          const cells: (readonly [number, number, number, BlockCell | null])[] = [];
          for (const k of [...l.touched].sort((a, b) => a - b)) {
            const [x, y, z] = cellOfKey(k);
            const now = l.grid.get(x, y, z);
            const was = authored.get(x, y, z);
            if (JSON.stringify(now) === JSON.stringify(was)) continue;
            cells.push(Object.freeze([x, y, z, now === null ? null : JSON.parse(JSON.stringify(now)) as BlockCell] as const));
          }
          if (cells.length > 0) layers.push({ layer: l.entityId, cells });
        }
        return Object.freeze({ version: 1 as const, layers: Object.freeze(layers) });
      },
      applyDiff(diff) {
        if (typeof diff !== 'object' || diff === null || diff.version !== 1 || !Array.isArray(diff.layers)) return false;
        for (const entry of diff.layers) {
          if (!layerOf(entry?.layer) || !Array.isArray(entry.cells)) return false;
          for (const c of entry.cells) {
            if (!Array.isArray(c) || c.length !== 4) return false;
            const l = layerOf(entry.layer)!;
            if (g.refusal(l, c[0], c[1], c[2], c[3] === null ? null : canonicalBlockCell(c[3] as BlockCell)) !== null) return false;
          }
        }
        let ok = true;
        for (const entry of diff.layers) for (const c of entry.cells) {
          const l = layerOf(entry.layer)!;
          const now = l.grid.get(c[0], c[1], c[2]);
          if (JSON.stringify(now) === JSON.stringify(c[3] === null ? null : canonicalBlockCell(c[3] as BlockCell))) continue;
          ok = g.write(entry.layer, c[0], c[1], c[2], c[3] as BlockCell | null) && ok;
        }
        return ok;
      },
    };
    return Object.freeze(api);
  }
}


/** The chunk key of a cell column. */
export const gridChunkKey = (x: number, z: number): string => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
