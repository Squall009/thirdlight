/**
 * A block layer seen through its kits (`block-kit.ts`): the swapped cells
 * and edges every mesher, collider, live block and query reads, the stored
 * grid left as authored. Kept apart from the kit data rules so the block
 * model's modules load without the grid.
 *
 * Pure functions and a read-only view.
 */
import { blockTypeSlopes, type BlockCell, type BlockType } from './block-layers';
import type { BlockEdge } from './block-edges';
import { autoVariant, edgeAutoVariant, regionContains, type BlockGrid, type BlockGridReader, type BlockLayerMemory } from './block-grid';
import { kitZones, type BlockKitSwap, type BlockLayerKit, type KitZone } from './block-kit';

/** The look a swap shows for a cell or edge whose own look is `own` (its variant, or the one its weights pick). */
function swappedVariant(s: BlockKitSwap, to: BlockType, pinned: number | undefined, own: number): number | undefined {
  const mapped = s.variants?.[own];
  if (mapped !== undefined) return mapped;
  if (s.variant !== undefined) return s.variant;
  return pinned !== undefined && pinned < to.variants.length ? pinned : undefined;
}

/**
 * A cell shown under a swap (the layout kept: rotation, metadata, corners
 * where the target can slope); `own` is the cell's look (its variant, or the
 * one its weights pick where it stands).
 */
export function swapBlockCell(cell: BlockCell, s: BlockKitSwap, to: BlockType, own: number): BlockCell {
  const variant = swappedVariant(s, to, cell.variant, own);
  return {
    block: to.blockId,
    ...(cell.rot !== undefined ? { rot: cell.rot } : {}),
    ...(variant !== undefined ? { variant } : {}),
    ...(cell.corners !== undefined && blockTypeSlopes(to) ? { corners: cell.corners } : {}),
    ...(cell.meta !== undefined ? { meta: cell.meta } : {}),
  };
}

/** An edge piece shown under a swap (its turn and open state kept; `own` as for a cell). */
export function swapBlockEdge(edge: BlockEdge, s: BlockKitSwap, to: BlockType, own: number): BlockEdge {
  const variant = swappedVariant(s, to, edge.variant, own);
  return { block: to.blockId, ...(edge.rot !== undefined ? { rot: edge.rot } : {}), ...(variant !== undefined ? { variant } : {}), ...(edge.open === true ? { open: true } : {}) };
}

/** A zone's swap of one stored value: its index in the grid's palette (the stored index: no swap). */
const SAME = -1;
/** The swap depends on the place (a look picked by weight and mapped per look): one swapped value per look, picked per cell. */
const PER_LOOK = -2;

/**
 * A layer seen through its kits: every read a mesher, collider, live block or
 * query makes returns the swapped cells and edges; the stored grid is not
 * changed (its edits, saves and diffs stay the authored layout). Swapped
 * values are interned in the stored grid's palette, so palette indices stay
 * one space: a value read through the view is `valueOf` of the grid too.
 */
export class BlockKitView implements BlockGridReader {
  /** Per zone: stored palette index → swapped index, `SAME` or `PER_LOOK` (filled as the palette grows). */
  private readonly maps: Int32Array[];
  /** `PER_LOOK` values: (stored index × zones + zone) → the swapped index per look of the stored type. */
  private readonly perLook = new Map<number, Int32Array>();
  private readonly zones: readonly KitZone[];
  private readonly swaps: readonly (ReadonlyMap<string, { readonly from: BlockType; readonly swap: BlockKitSwap; readonly to: BlockType }>)[];
  /** The stored values whose swaps are known (`maps` grow as the palette does). */
  private known = 0;

