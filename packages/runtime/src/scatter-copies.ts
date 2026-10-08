/**
 * Rule scatter's stored copies in the running game (`project-model/scatter.ts`):
 * the trees and rocks terrains and block layers carry, each named by its
 * address — its source object, its rule and its candidate cell, the same
 * through every bake that keeps it — so a script can find a copy, hide it,
 * show it again or remove it (`ctx.scatter`), and a ray that hits one names
 * it (`PhysicsHit.scatter`). What a game does with that (felling a tree,
 * picking a flower) is the game's.
 *
 * Collision: the copies of a rule with `collide` carry their model's `_COL`
 * parts (the build's model collider table, as an object's `{type: 'model'}`
 * collider), one static collider per copy whose id is its address, added and
 * removed in the batches the block layers' and terrains' colliders use
 * (`RuntimeGrid.flushCollision`). Which tiles and chunks get them is a ring
 * (`ring`): every one for now, the collision ring of world streaming once
 * tiles stream. A hidden or removed copy has none.
 *
 * A block layer's copies come with its chunks; a terrain's tiles' scatter
 * blobs are read and decoded by the page and handed over by digest
 * (`addBlobs`), as its tiles are for collision.
 *
 * Deterministic: queries sort by distance, then address. The renderer
 * follows the hidden and removed copies through the grid's render changes
 * ({@link ScatterCopyChange}).
 */
import {
  CHUNK_SIZE,
  SCATTER_COPY_FLOATS,
  decodeChunkScatter,
  storedScatterRules,
  terrainTileSize,
  type BlockLayerComponent,
  type BlockLayerData,
  type EntityV3,
  type ModelColliderTable,
  type ScatterCell,
  type ScatterRule,
  type TerrainComponent,
} from '@thirdlight/project-model';

import { colliderShape3DOf } from './collider-specs';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';
import type { TerrainTileData } from './terrain-collision';

/** Between an object's id and a copy's rule and cell in an address (and in its collider's id). */
export const SCATTER_ADDRESS_TAG = '#scatter:';
/** The most copies one `ctx.scatter.near` answers (a per-call bound; ask a smaller circle for more). */
export const SCATTER_NEAR_MAX = 1024;

/** A copy's address: `<object>#scatter:<rule>:<ix>,<iz>`. */
export function scatterAddress(entityId: string, rule: string, ix: number, iz: number): string {
  return `${entityId}${SCATTER_ADDRESS_TAG}${rule}:${ix},${iz}`;
}

/** An address's parts (null: not one). */
export function parseScatterAddress(address: unknown): { entityId: string; rule: string; ix: number; iz: number } | null {
  if (typeof address !== 'string' || address.length > 256) return null;
  const at = address.indexOf(SCATTER_ADDRESS_TAG);
  if (at <= 0) return null;
  const rest = address.slice(at + SCATTER_ADDRESS_TAG.length);
  const m = /^([A-Za-z0-9_-]{1,32}):(-?\d{1,10}),(-?\d{1,10})$/.exec(rest);
  if (m === null) return null;
  return { entityId: address.slice(0, at), rule: m[1]!, ix: Number(m[2]), iz: Number(m[3]) };
}

/** What a copy is to the renderer. */
export type ScatterCopyState = 'shown' | 'hidden' | 'removed';

/** One copy whose state scripts changed (the renderer follows it); `key` names the tile or chunk ("x,z") it lies in. */
export interface ScatterCopyChange {
  readonly entityId: string;
  readonly key: string;
  readonly rule: string;
  readonly cell: readonly [number, number];
  readonly state: ScatterCopyState;
}

/** A copy as scripts see it. */
export interface ScatterCopyInfo {
  /** Its address (what `get`, `hide`, `show` and `remove` take, and what a ray hit names). */
  readonly address: string;
  /** The terrain or block layer it stands on. */
  readonly source: string;
  readonly rule: string;
  /** Its candidate cell [ix, iz] (the rule's grid). */
  readonly cell: readonly [number, number];
  /** Where it stands (world), its turn (quaternion [x, y, z, w]) and its size (the model's times this). */
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: number;
  /** A script hid it (it is not drawn and does not collide). */
  readonly hidden: boolean;
}

