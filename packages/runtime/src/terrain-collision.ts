/**
 * Terrain collision: the loaded terrains' tiles as static colliders on the
 * 3D physics port, added and removed in batches with the block layers'
 * chunk colliders (`RuntimeGrid.flushCollision`).
 *
 * A tile is one Rapier heightfield. Rapier's heightfield has no holes, so a
 * tile with holes is cut into patches of {@link TERRAIN_COLLIDER_PATCH_CELLS}
 * cells: patches without holes are merged into rectangles, one heightfield
 * each; a patch with some is a triangle mesh of its whole cells (within the
 * port's mesh limits); a patch all hole is nothing. Every cell is two triangles split from its (+x, min z)
 * corner to its (min x, +z) corner — the heightfield's own split, the
 * renderer's finest level and `TerrainField.heightAt` — so the ground the
 * character stands on is the ground drawn near it and the ground a query
 * reports.
 *
 * Tiles with data arrive decoded from the page (`addTiles`, keyed by their
 * digest: the page reads and decodes them, the simulation never touches the
 * network); a tile without data is flat. A terrain whose tile has not
 * arrived yet has no collider there until it does. Which tiles get colliders
 * is a ring (`ring`): a streamed terrain's collision ring (`world-stream.ts`),
 * every tile of one that does not stream.
 *
 * A terrain with `collision: false` has none (scenery the player never
 * reaches); neither has any terrain without a 3D port.
 */
import { TERRAIN_PAINT_BYTES, TERRAIN_WEIGHT_BYTES, terrainFlatStep, terrainHeightOf, terrainTileKey, terrainTileSize, type EntityV3, type TerrainComponent } from '@thirdlight/project-model';

import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';

/** Cells along a side of a holed tile's patch: a patch's mesh (17² vertices, 512 triangles) is within the port's mesh limits. */
export const TERRAIN_COLLIDER_PATCH_CELLS = 16;

/** A decoded tile as collision reads it (a `TerrainTile` is one). */
export interface TerrainCollisionTile {
  readonly samples: number;
  /** 16-bit height steps, row by row from min z. */
  readonly heights: Uint16Array;
  /** One bit per cell, row by row (null: none). */
  readonly holes: Uint8Array | null;
}

/**
 * A terrain's tile on the page's way to the simulation, by digest: what
 * collision reads, and the layer weights and hand paint `ctx.surface`
 * answers from (absent or null: none, all layer 0).
 */
export interface TerrainTileData extends TerrainCollisionTile {
  readonly digest: string;
  readonly weights?: Uint8Array | null;
  readonly paint?: Uint8Array | null;
}

/**
 * A tile's layer weights or hand paint handed over after its heights (a
 * page handing tiles to a worker spreads these larger arrays over frames;
 * the tile answers as all layer 0 until they arrive). Ignored for a tile
 * not held.
 */
export interface TerrainLayerData {
  readonly digest: string;
  readonly layer: 'weights' | 'paint';
  readonly bytes: Uint8Array;
}

/** A tile as the simulation holds it (a `TerrainTile`'s shape: the surface query reads it as one). */
export interface TerrainSimTile extends TerrainCollisionTile {
  weights: Uint8Array | null;
  paint: Uint8Array | null;
}

/** One collider of a tile: its shape and where its origin sits from the tile's min corner (metres, the terrain's frame). */
export interface TerrainColliderPiece {
  readonly shape: { type: 'heightfield'; cellsX: number; cellsZ: number; cellX: number; cellZ: number; heights: Float32Array } | { type: 'mesh'; vertices: Float32Array; indices: Uint32Array };
  readonly x: number;
  readonly z: number;
}

const holeBit = (holes: Uint8Array, c: number): boolean => (holes[c >> 3]! & (1 << (c & 7))) !== 0;

/**
 * A tile's colliders: one heightfield when it has no holes, else its
 * patches (heightfields, meshes of the whole cells, nothing where all is
 * hole). Heights are metres above the terrain's object for `range`.
 */