  constructor(
    readonly grid: BlockGrid,
    zones: readonly KitZone[],
    types: ReadonlyMap<string, BlockType>,
  ) {
    this.zones = zones;
    this.swaps = zones.map((z) => {
      const m = new Map<string, { from: BlockType; swap: BlockKitSwap; to: BlockType }>();
      for (const t of types.values()) {
        const s = t.kits?.[z.kit];
        const to = s !== undefined ? types.get(s.block) : undefined;
        if (s !== undefined && to !== undefined && (to.placement === 'edge') === (t.placement === 'edge')) m.set(t.blockId, { from: t, swap: s, to });
      }
      return m;
    });
    this.maps = zones.map(() => new Int32Array(0));
  }

  get min(): [number, number, number] {
    return this.grid.min;
  }
  get max(): [number, number, number] {
    return this.grid.max;
  }
  get cellSize(): [number, number, number] {
    return this.grid.cellSize;
  }
  get metadataOnly(): boolean {
    return this.grid.metadataOnly;
  }
  get regions(): Map<string, number[][]> {
    return this.grid.regions;
  }
  get size(): number {
    return this.grid.size;
  }
  get edgeCount(): number {
    return this.grid.edgeCount;
  }

  /** Make the swaps of every stored value known (each swapped value interned): palette indices read after it are listed. */
  private ensure(): void {
    const palette = this.grid.paletteCells();
    if (this.known >= palette.length) return;
    const n = palette.length;
    for (let z = 0; z < this.zones.length; z++) {
      const next = new Int32Array(Math.max(n, 16) * 2).fill(SAME);
      next.set(this.maps[z]!.subarray(0, this.known));
      this.maps[z] = next;
    }
    for (let i = this.known; i < n; i++) {
      const v = palette[i]!;
      for (let z = 0; z < this.zones.length; z++) this.maps[z]![i] = this.placeFree(z, i, v);
    }
    // Interning above may have grown the palette: swapped values map to themselves.
    this.known = n;
    if (this.grid.paletteCells().length > n) this.ensure();
  }

  /** A zone's swap of stored value `i` (every swapped value interned now, so walks never grow the palette). */
  private placeFree(zone: number, i: number, v: BlockCell): number {
    if (v.block === undefined) return SAME;
    const hit = this.swaps[zone]!.get(v.block);
    if (hit === undefined) return SAME;
    const swapped = (own: number): number => (hit.from.placement === 'edge' ? this.grid.internEdge(swapBlockEdge(v as unknown as BlockEdge, hit.swap, hit.to, own)) : this.grid.intern(swapBlockCell(v, hit.swap, hit.to, own)));
    // Only the look can depend on the place: a look picked by weight and mapped per look.
    if (hit.swap.variants !== undefined && v.variant === undefined && hit.from.variants.length > 1) {
      const looks = new Int32Array(hit.from.variants.length);
      for (let own = 0; own < looks.length; own++) looks[own] = swapped(own);
      this.perLook.set(i * this.zones.length + zone, looks);
      return PER_LOOK;
    }
    return swapped(v.variant ?? 0);
  }

  private inZone(zone: number, x: number, y: number, z: number, axis: number): boolean {
    const boxes = this.zones[zone]!.boxes;
    if (boxes === null) return true;
    if (regionContains(boxes, x, y, z)) return true;
    // An edge piece on a region's outline goes with it (a wall round the room).
    return axis === 0 ? regionContains(boxes, x - 1, y, z) : axis === 1 ? regionContains(boxes, x, y, z - 1) : false;
  }

