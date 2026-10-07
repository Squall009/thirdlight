/**
 * The live blocks of the loaded block layers: for each cell whose block type
 * is `live` and whose look is a prefab, that prefab as real objects of the
 * running game (`block-live.ts` in the project model has the rules and ids).
 *
 * Objects exist only for the cells that need them: a cell written, cleared
 * or turned is the only one looked at again (a loaded, reset or restored
 * layer is scanned once), and a cell whose prefab and rotation did not change
 * keeps its objects, scripts and state. The objects' ids are the cell's, so a
 * cell set again gets the same ids and nothing is ever allocated from the
 * scene's id space.
 *
 * Live edge pieces (a door on a cell edge) work the same way, keyed by
 * their edge, their root standing on the edge (`liveEdgePlacement`).
 *
 * Pure bookkeeping: `sync` says which objects go and which come (in a fixed
 * order, so a replay spawns the same); the runtime adds and removes them
 * through its spawned-copy path (colliders, scripts, gameplay blocks, the
 * renderer's spawned list), where the root's model stays with the chunk mesh.
 */
import {
  LIVE_BLOCK_ROOT_MERGED,
  autoVariant,
  blockTypeIsEdge,
  blockTypeLive,
  edgeAutoVariant,
  cellKeyOf,
  cellOfKey,
  liveBlockIds,
  liveBlockPlacement,
  liveBlockPrefix,
  liveBlockRootId,
  liveEdgePlacement,
  liveEdgeRootId,
  rotatedFootprint,
  type BlockCell,
  type BlockEdge,
  type BlockGrid,
  type BlockType,
  type EntityV3,
  type PrefabDefinition,
} from '@thirdlight/project-model';

import { expandPrefab } from './spawn';

/** One cell's live objects. */
interface LiveRecord {
  readonly prefabId: string;
  readonly rot: number;
  /** The root first, then the prefab's other objects in its order. */
  readonly ids: readonly string[];
}

interface LiveLayer {
  readonly prefix: string;
  /** Anchor cell key → its objects. */
  readonly cells: Map<number, LiveRecord>;
  /** Scan every cell at the next sync (loaded, reset or restored). */
  full: boolean;
  /** Cells written since the last sync. */
  readonly dirty: Set<number>;
  /** Edge key (`edgeKeyOf`) → its edge piece's objects. */
  readonly edges: Map<number, LiveRecord>;
  /** Edges written since the last sync. */
  readonly dirtyEdges: Set<number>;
}

/** One number per edge (a cell key and the line it stands on). */
export const edgeKeyOf = (x: number, y: number, z: number, axis: number): number => cellKeyOf(x, y, z) * 2 + axis;
const edgeOfKey = (k: number): [number, number, number, number] => {
  const [x, y, z] = cellOfKey(Math.floor(k / 2));
  return [x, y, z, k % 2];
};

/** What a sync reads of a layer. */
export interface LiveLayerSource {
  readonly grid: BlockGrid;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
}

/** The objects a sync takes out and puts in (removals first), and the cells whose ids another object holds. */
export interface LiveBlockChanges {
  readonly remove: readonly string[];
  readonly add: readonly EntityV3[];
  readonly refused: readonly string[];
}

const CELL_PART = /^(m?\d+)_(m?\d+)_(m?\d+)[xz]?(-\d+)?$/;

export class LiveBlocks {
  private readonly layers = new Map<string, LiveLayer>();
  /** Every live object → its layer and anchor cell (or edge: `axis` 0 or 1, `key` the edge's). */
  private readonly byId = new Map<string, { readonly layer: string; readonly key: number; readonly axis: number }>();
  /** Objects whose layer left (the runtime removes them at once). */
  private gone: string[] = [];

  constructor(
    private readonly types: ReadonlyMap<string, BlockType>,
    private readonly prefabs: ReadonlyMap<string, PrefabDefinition>,
  ) {}

  /** Whether any of these block types is live (a project without one keeps no bookkeeping). */
  static anyLive(types: Iterable<BlockType>): boolean {
    for (const t of types) if (blockTypeLive(t)) return true;
    return false;
  }

  /** The live objects in the game now. */
  get count(): number {
    return this.byId.size;
  }

  /** Whether a sync has anything to do. */
  get pending(): boolean {
    if (this.gone.length > 0) return true;
    for (const l of this.layers.values()) if (l.full || l.dirty.size > 0 || l.dirtyEdges.size > 0) return true;
    return false;
  }

  addLayer(layerId: string): void {
    if (!this.layers.has(layerId)) this.layers.set(layerId, { prefix: liveBlockPrefix(layerId), cells: new Map(), full: true, dirty: new Set(), edges: new Map(), dirtyEdges: new Set() });
  }

  /** A layer left the game: its objects go with it (`takeGone`). */
  removeLayer(layerId: string): void {
    const l = this.layers.get(layerId);
    if (l === undefined) return;
    for (const r of l.cells.values()) this.forget(r, this.gone);
    for (const r of l.edges.values()) this.forget(r, this.gone);
    this.layers.delete(layerId);
  }