export function terrainColliderPieces(tile: TerrainCollisionTile, spacing: number, range: readonly number[]): TerrainColliderPiece[] {
  const s = tile.samples;
  const n = s - 1;
  const low = terrainHeightOf(range, 0);
  const step = terrainHeightOf(range, 1) - low;
  const h = tile.heights;
  const metres = (i: number): number => low + h[i]! * step;
  const holes = tile.holes;
  let any = false;
  if (holes !== null) for (let i = 0; i < holes.length && !any; i++) any = holes[i] !== 0;
  const out: TerrainColliderPiece[] = [];
  /** A heightfield over cells [cx0, cx0 + w) × [cz0, cz0 + d): heights column by column (the port's order). */
  const heightfield = (cx0: number, cz0: number, w: number, d: number): void => {
    const heights = new Float32Array((w + 1) * (d + 1));
    for (let x = 0, o = 0; x <= w; x++) for (let z = 0, i = cz0 * s + cx0 + x; z <= d; z++, o++, i += s) heights[o] = low + h[i]! * step;
    out.push({ shape: { type: 'heightfield', cellsX: w, cellsZ: d, cellX: spacing, cellZ: spacing, heights }, x: cx0 * spacing, z: cz0 * spacing });
  };
  if (!any) {
    heightfield(0, 0, n, n);
    return out;
  }
  const P = Math.min(TERRAIN_COLLIDER_PATCH_CELLS, n);
  const across = Math.ceil(n / P);
  // Each patch: 0 whole, 1 cut, 2 all hole (cells counted once).
  const state = new Uint8Array(across * across);
  const cuts = new Uint32Array(across * across);
  for (let pz = 0; pz < across; pz++) {
    for (let px = 0; px < across; px++) {
      const w = Math.min(P, n - px * P);
      const d = Math.min(P, n - pz * P);
      let cut = 0;
      for (let cz = pz * P; cz < pz * P + d; cz++) for (let cx = px * P; cx < px * P + w; cx++) if (holeBit(holes!, cz * n + cx)) cut += 1;
      cuts[pz * across + px] = cut;
      state[pz * across + px] = cut === 0 ? 0 : cut === w * d ? 2 : 1;
    }
  }
  // Whole patches merged into rectangles (greedy: as wide, then as deep as they go), each one heightfield.
  const taken = new Uint8Array(across * across);
  for (let pz = 0; pz < across; pz++) {
    for (let px = 0; px < across; px++) {
      if (state[pz * across + px] !== 0 || taken[pz * across + px] !== 0) continue;
      let w = 1;
      while (px + w < across && state[pz * across + px + w] === 0 && taken[pz * across + px + w] === 0) w += 1;
      let d = 1;
      const rowFree = (z: number): boolean => {
        for (let x = px; x < px + w; x++) if (state[z * across + x] !== 0 || taken[z * across + x] !== 0) return false;
        return true;
      };
      while (pz + d < across && rowFree(pz + d)) d += 1;
      for (let z = pz; z < pz + d; z++) for (let x = px; x < px + w; x++) taken[z * across + x] = 1;
      heightfield(px * P, pz * P, Math.min(w * P, n - px * P), Math.min(d * P, n - pz * P));
    }
  }
  // Cut patches: a mesh of their whole cells.
  for (let pz = 0; pz < across; pz++) {
    for (let px = 0; px < across; px++) {
      if (state[pz * across + px] !== 1) continue;
      const cx0 = px * P;
      const cz0 = pz * P;
      const w = Math.min(P, n - cx0);
      const d = Math.min(P, n - cz0);
      const vertices = new Float32Array((w + 1) * (d + 1) * 3);
      for (let z = 0, v = 0; z <= d; z++) {
        for (let x = 0; x <= w; x++, v += 3) {
          vertices[v] = x * spacing;
          vertices[v + 1] = metres((cz0 + z) * s + cx0 + x);
          vertices[v + 2] = z * spacing;
        }
      }
      const indices = new Uint32Array((w * d - cuts[pz * across + px]!) * 6);
      let o = 0;
      for (let z = 0; z < d; z++) {
        for (let x = 0; x < w; x++) {
          if (holeBit(holes!, (cz0 + z) * n + cx0 + x)) continue;
          const a = z * (w + 1) + x;
          const b = a + 1;
          const c = a + w + 1;
          // Counter-clockwise from above, split from (+x, min z) to (min x, +z).
          indices[o++] = a;
          indices[o++] = c;
          indices[o++] = b;
          indices[o++] = b;
          indices[o++] = c;
          indices[o++] = c + 1;
        }
      }
      out.push({ shape: { type: 'mesh', vertices, indices }, x: cx0 * spacing, z: cz0 * spacing });
    }
  }
  return out;
}

/** The id of one terrain collider piece on the physics port (the terrain's entity before the `#`). */
export function terrainColliderId(entityId: string, x: number, z: number, piece: number): string {
  return `${entityId}#terrain:${x},${z}:${piece}`;
}