  /** The index shown for a stored one at a place (axis −1: a cell). */
  private shown(i: number, x: number, y: number, z: number, axis: number): number {
    if (i < 0) return i;
    if (i >= this.known) this.ensure();
    // The regions' kits win over the layer's, a later region over an earlier one.
    for (let zone = this.zones.length - 1; zone >= 0; zone--) {
      const m = this.maps[zone]![i]!;
      if (m === SAME || !this.inZone(zone, x, y, z, axis)) continue;
      if (m !== PER_LOOK) return m;
      const from = this.swaps[zone]!.get(this.grid.valueOf(i).block!)!.from;
      return this.perLook.get(i * this.zones.length + zone)![axis < 0 ? autoVariant(from, x, y, z) : edgeAutoVariant(from, x, y, z, axis)]!;
    }
    return i;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return this.grid.inBounds(x, y, z);
  }
  edgeInBounds(x: number, y: number, z: number, axis: number): boolean {
    return this.grid.edgeInBounds(x, y, z, axis);
  }
  valueOf(index: number): BlockCell {
    return this.grid.valueOf(index);
  }
  edgeValueOf(index: number): BlockEdge {
    return this.grid.edgeValueOf(index);
  }
  paletteCells(): readonly BlockCell[] {
    this.ensure();
    return this.grid.paletteCells();
  }
  indexAt(x: number, y: number, z: number): number {
    return this.shown(this.grid.indexAt(x, y, z), x, y, z, -1);
  }
  get(x: number, y: number, z: number): BlockCell | null {
    const i = this.indexAt(x, y, z);
    return i < 0 ? null : this.grid.valueOf(i);
  }
  edgeIndexAt(x: number, y: number, z: number, axis: number): number {
    return this.shown(this.grid.edgeIndexAt(x, y, z, axis), x, y, z, axis);
  }
  edgeAt(x: number, y: number, z: number, axis: number): BlockEdge | null {
    const i = this.edgeIndexAt(x, y, z, axis);
    return i < 0 ? null : this.grid.edgeValueOf(i);
  }
  forEach(cb: (x: number, y: number, z: number, index: number) => void): void {
    this.grid.forEach((x, y, z, i) => cb(x, y, z, this.shown(i, x, y, z, -1)));
  }
  forEachInChunk(ck: string, cb: (x: number, y: number, z: number, index: number) => void): void {
    this.grid.forEachInChunk(ck, (x, y, z, i) => cb(x, y, z, this.shown(i, x, y, z, -1)));
  }
  forEachInColumn(x: number, z: number, cb: (y: number, index: number) => void): void {
    this.grid.forEachInColumn(x, z, (y, i) => cb(y, this.shown(i, x, y, z, -1)));
  }
  forEachEdgeInChunk(ck: string, cb: (x: number, y: number, z: number, axis: number, index: number) => void): void {
    this.grid.forEachEdgeInChunk(ck, (x, y, z, axis, i) => cb(x, y, z, axis, this.shown(i, x, y, z, axis)));
  }
  forEachEdge(cb: (x: number, y: number, z: number, axis: number, index: number) => void): void {
    this.grid.forEachEdge((x, y, z, axis, i) => cb(x, y, z, axis, this.shown(i, x, y, z, axis)));
  }
  columnTop(x: number, z: number, anyCell = false): number | null {
    return this.grid.columnTop(x, z, anyCell);
  }
  chunkKeys(): string[] {
    return this.grid.chunkKeys();
  }
  chunkPaint(cx: number, cz: number): Uint8Array | null {
    return this.grid.chunkPaint(cx, cz);
  }
  chunkWallPaint(cx: number, cz: number): ReturnType<BlockGrid['chunkWallPaint']> {
    return this.grid.chunkWallPaint(cx, cz);
  }
  hasPaint(): boolean {
    return this.grid.hasPaint();
  }
  memory(): BlockLayerMemory {
    return this.grid.memory();
  }
}

/**
 * A layer as its kits show it: the grid itself when no kit swaps any block
 * type (the common case costs nothing), else a {@link BlockKitView}.
 */
export function blockKitView(grid: BlockGrid, kits: readonly BlockLayerKit[] | undefined, types: ReadonlyMap<string, BlockType>): BlockGridReader {
  const zones = kitZones(kits, grid.regions).filter((z) => {
    for (const t of types.values()) if (t.kits?.[z.kit] !== undefined) return true;
    return false;
  });
  return zones.length === 0 ? grid : new BlockKitView(grid, zones, types);
}