  /** The objects of layers that left since the last call. */
  takeGone(): string[] {
    const out = this.gone;
    this.gone = [];
    return out;
  }

  /** Every cell of a layer is looked at again at the next sync (reloaded or restored cells). */
  markFull(layerId: string): void {
    const l = this.layers.get(layerId);
    if (l !== undefined) l.full = true;
  }

  /** A written cell: looked at again at the next sync when its block before or after is live. */
  written(layerId: string, x: number, y: number, z: number, before: BlockCell | null, after: BlockCell | null): void {
    if (!this.isLive(before) && !this.isLive(after)) return;
    this.layers.get(layerId)?.dirty.add(cellKeyOf(x, y, z));
  }

  /** A written edge: looked at again at the next sync when its piece before or after is live. */
  writtenEdge(layerId: string, x: number, y: number, z: number, axis: number, before: BlockEdge | null, after: BlockEdge | null): void {
    if (!this.isLive(before) && !this.isLive(after)) return;
    this.layers.get(layerId)?.dirtyEdges.add(edgeKeyOf(x, y, z, axis));
  }

  /**
   * A new run: every live object goes (returned) and every cell is spawned
   * again at the next sync, so the run starts from fresh objects as it does
   * from the authored cells.
   */
  restart(): string[] {
    const out: string[] = [...this.gone];
    this.gone = [];
    for (const l of this.layers.values()) {
      for (const r of l.cells.values()) this.forget(r, out);
      for (const r of l.edges.values()) this.forget(r, out);
      l.cells.clear();
      l.dirty.clear();
      l.edges.clear();
      l.dirtyEdges.clear();
      l.full = true;
    }
    return out;
  }

  /** The cell a live object belongs to (its block's anchor; for an edge piece the edge's: `axis` 0 or 1), or null. */
  cellOf(id: string): { layer: string; x: number; y: number; z: number; axis?: number } | null {
    const at = this.byId.get(id);
    if (at === undefined) return null;
    if (at.axis >= 0) {
      const [x, y, z, axis] = edgeOfKey(at.key);
      return { layer: at.layer, x, y, z, axis };
    }
    const [x, y, z] = cellOfKey(at.key);
    return { layer: at.layer, x, y, z };
  }

  /** Whether an id is a live object now. */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /**
   * Whether an id has the shape of a live object of a loaded layer (a save
   * may name one that a restored cell is about to spawn).
   */
  mayBeLive(id: string): boolean {
    for (const l of this.layers.values()) if (id.length > l.prefix.length + 1 && id.startsWith(`${l.prefix}-`) && CELL_PART.test(id.slice(l.prefix.length + 1))) return true;
    return false;
  }

  /** The root id a cell's live block has (whether or not it is spawned yet), or null when the cell shows no live prefab look. */
  rootIdOf(layerId: string, x: number, y: number, z: number, cell: BlockCell | null): string | null {
    return this.wanted(cell, x, y, z) === null ? null : liveBlockRootId(layerId, x, y, z);
  }

  /** The root id an edge's live piece has, or null when the edge shows no live prefab look. */
  edgeRootIdOf(layerId: string, x: number, y: number, z: number, axis: number, edge: BlockEdge | null): string | null {
    return this.wantedEdge(edge, x, y, z, axis) === null ? null : liveEdgeRootId(layerId, x, y, z, axis);
  }