/** Terrain collision in a play's diagnostics (`runtime.terrainMemory`). */
export interface TerrainCollisionDiagnostics {
  /** Tiles' data the simulation holds (heights, holes, layer weights and paint) and their bytes; of those, the weights' and paint's. */
  tiles: number;
  bytes: number;
  layerBytes: number;
  /** Colliders on the port, and the tiles they make up. */
  colliders: number;
  tilesWithColliders: number;
  /** The last flush that built colliders: tiles built and milliseconds (shapes made and handed to the port). */
  lastBuild: { tiles: number; ms: number } | null;
  /** Tiles named with data (in the collision ring, when the terrain streams) that have no collider because their data has not arrived. */
  waiting: number;
}

interface TerrainState {
  readonly entityId: string;
  readonly component: TerrainComponent;
  readonly origin: readonly [number, number, number];
  /** Per tile key: the digest its colliders were built from ('' flat) and their ids. */
  readonly built: Map<string, { digest: string; ids: string[] }>;
}

export class TerrainColliders {
  private readonly terrains = new Map<string, TerrainState>();
  private readonly tiles = new Map<string, TerrainSimTile>();
  private dirty = new Set<string>();
  private tileChanges = 0;
  private lastBuild: { tiles: number; ms: number } | null = null;

  /**
   * `ring` says which tiles have colliders (entity, tile x, z); absent:
   * every tile.
   */
  constructor(private readonly ring: ((entityId: string, x: number, z: number) => boolean) | null = null) {}