/** A terrain's scatter blob decoded on the page, by digest. */
export interface TerrainScatterData {
  readonly digest: string;
  readonly scatter: ScatterCell;
}

/** What the page hands the simulation of its level: terrain tiles (for their colliders), scatter blobs (for their copies) and splines' made data (for theirs). */
export type TerrainSimData = TerrainTileData | TerrainScatterData | import('./splines').SplineSimData;

/**
 * Rule scatter's stored copies — trees, rocks, anything the terrains' and
 * block layers' scatter rules placed — found by place and named by address
 * (a copy's object, rule and cell: `"<object>#scatter:<rule>:<ix>,<iz>"`,
 * the same through every bake that keeps it). A hidden copy is not drawn and
 * does not collide until shown again; a removed one is gone for the run. A
 * new run brings every copy back; a save keeps what `changed()` lists and
 * puts it back with `hide` and `remove`.
 */
export interface BehaviorScatter {
  /**
   * The copies standing within `radius` metres of a world position (measured across the ground, x and z), nearest first: of one rule or object only, hidden ones too (`hidden: true`), at most `limit` (default 64, at most 1,024).
   * @graphPure
   * @graphNode Scatter copies near
   * @graphDefault radius 10
   */
  near(position: readonly [number, number, number], radius: number, options?: { rule?: string; source?: string; hidden?: boolean; limit?: number }): readonly ScatterCopyInfo[];
  /**
   * The copy at an address (hidden ones too), or null when there is none or it was removed.
   * @graphPure
   * @graphNode Scatter copy
   */
  get(address: string): ScatterCopyInfo | null;
  /**
   * Hide a copy: it is not drawn and does not collide until shown again. False when there is no such copy or it is hidden already.
   * @graphNode Hide scatter copy
   */
  hide(address: string): boolean;
  /**
   * Show a hidden copy again. False when it is not hidden.
   * @graphNode Show scatter copy
   */
  show(address: string): boolean;
  /**
   * Remove a copy for the rest of the run (not drawn, no collider). False when there is no such copy (or it is gone already).
   * @graphNode Remove scatter copy
   */
  remove(address: string): boolean;
  /**
   * The copies scripts hid or removed this run (for a save: put them back with `hide` and `remove`).
   * @graphNode skip saves store it as data
   */
  changed(): readonly { readonly address: string; readonly state: 'hidden' | 'removed' }[];
}

interface Source {
  readonly entityId: string;
  readonly kind: 'terrain' | 'blocks';
  readonly rules: ReadonlyMap<string, ScatterRule>;
  readonly origin: readonly [number, number, number];
  /** A tile's or chunk's world width (m), and its copies by key "x,z" (null: not here yet, or none). */
  readonly unit: number;
  readonly cells: Map<string, ScatterCell | null>;
  /** A terrain's tiles' scatter blobs by key (what `addBlobs` fills in). */
  readonly digests: Map<string, string>;
  /** Per key, the colliders built there (their ids). */
  readonly built: Map<string, string[]>;
}

/** Diagnostics: copies held and colliders built. */
export interface ScatterCopiesDiagnostics {
  sources: number;
  copies: number;
  colliders: number;
  hidden: number;
  removed: number;
  /** The last flush that built colliders: tiles and chunks built, colliders added and milliseconds. */
  lastBuild: { units: number; colliders: number; ms: number } | null;
  /** Terrain tiles whose scatter has not arrived. */
  waiting: number;
}

export class RuntimeScatter {
  private readonly sources = new Map<string, Source>();
  private readonly blobs = new Map<string, ScatterCell>();
  /** Copies scripts hid or removed, by address. */
  private readonly states = new Map<string, 'hidden' | 'removed'>();
  private changes: ScatterCopyChange[] = [];
  /** Tiles and chunks whose colliders are built again at the next flush ("entity\0key"). */
  private dirty = new Set<string>();
  /** Single colliders to take off or put back at the next flush (a copy hidden or shown). */
  private dropIds: string[] = [];
  private putBack = new Set<string>();
  private lastBuild: ScatterCopiesDiagnostics['lastBuild'] = null;
  readonly api: BehaviorScatter;