  /**
   * The objects to remove and to add for the cells written since the last
   * call. `taken` names ids already in the game; a cell whose ids are taken
   * by another object spawns nothing (listed in `refused`).
   */
  sync(source: (layerId: string) => LiveLayerSource | undefined, taken: (id: string) => boolean, entityRefKeys?: (behaviorId: string) => readonly string[] | undefined): LiveBlockChanges {
    const remove: string[] = this.gone;
    this.gone = [];
    const add: EntityV3[] = [];
    const refused: string[] = [];
    const removing = new Set<string>();
    const spawns: { layerId: string; l: LiveLayer; src: LiveLayerSource; key: number; axis: number; want: NonNullable<ReturnType<LiveBlocks['wanted']>> }[] = [];
    for (const [layerId, l] of this.layers) {
      if (!l.full && l.dirty.size === 0 && l.dirtyEdges.size === 0) continue;
      const src = source(layerId);
      if (src === undefined) continue;
      const keys: number[] = [];
      if (l.full) {
        const seen = new Set<number>();
        // Only cells of a live block type are looked at (a layer without any is not walked at all).
        const live = src.grid.paletteCells().map((c) => this.isLive(c));
        if (live.includes(true)) {
          src.grid.forEach((x, y, z, idx) => {
            if (live[idx] !== true) return;
            const k = cellKeyOf(x, y, z);
            if (this.wanted(src.grid.valueOf(idx), x, y, z) !== null) {
              seen.add(k);
              keys.push(k);
            }
          });
        }
        for (const k of l.cells.keys()) if (!seen.has(k)) keys.push(k);
      } else keys.push(...l.dirty);
      // Edges: the same walk over the edge pieces.
      const edgeKeys: number[] = [];
      if (l.full) {
        const seen = new Set<number>();
        if (src.grid.edgeCount > 0) {
          src.grid.forEachEdge((x, y, z, axis, idx) => {
            if (this.wantedEdge(src.grid.edgeValueOf(idx), x, y, z, axis) === null) return;
            const k = edgeKeyOf(x, y, z, axis);
            seen.add(k);
            edgeKeys.push(k);
          });
        }
        for (const k of l.edges.keys()) if (!seen.has(k)) edgeKeys.push(k);
      } else edgeKeys.push(...l.dirtyEdges);
      l.full = false;
      l.dirty.clear();
      l.dirtyEdges.clear();
      keys.sort((a, b) => a - b);
      edgeKeys.sort((a, b) => a - b);
      const follow = (records: Map<number, LiveRecord>, k: number, axis: number, want: ReturnType<LiveBlocks['wanted']>): void => {
        const had = records.get(k);
        if (had !== undefined && want !== null && had.prefabId === want.def.prefabId && had.rot === want.rot) return;
        if (had !== undefined) {
          records.delete(k);
          this.forget(had, remove);
          for (const id of had.ids) removing.add(id);
        }
        if (want !== null) spawns.push({ layerId, l, src, key: k, axis, want });
      };
      for (const k of keys) {
        const [x, y, z] = cellOfKey(k);
        follow(l.cells, k, -1, this.wanted(src.grid.get(x, y, z), x, y, z));
      }
      for (const k of edgeKeys) {
        const [x, y, z, axis] = edgeOfKey(k);
        follow(l.edges, k, axis, this.wantedEdge(src.grid.edgeAt(x, y, z, axis), x, y, z, axis));
      }
    }
    for (const s of spawns) {
      const edge = s.axis >= 0;
      const [x, y, z] = edge ? edgeOfKey(s.key) : cellOfKey(s.key);
      const ids = liveBlockIds(edge ? liveEdgeRootId(s.layerId, x, y, z, s.axis) : liveBlockRootId(s.layerId, x, y, z), s.want.def.entities.length);
      if (ids.some((id) => taken(id) && !removing.has(id))) {
        refused.push(ids[0]!);
        continue;
      }
      const placement = edge ? liveEdgePlacement(s.src.origin, s.src.grid.cellSize, x, y, z, s.axis, s.want.rot) : liveBlockPlacement(s.src.origin, s.src.grid.cellSize, rotatedFootprint(s.want.type, s.want.rot), s.want.rot, x, y, z);
      const entities = expandPrefab(s.want.def, ids, placement, entityRefKeys);
      // The root's model is drawn merged into the chunk with the other blocks.
      const root = entities[0]!.components as unknown as Record<string, unknown>;
      for (const c of LIVE_BLOCK_ROOT_MERGED) delete root[c];
      add.push(...entities);
      (edge ? s.l.edges : s.l.cells).set(s.key, { prefabId: s.want.def.prefabId, rot: s.want.rot, ids });
      for (const id of ids) this.byId.set(id, { layer: s.layerId, key: s.key, axis: s.axis });
    }
    return { remove, add, refused };
  }

  /** The prefab a cell spawns, or null (no live block, or its look is not a prefab of this game). */
  private wanted(cell: BlockCell | null, x: number, y: number, z: number): { type: BlockType; def: PrefabDefinition; rot: number } | null {
    if (cell?.block === undefined) return null;
    const type = this.types.get(cell.block);
    if (type === undefined || !blockTypeLive(type)) return null;
    const look = type.variants[cell.variant ?? autoVariant(type, x, y, z)];
    const def = look?.prefab !== undefined ? this.prefabs.get(look.prefab) : undefined;
    return def === undefined ? null : { type, def, rot: cell.rot ?? 0 };
  }

  /** The prefab an edge spawns, or null (no live edge piece, or its look is not a prefab of this game). */
  private wantedEdge(edge: BlockEdge | null, x: number, y: number, z: number, axis: number): { type: BlockType; def: PrefabDefinition; rot: number } | null {
    if (edge === null) return null;
    const type = this.types.get(edge.block);
    if (type === undefined || !blockTypeIsEdge(type) || !blockTypeLive(type)) return null;
    const look = type.variants[edge.variant ?? edgeAutoVariant(type, x, y, z, axis)];
    const def = look?.prefab !== undefined ? this.prefabs.get(look.prefab) : undefined;
    return def === undefined ? null : { type, def, rot: edge.rot ?? 0 };
  }

  private isLive(cell: BlockCell | BlockEdge | null): boolean {
    if (cell?.block === undefined) return false;
    const type = this.types.get(cell.block);
    return type !== undefined && blockTypeLive(type);
  }

  private forget(r: LiveRecord, into: string[]): void {
    for (const id of r.ids) {
      this.byId.delete(id);
      into.push(id);
    }
  }
}