  /** The terrains of entities that carry `terrain` with collision on; returns their ids. */
  add(entities: readonly EntityV3[]): string[] {
    const added: string[] = [];
    for (const e of entities) {
      const c = (e.components as { terrain?: TerrainComponent }).terrain;
      if (c === undefined || c.collision === false || this.terrains.has(e.id)) continue;
      const p = e.components.transform?.position ?? [0, 0, 0];
      this.terrains.set(e.id, { entityId: e.id, component: c, origin: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], built: new Map() });
      this.dirty.add(e.id);
      added.push(e.id);
    }
    return added;
  }

  /** Forget unloaded terrains; returns their collider ids (the caller removes them from the port). Tiles no terrain names any more are let go. */
  remove(ids: ReadonlySet<string>): string[] {
    const out: string[] = [];
    const gone = new Set<string>();
    for (const id of ids) {
      const t = this.terrains.get(id);
      if (t === undefined) continue;
      for (const b of t.built.values()) out.push(...b.ids);
      for (const r of t.component.tiles) if (r.data !== undefined) gone.add(r.data);
      this.terrains.delete(id);
      this.dirty.delete(id);
    }
    // Only the removed terrains' tiles: tiles sent ahead for a scene still loading stay.
    for (const s of this.terrains.values()) for (const r of s.component.tiles) if (r.data !== undefined) gone.delete(r.data);
    for (const d of gone) this.tiles.delete(d);
    if (gone.size > 0) this.tileChanges += 1;
    return out;
  }

  /** The tile data held for a digest (the surface query reads the same tiles collision does). */
  tileOf(digest: string): TerrainSimTile | undefined {
    return this.tiles.get(digest);
  }

  /** Counts changes to the tiles held: a reader keeping something made from them makes it again when this moves. */
  get tileVersion(): number {
    return this.tileChanges;
  }

  /** Decoded tiles arrived (by digest): terrains naming them get their colliders at the next flush. */
  addTiles(tiles: readonly TerrainTileData[]): void {
    const got = new Set<string>();
    for (const t of tiles) {
      this.tiles.set(t.digest, { samples: t.samples, heights: t.heights, holes: t.holes, weights: t.weights ?? null, paint: t.paint ?? null });
      got.add(t.digest);
    }
    if (tiles.length > 0) this.tileChanges += 1;
    for (const s of this.terrains.values()) if (s.component.tiles.some((r) => r.data !== undefined && got.has(r.data))) this.dirty.add(s.entityId);
  }

  /** Layer weights or paint of tiles held arrived (by digest). */
  addLayerData(items: readonly TerrainLayerData[]): void {
    let changed = false;
    for (const d of items) {
      const t = this.tiles.get(d.digest);
      const n = t === undefined ? 0 : t.samples * t.samples;
      if (t === undefined || d.bytes.length !== n * (d.layer === 'weights' ? TERRAIN_WEIGHT_BYTES : TERRAIN_PAINT_BYTES)) continue;
      t[d.layer] = d.bytes;
      changed = true;
    }
    if (changed) this.tileChanges += 1;
  }

  /**
   * The page let go of tiles (by digest): their data goes. Colliders
   * already built from it stay until their tile leaves the collision ring.
   */
  dropTiles(digests: readonly string[]): void {
    for (const d of digests) this.tiles.delete(d);
    if (digests.length > 0) this.tileChanges += 1;
  }

  /** A terrain's collision ring changed: its tiles are looked at again at the next flush. */
  markDirty(entityId: string): void {
    if (this.terrains.has(entityId)) this.dirty.add(entityId);
  }

  get pending(): boolean {
    return this.dirty.size > 0;
  }

  /** Build the colliders of the terrains changed since the last flush (one remove, one add). */
  flush(port: PhysicsPort3D | undefined): void {
    if (this.dirty.size === 0) return;
    const dirty = [...this.dirty].sort();
    this.dirty = new Set();
    if (port === undefined) return;
    const t0 = performance.now();
    const remove: string[] = [];
    const add: StaticColliderSpec3D[] = [];
    let built = 0;
    for (const id of dirty) {
      const t = this.terrains.get(id);
      if (t === undefined) continue;
      const c = t.component;
      const size = terrainTileSize(c);
      const wanted = new Set<string>();
      for (const ref of c.tiles) {
        const key = terrainTileKey(ref.x, ref.z);
        if (this.ring !== null && !this.ring(id, ref.x, ref.z)) continue;
        const digest = ref.data ?? '';
        const tile = ref.data === undefined ? null : this.tiles.get(ref.data);
        // A tile with data not here yet keeps what it had (nothing, or an older shape) until it arrives.
        if (ref.data !== undefined && tile === undefined) {
          if (t.built.has(key)) wanted.add(key);
          continue;
        }
        wanted.add(key);
        const had = t.built.get(key);
        if (had !== undefined && had.digest === digest) continue;
        if (had !== undefined) remove.push(...had.ids);
        const pieces = tile === null || tile === undefined ? flatPieces(c) : terrainColliderPieces(tile, c.spacing, c.heightRange);
        const ids = pieces.map((p, i) => {
          const pid = terrainColliderId(id, ref.x, ref.z, i);
          add.push({ entityId: pid, shape: p.shape, position: { x: t.origin[0] + ref.x * size + p.x, y: t.origin[1], z: t.origin[2] + ref.z * size + p.z }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
          return pid;
        });
        t.built.set(key, { digest, ids });
        built += 1;
      }
      for (const [key, b] of [...t.built]) {
        if (wanted.has(key)) continue;
        remove.push(...b.ids);
        t.built.delete(key);
      }
    }
    if (remove.length > 0) port.removeStaticColliders?.(remove);
    if (add.length > 0) port.addStaticColliders?.(add);
    if (built > 0) this.lastBuild = { tiles: built, ms: Math.round((performance.now() - t0) * 100) / 100 };
  }

  /** What terrain collision holds (null: no terrain with collision is loaded). */
  memory(): TerrainCollisionDiagnostics | null {
    if (this.terrains.size === 0 && this.tiles.size === 0) return null;
    let bytes = 0;
    let layerBytes = 0;
    for (const t of this.tiles.values()) {
      const layers = (t.weights?.byteLength ?? 0) + (t.paint?.byteLength ?? 0);
      bytes += t.heights.byteLength + (t.holes?.byteLength ?? 0) + layers;
      layerBytes += layers;
    }
    let colliders = 0;
    let tilesWithColliders = 0;
    let waiting = 0;
    for (const s of this.terrains.values()) {
      for (const b of s.built.values()) {
        colliders += b.ids.length;
        tilesWithColliders += 1;
      }
      for (const r of s.component.tiles) if (r.data !== undefined && !this.tiles.has(r.data) && !s.built.has(terrainTileKey(r.x, r.z)) && (this.ring === null || this.ring(s.entityId, r.x, r.z))) waiting += 1;
    }
    return { tiles: this.tiles.size, bytes, layerBytes, colliders, tilesWithColliders, lastBuild: this.lastBuild, waiting };
  }
}

/** A flat tile: one cell the tile's size at its flat height. */
function flatPieces(c: TerrainComponent): TerrainColliderPiece[] {
  const size = terrainTileSize(c);
  const y = terrainHeightOf(c.heightRange, terrainFlatStep(c.heightRange));
  return [{ shape: { type: 'heightfield', cellsX: 1, cellsZ: 1, cellX: size, cellZ: size, heights: new Float32Array([y, y, y, y]) }, x: 0, z: 0 }];
}