  /**
   * `collide`: copies may have colliders (a 3D game); `ring` says which tiles
   * and chunks get them (object, tile or chunk x and z; absent: every one).
   */
  constructor(
    private readonly collide: boolean,
    private readonly modelColliders: ModelColliderTable | undefined,
    private readonly ring: ((entityId: string, x: number, z: number) => boolean) | null = null,
  ) {
    this.api = this.buildApi();
  }

  /** The scatter of entities that carry `terrain` or `blockLayer` with stored rules. */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      if (this.sources.has(e.id)) continue;
      const comps = e.components as { terrain?: TerrainComponent; blockLayer?: BlockLayerComponent & { data?: BlockLayerData } };
      const p = e.components.transform?.position ?? [0, 0, 0];
      const origin = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] as const;
      if (comps.terrain !== undefined) {
        const t = comps.terrain;
        const rules = storedScatterRules(t.scatter);
        if (rules.length === 0) continue;
        const src = this.sourceOf(e.id, 'terrain', rules, origin, terrainTileSize(t));
        for (const ref of t.tiles) {
          if (ref.scatter === undefined) continue;
          const key = `${ref.x},${ref.z}`;
          src.digests.set(key, ref.scatter);
          src.cells.set(key, this.blobs.get(ref.scatter) ?? null);
          this.dirty.add(`${e.id}\u0000${key}`);
        }
      } else if (comps.blockLayer !== undefined) {
        const b = comps.blockLayer;
        const rules = storedScatterRules(b.scatter);
        if (rules.length === 0) continue;
        const src = this.sourceOf(e.id, 'blocks', rules, origin, CHUNK_SIZE * b.cellSize[0]!);
        for (const c of b.data?.chunks ?? []) {
          if (c.scatter === undefined) continue;
          const key = `${c.cx},${c.cz}`;
          src.cells.set(key, decodeChunkScatter(c.scatter));
          this.dirty.add(`${e.id}\u0000${key}`);
        }
      }
    }
  }

  /** Forget unloaded objects' scatter; returns their collider ids (the caller removes them from the port). */
  remove(ids: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const s = this.sources.get(id);
      if (s === undefined) continue;
      for (const list of s.built.values()) out.push(...list);
      this.sources.delete(id);
      for (const k of [...this.dirty]) if (k.startsWith(`${id}\u0000`)) this.dirty.delete(k);
    }
    // Only the removed objects' blobs: blobs sent ahead for a scene still loading stay.
    const named = new Set<string>();
    for (const s of this.sources.values()) for (const d of s.digests.values()) named.add(d);
    for (const d of [...this.blobs.keys()]) if (!named.has(d)) this.blobs.delete(d);
    return out;
  }

  /** Terrain tiles' scatter decoded on the page (by digest): their copies are found and collide from the next flush. */
  addBlobs(blobs: readonly TerrainScatterData[]): void {
    for (const b of blobs) this.blobs.set(b.digest, b.scatter);
    for (const s of this.sources.values()) {
      for (const [key, digest] of s.digests) {
        const cell = this.blobs.get(digest);
        if (cell === undefined || s.cells.get(key) === cell) continue;
        s.cells.set(key, cell);
        this.dirty.add(`${s.entityId}\u0000${key}`);
      }
    }
  }

  /** A new run: every copy back (the renderer shows them again, their colliders come back). */
  reset(): void {
    for (const address of this.states.keys()) {
      const a = parseScatterAddress(address)!;
      const s = this.sources.get(a.entityId);
      const key = s === undefined ? null : this.keyOf(s, a.rule, a.ix, a.iz);
      if (s !== undefined && key !== null) {
        this.changes.push(Object.freeze({ entityId: a.entityId, key, rule: a.rule, cell: Object.freeze([a.ix, a.iz] as const), state: 'shown' as const }));
        this.putBack.add(address);
      }
    }
    this.states.clear();
  }

  /** The copies whose state changed since the last call (the renderer's). */
  takeChanges(): ScatterCopyChange[] {
    if (this.changes.length === 0) return [];
    const out = this.changes;
    this.changes = [];
    return out;
  }

  /** Build what changed since the last flush: tiles and chunks again, single copies hidden or shown (batched: one remove, one add). */
  flush(port: PhysicsPort3D | undefined): void {
    if (this.dirty.size === 0 && this.dropIds.length === 0 && this.putBack.size === 0) return;
    const dirty = [...this.dirty].sort();
    this.dirty = new Set();
    const drop = this.dropIds;
    this.dropIds = [];
    const back = [...this.putBack].sort();
    this.putBack = new Set();
    if (port === undefined || !this.collide) return;
    const t0 = performance.now();
    const remove: string[] = [...drop];
    const add: StaticColliderSpec3D[] = [];
    let units = 0;
    const rebuilt = new Set<string>();
    for (const k of dirty) {
      const i = k.indexOf('\u0000');
      const s = this.sources.get(k.slice(0, i));
      if (s === undefined) continue;
      const key = k.slice(i + 1);
      const had = s.built.get(key);
      if (had !== undefined) remove.push(...had);
      s.built.delete(key);
      const [x, z] = key.split(',').map(Number) as [number, number];
      const cell = s.cells.get(key) ?? null;
      if (cell === null || (this.ring !== null && !this.ring(s.entityId, x, z))) continue;
      const ids: string[] = [];
      for (const [ruleId, copies] of cell) {
        const rule = s.rules.get(ruleId);
        if (rule?.collide !== true) continue;
        for (let c = 0; c < copies.cells.length / 2; c++) {
          const address = scatterAddress(s.entityId, ruleId, copies.cells[c * 2]!, copies.cells[c * 2 + 1]!);
          if (this.states.has(address)) continue;
          const spec = this.colliderOf(s, rule, copies.copies, c, address);
          if (spec === null) continue;
          add.push(spec);
          ids.push(address);
        }
      }
      if (ids.length > 0) s.built.set(key, ids);
      units += 1;
      rebuilt.add(k);
    }
    // Copies shown again in a tile or chunk not built again above.
    for (const address of back) {
      if (this.states.has(address)) continue;
      const a = parseScatterAddress(address)!;
      const s = this.sources.get(a.entityId);
      const rule = s?.rules.get(a.rule);
      if (s === undefined || rule?.collide !== true) continue;
      const key = this.keyOf(s, a.rule, a.ix, a.iz);
      if (key === null || rebuilt.has(`${s.entityId}\u0000${key}`)) continue;
      const [x, z] = key.split(',').map(Number) as [number, number];
      if (this.ring !== null && !this.ring(s.entityId, x, z)) continue;
      const found = this.find(s, key, a.rule, a.ix, a.iz);
      if (found === null) continue;
      const spec = this.colliderOf(s, rule, found.copies, found.index, address);
      if (spec === null) continue;
      add.push(spec);
      const list = s.built.get(key) ?? [];
      list.push(address);
      s.built.set(key, list);
    }
    if (remove.length > 0) port.removeStaticColliders?.(remove);
    if (add.length > 0) port.addStaticColliders?.(add);
    if (units > 0 || add.length > 0) this.lastBuild = { units, colliders: add.length, ms: Math.round((performance.now() - t0) * 100) / 100 };
  }

  /** The address a collider id names (a copy's collider's id is its address), or undefined. */
  addressOfCollider(colliderId: string): string | undefined {
    return colliderId.includes(SCATTER_ADDRESS_TAG) ? colliderId : undefined;
  }

  diagnostics(): ScatterCopiesDiagnostics | null {
    if (this.sources.size === 0) return null;
    let copies = 0;
    let colliders = 0;
    let waiting = 0;
    for (const s of this.sources.values()) {
      for (const [key, cell] of s.cells) {
        if (cell === null) {
          if (s.digests.has(key)) waiting += 1;
          continue;
        }
        for (const c of cell.values()) copies += c.cells.length / 2;
      }
      for (const list of s.built.values()) colliders += list.length;
    }
    let hidden = 0;
    for (const st of this.states.values()) if (st === 'hidden') hidden += 1;
    return { sources: this.sources.size, copies, colliders, hidden, removed: this.states.size - hidden, lastBuild: this.lastBuild, waiting };
  }

  // ---- internals ------------------------------------------------------------------------

  private sourceOf(entityId: string, kind: Source['kind'], rules: readonly ScatterRule[], origin: readonly [number, number, number], unit: number): Source {
    const s: Source = { entityId, kind, rules: new Map(rules.map((r) => [r.id, r])), origin, unit, cells: new Map(), digests: new Map(), built: new Map() };
    this.sources.set(entityId, s);
    return s;
  }

  /** The static collider of copy `c` of `copies` (its model's `_COL` parts at its scale; null: the model has none). */
  private colliderOf(s: Source, rule: ScatterRule, copies: Float32Array, c: number, address: string): StaticColliderSpec3D | null {
    const o = c * SCATTER_COPY_FLOATS;
    const scale = copies[o + 7]!;
    const shape = colliderShape3DOf({ type: 'model' }, [scale, copies[o + 8]!, copies[o + 9]!], { model: { asset: { assetId: rule.asset.assetId }, ...(rule.asset.piece !== undefined ? { piece: rule.asset.piece } : {}) } }, this.modelColliders !== undefined ? { modelColliders: this.modelColliders } : undefined);
    if (shape === null) return null;
    const q = [copies[o + 3]!, copies[o + 4]!, copies[o + 5]!, copies[o + 6]!];
    const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
    return {
      entityId: address,
      shape,
      position: { x: s.origin[0] + copies[o]!, y: s.origin[1] + copies[o + 1]!, z: s.origin[2] + copies[o + 2]! },
      rotation: { x: q[0]! / len, y: q[1]! / len, z: q[2]! / len, w: q[3]! / len },
    };
  }

  /**
   * The tile or chunk key a copy lies in (null: none holds it). A candidate's
   * point lies in its cell of the rule's grid (world metres, `1 / √density`
   * wide), so only the tiles or chunks under that cell are looked in.
   */
  private keyOf(s: Source, rule: string, ix: number, iz: number): string | null {
    const r = s.rules.get(rule);
    if (r === undefined) return null;
    const size = 1 / Math.sqrt(r.density);
    const x0 = Math.floor((ix * size - s.origin[0]) / s.unit);
    const x1 = Math.floor(((ix + 1) * size - s.origin[0]) / s.unit);
    const z0 = Math.floor((iz * size - s.origin[2]) / s.unit);
    const z1 = Math.floor(((iz + 1) * size - s.origin[2]) / s.unit);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${x},${z}`;
        if (this.find(s, key, rule, ix, iz) !== null) return key;
      }
    }
    return null;
  }

  /** Copy (ix, iz) of a rule in a tile or chunk: its rule's copies and its index there. */
  private find(s: Source, key: string, rule: string, ix: number, iz: number): { copies: Float32Array; index: number } | null {
    const c = s.cells.get(key)?.get(rule);
    if (c === undefined) return null;
    for (let i = 0; i < c.cells.length; i += 2) if (c.cells[i] === ix && c.cells[i + 1] === iz) return { copies: c.copies, index: i / 2 };
    return null;
  }

  /** A copy at an address: its source, key and index (null: no such copy). */
  private locate(address: unknown): { s: Source; key: string; rule: string; ix: number; iz: number; copies: Float32Array; index: number } | null {
    const a = parseScatterAddress(address);
    if (a === null) return null;
    const s = this.sources.get(a.entityId);
    if (s === undefined || !s.rules.has(a.rule)) return null;
    const key = this.keyOf(s, a.rule, a.ix, a.iz);
    if (key === null) return null;
    const f = this.find(s, key, a.rule, a.ix, a.iz)!;
    return { s, key, rule: a.rule, ix: a.ix, iz: a.iz, ...f };
  }

  private info(s: Source, rule: string, ix: number, iz: number, copies: Float32Array, index: number): ScatterCopyInfo {
    const o = index * SCATTER_COPY_FLOATS;
    const address = scatterAddress(s.entityId, rule, ix, iz);
    return Object.freeze({
      address,
      source: s.entityId,
      rule,
      cell: Object.freeze([ix, iz] as const),
      position: Object.freeze([s.origin[0] + copies[o]!, s.origin[1] + copies[o + 1]!, s.origin[2] + copies[o + 2]!] as const),
      rotation: Object.freeze([copies[o + 3]!, copies[o + 4]!, copies[o + 5]!, copies[o + 6]!] as const),
      scale: copies[o + 7]!,
      hidden: this.states.get(address) === 'hidden',
    });
  }

  private setState(address: string, next: ScatterCopyState): boolean {
    const at = this.locate(address);
    if (at === null) return false;
    const was = this.states.get(address);
    if (was === 'removed') return false;
    if ((was ?? 'shown') === next) return false;
    if (next === 'shown') this.states.delete(address);
    else this.states.set(address, next);
    this.changes.push(Object.freeze({ entityId: at.s.entityId, key: at.key, rule: at.rule, cell: Object.freeze([at.ix, at.iz] as const), state: next }));
    const built = at.s.built.get(at.key);
    if (next === 'shown') this.putBack.add(address);
    else if (built !== undefined && built.includes(address)) {
      this.dropIds.push(address);
      built.splice(built.indexOf(address), 1);
    } else this.putBack.delete(address);
    return true;
  }

  private buildApi(): BehaviorScatter {
    const g = this;
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    return Object.freeze({
      near(position: readonly [number, number, number], radius: number, options?: { rule?: string; source?: string; hidden?: boolean; limit?: number }): readonly ScatterCopyInfo[] {
        if (!Array.isArray(position) || position.length !== 3 || !position.every(finite) || !finite(radius) || radius < 0) return Object.freeze([]);
        const limit = Math.max(0, Math.min(SCATTER_NEAR_MAX, Math.floor(finite(options?.limit) ? options!.limit! : 64)));
        const [px, , pz] = position;
        const found: { d: number; address: string; info: () => ScatterCopyInfo }[] = [];
        for (const s of g.sources.values()) {
          if (options?.source !== undefined && options.source !== s.entityId) continue;
          for (const [key, cell] of s.cells) {
            if (cell === null) continue;
            const [x, z] = key.split(',').map(Number) as [number, number];
            const x0 = s.origin[0] + x * s.unit;
            const z0 = s.origin[2] + z * s.unit;
            // The tile or chunk is past the circle (a copy lies in the one holding its point).
            if (Math.max(x0 - px, 0, px - (x0 + s.unit)) > radius || Math.max(z0 - pz, 0, pz - (z0 + s.unit)) > radius) continue;
            for (const [rule, copies] of cell) {
              if (options?.rule !== undefined && options.rule !== rule) continue;
              for (let i = 0; i < copies.cells.length / 2; i++) {
                const o = i * SCATTER_COPY_FLOATS;
                const dx = s.origin[0] + copies.copies[o]! - px;
                const dz = s.origin[2] + copies.copies[o + 2]! - pz;
                const d = Math.hypot(dx, dz);
                if (d > radius) continue;
                const ix = copies.cells[i * 2]!;
                const iz = copies.cells[i * 2 + 1]!;
                const address = scatterAddress(s.entityId, rule, ix, iz);
                const st = g.states.get(address);
                if (st === 'removed' || (st === 'hidden' && options?.hidden !== true)) continue;
                found.push({ d, address, info: () => g.info(s, rule, ix, iz, copies.copies, i) });
              }
            }
          }
        }
        found.sort((a, b) => a.d - b.d || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
        return Object.freeze(found.slice(0, limit).map((f) => f.info()));
      },
      get(address: string): ScatterCopyInfo | null {
        const at = g.locate(address);
        if (at === null || g.states.get(address) === 'removed') return null;
        return g.info(at.s, at.rule, at.ix, at.iz, at.copies, at.index);
      },
      hide: (address: string): boolean => g.setState(address, 'hidden'),
      show: (address: string): boolean => g.states.get(address) === 'hidden' && g.setState(address, 'shown'),
      remove: (address: string): boolean => g.setState(address, 'removed'),
      changed(): readonly { readonly address: string; readonly state: 'hidden' | 'removed' }[] {
        return Object.freeze([...g.states].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([address, state]) => Object.freeze({ address, state })));
      },
    });
  }
}
