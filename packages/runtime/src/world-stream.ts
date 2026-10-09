/**
 * World streaming in the simulation: which streamed terrain tiles and block
 * chunks have colliders (and their scatter copies theirs) and which block
 * chunks' live blocks have their objects, by distance from the simulation's
 * sources — the camera's place, the object it follows and every player
 * character — read from the committed state at each step boundary, so a
 * replay and the worker load and drop the same cells at the same steps.
 *
 * Each streamed object (`streaming` on a terrain or block layer, project-model
 * `world-streaming.ts`) has a collision ring and, for a block layer, a live
 * ring. The rings are looked at again only when a source has moved
 * {@link STREAM_RECHECK_METRES} since the last look (or a source came or
 * went, or an object loaded), and reach that much further than asked, so
 * nothing a source can come within the ring of between two looks is
 * missing. A cell inside a ring waits to be admitted,
 * nearest first, within a per-step budget ({@link STREAM_COLLIDER_SAMPLES_PER_STEP}:
 * at least one a step), so entering a dense area spreads its collider builds
 * over steps instead of one long step; an object's first admission (its
 * load) takes everything in its rings at once, so a game starts on solid
 * ground. A cell past its ring and its hysteresis leaves at once. Edits
 * (a script writing a chunk inside a ring) collide at once as before.
 *
 * The data collision reads arrives from the page (terrain tiles, decoded
 * where the page draws them); a tile in a ring whose data has not arrived
 * has no collider and is counted waiting. The grid tells the page which
 * tiles the collision rings want (`GridCollisionRingChange`), so the page
 * reads them round a character far from the camera too.
 *
 * Pure bookkeeping: the grid, the terrains' colliders, the scatter copies and
 * the live blocks ask it and are told what entered and left.
 */
import { CHUNK_SIZE, inStreamRing, resolveStreamingRings, squareDistance, terrainTileSize, type BlockLayerComponent, type ResolvedStreamingRings, type StreamRing, type TerrainComponent } from '@thirdlight/project-model';

/** How far (m) a source moves before the rings are looked at again. */
export const STREAM_RECHECK_METRES = 4;
/**
 * The collider work admitted into the rings per step, in height samples (a
 * terrain tile costs its samples; a block chunk {@link STREAM_CHUNK_COST}):
 * one 257² tile (~7–9 ms of a step to build) a step, or two chunks; at
 * least one cell a step whatever it costs.
 */
export const STREAM_COLLIDER_SAMPLES_PER_STEP = 257 * 257;
/** A block chunk's collider work in the same units (3–7 ms measured against a 257² tile's 7–9 ms). */
export const STREAM_CHUNK_COST = Math.floor((257 * 257) / 2);
/** Live blocks' objects spawned per step for cells entering a live ring (~120 µs each). */
export const STREAM_LIVE_SPAWNS_PER_STEP = 16;

/** The ring a consumer asks about. */
export type StreamRingKind = 'collision' | 'live';

/** What entered and left one object's ring at a step. */
export interface StreamRingChange {
  readonly entityId: string;
  readonly ring: StreamRingKind;
  readonly entered: readonly string[];
  readonly left: readonly string[];
}

/** World streaming in a play's diagnostics (`runtime.worldStream`). */
export interface SimStreamDiagnostics {
  /** Sources the rings follow (the camera, its target, the characters). */
  sources: number;
  /** Streamed objects. */
  objects: number;
  /** Tiles and chunks in the collision rings, and those waiting to be admitted. */
  collision: { resident: number; pending: number };
  /** Chunks in the live rings, and those waiting. */
  live: { resident: number; pending: number };
  /** How often the rings were looked at again, and the step of the last look. */
  rechecks: number;
  lastRecheckStep: number;
}

interface RingState {
  readonly ring: StreamRing;
  readonly members: Set<string>;
  /** Cells inside the ring waiting to be admitted, nearest first. */
  pending: { key: string; d: number }[];
  /** Nothing admitted yet: the first admission takes everything (the object's load). */
  fresh: boolean;
}

interface StreamedObject {
  readonly entityId: string;
  readonly kind: 'terrain' | 'blocks';
  readonly origin: readonly [number, number, number];
  /** A tile's or chunk's side (m). */
  readonly unit: number;
  /** The cost of admitting one of its cells into the collision ring. */
  readonly cost: number;
  readonly rings: ResolvedStreamingRings;
  /** The cells it has (a terrain's tiles; a layer's chunks are asked for at each look). */
  readonly keys: (() => Iterable<string>) | null;
  readonly collision: RingState;
  readonly live: RingState | null;
}

const ringState = (ring: StreamRing): RingState => ({ ring, members: new Set(), pending: [], fresh: true });

/** The sources the rings follow: the committed view's place (once it has one), its target's and every character's positions. */
export function worldStreamSources(view: { position: readonly number[]; target?: string } | null, characters: readonly string[], positionOf: (id: string) => readonly number[] | undefined): number[][] {
  const out: number[][] = [];
  if (view !== null) out.push([view.position[0]!, view.position[1]!, view.position[2]!]);
  const target = view?.target !== undefined ? positionOf(view.target) : undefined;
  if (target !== undefined) out.push([target[0]!, target[1]!, target[2]!]);
  for (const id of characters) {
    const p = positionOf(id);
    if (p !== undefined) out.push([p[0]!, p[1]!, p[2]!]);
  }
  return out;
}

export class SimWorldStream {
  private readonly objects = new Map<string, StreamedObject>();
  private sources: number[][] = [];
  /** Where the sources were at the last look (null: look at the next step). */
  private lookedFrom: number[][] | null = null;
  private rechecks = 0;
  private lastRecheckStep = -1;
  private changes: StreamRingChange[] = [];
  private spawnsLeft = STREAM_LIVE_SPAWNS_PER_STEP;

  /** `sources` gives the committed state's sources at a step boundary. */
  constructor(private readonly sourcesNow: (() => number[][]) | null) {}

  /** Whether anything streams. */
  get active(): boolean {
    return this.objects.size > 0;
  }

  /** A streamed terrain (nothing when it does not stream). */
  addTerrain(entityId: string, c: TerrainComponent, origin: readonly number[], collide: boolean): void {
    const rings = resolveStreamingRings(c.streaming);
    if (rings === null || this.objects.has(entityId)) return;
    const keys = c.tiles.map((t) => `${t.x},${t.z}`);
    this.objects.set(entityId, { entityId, kind: 'terrain', origin: [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0], unit: terrainTileSize(c), cost: c.tileSamples * c.tileSamples, rings, keys: collide ? () => keys : () => [], collision: ringState(rings.collision), live: null });
    this.lookedFrom = null;
  }

  /** A streamed block layer; `chunks` gives its chunks with cells now. */
  addLayer(entityId: string, c: BlockLayerComponent, origin: readonly number[], chunks: () => Iterable<string>): void {
    const rings = resolveStreamingRings(c.streaming);
    if (rings === null || this.objects.has(entityId)) return;
    this.objects.set(entityId, { entityId, kind: 'blocks', origin: [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0], unit: CHUNK_SIZE * c.cellSize[0], cost: STREAM_CHUNK_COST, rings, keys: chunks, collision: ringState(rings.collision), live: ringState(rings.live) });
    this.lookedFrom = null;
  }

  remove(entityId: string): void {
    this.objects.delete(entityId);
  }

  /** Whether an object streams. */
  streams(entityId: string): boolean {
    return this.objects.has(entityId);
  }

  /**
   * Whether a tile or chunk (key "x,z") of an object is in its ring (an
   * object that does not stream: always). A cell the last look did not know
   * of (a chunk a script just wrote) inside the ring is admitted now.
   */
  has(entityId: string, ring: StreamRingKind, key: string): boolean {
    const o = this.objects.get(entityId);
    if (o === undefined) return true;
    const s = ring === 'live' ? o.live : o.collision;
    if (s === null) return true;
    if (s.members.has(key)) return true;
    if (s.pending.some((p) => p.key === key)) return false;
    if (this.lookedFrom === null || this.distance(o, key, this.lookedFrom) > s.ring.radius + STREAM_RECHECK_METRES) return false;
    s.members.add(key);
    return true;
  }

  /**
   * A step boundary: look at the rings again when the sources moved, then
   * admit the waiting cells within the step's budget. What entered and left
   * is taken with `takeChanges`.
   */
  advance(stepIndex: number): void {
    this.spawnsLeft = STREAM_LIVE_SPAWNS_PER_STEP;
    if (this.objects.size === 0) return;
    this.sources = this.sourcesNow?.() ?? [];
    if (this.moved()) {
      this.lookedFrom = this.sources.map((p) => [...p]);
      this.rechecks += 1;
      this.lastRecheckStep = stepIndex;
      for (const o of [...this.objects.values()].sort((a, b) => (a.entityId < b.entityId ? -1 : 1))) {
        this.look(o, 'collision', o.collision);
        if (o.live !== null) this.look(o, 'live', o.live);
      }
    }
    this.admit();
  }

  /** Looks taken so far (a consumer that follows the rings' contents reads them again when this moves). */
  get looks(): number {
    return this.rechecks;
  }

  /**
   * A streamed terrain's tiles its collision ring holds or waits to admit
   * (keys "x,z", sorted): the tiles whose data the page must read for the
   * colliders, wherever the camera is (null: not a streamed terrain).
   */
  terrainWanted(entityId: string): string[] | null {
    const o = this.objects.get(entityId);
    if (o === undefined || o.kind !== 'terrain') return null;
    return [...o.collision.members, ...o.collision.pending.map((p) => p.key)].sort();
  }

  /** The streamed terrains (ids, sorted). */
  terrainIds(): string[] {
    return [...this.objects.values()].filter((o) => o.kind === 'terrain').map((o) => o.entityId).sort();
  }

  /** What entered and left the rings since the last call (in a fixed order). */
  takeChanges(): StreamRingChange[] {
    const out = this.changes;
    this.changes = [];
    return out;
  }

  /** Live objects that may still spawn this step for streamed layers (`spent` takes them). */
  liveSpawnsLeft(): number {
    return this.spawnsLeft;
  }

  spent(spawns: number): void {
    this.spawnsLeft = Math.max(0, this.spawnsLeft - spawns);
  }

  diagnostics(): SimStreamDiagnostics | null {
    if (this.objects.size === 0) return null;
    const collision = { resident: 0, pending: 0 };
    const live = { resident: 0, pending: 0 };
    for (const o of this.objects.values()) {
      collision.resident += o.collision.members.size;
      collision.pending += o.collision.pending.length;
      if (o.live !== null) {
        live.resident += o.live.members.size;
        live.pending += o.live.pending.length;
      }
    }
    return { sources: this.sources.length, objects: this.objects.size, collision, live, rechecks: this.rechecks, lastRecheckStep: this.lastRecheckStep };
  }

  // ---- internals -------------------------------------------------------------------------

  private moved(): boolean {
    const was = this.lookedFrom;
    if (was === null || was.length !== this.sources.length) return true;
    for (let i = 0; i < was.length; i++) {
      const a = was[i]!;
      const b = this.sources[i]!;
      if (Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!) >= STREAM_RECHECK_METRES) return true;
    }
    return false;
  }

  private distance(o: StreamedObject, key: string, from: readonly (readonly number[])[]): number {
    const c = key.indexOf(',');
    const x = Number(key.slice(0, c));
    const z = Number(key.slice(c + 1));
    const x0 = o.origin[0] + x * o.unit;
    const z0 = o.origin[2] + z * o.unit;
    let d = Infinity;
    for (const p of from) d = Math.min(d, squareDistance(x0, z0, x0 + o.unit, z0 + o.unit, p[0]!, p[2]!));
    return d;
  }

  /**
   * Which cells belong in a ring now: those past it leave at once, new ones
   * wait to be admitted. The ring reaches {@link STREAM_RECHECK_METRES}
   * further than asked: the sources move up to that far before the next look,
   * so a cell they come within the ring of has been admitted already (the
   * collision ring stays ahead of a walking character).
   */
  private look(o: StreamedObject, kind: StreamRingKind, s: RingState): void {
    const keys = new Set<string>([...(o.keys?.() ?? []), ...s.members]);
    const left: string[] = [];
    const pending: { key: string; d: number }[] = [];
    const ring = { radius: s.ring.radius + STREAM_RECHECK_METRES, hysteresis: s.ring.hysteresis };
    for (const key of keys) {
      const d = this.distance(o, key, this.sources);
      const member = s.members.has(key);
      if (inStreamRing(d, ring, member)) {
        if (!member) pending.push({ key, d });
      } else if (member) {
        s.members.delete(key);
        left.push(key);
      }
    }
    pending.sort((a, b) => a.d - b.d || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    s.pending = pending;
    left.sort();
    if (left.length > 0) this.changes.push({ entityId: o.entityId, ring: kind, entered: [], left });
  }

  /** Admit waiting cells nearest first: a fresh object's all at once, the rest within the step's budget. */
  private admit(): void {
    let budget = STREAM_COLLIDER_SAMPLES_PER_STEP;
    let admitted = 0;
    // Every object's nearest waiting cells compete for the step's budget, nearest first.
    const queue: { o: StreamedObject; kind: StreamRingKind; s: RingState; key: string; d: number }[] = [];
    for (const o of [...this.objects.values()].sort((a, b) => (a.entityId < b.entityId ? -1 : 1))) {
      for (const [kind, s] of [['collision', o.collision], ['live', o.live]] as const) {
        if (s === null || s.pending.length === 0) continue;
        if (s.fresh) {
          const entered = s.pending.map((p) => p.key);
          for (const k of entered) s.members.add(k);
          s.pending = [];
          s.fresh = false;
          this.changes.push({ entityId: o.entityId, ring: kind, entered: entered.sort(), left: [] });
          continue;
        }
        for (const p of s.pending) queue.push({ o, kind, s, key: p.key, d: p.d });
      }
    }
    queue.sort((a, b) => a.d - b.d || (a.o.entityId < b.o.entityId ? -1 : a.o.entityId > b.o.entityId ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const entered = new Map<RingState, { o: StreamedObject; kind: StreamRingKind; keys: string[] }>();
    let full = false;
    for (const q of queue) {
      // Live chunks cost nothing here (their spawns have their own budget); collider cells their samples, nearest
      // first until one does not fit (at least one a step).
      if (q.kind === 'collision') {
        if (full || (admitted > 0 && q.o.cost > budget)) {
          full = true;
          continue;
        }
        budget -= q.o.cost;
        admitted += 1;
      }
      q.s.members.add(q.key);
      let e = entered.get(q.s);
      if (e === undefined) entered.set(q.s, (e = { o: q.o, kind: q.kind, keys: [] }));
      e.keys.push(q.key);
    }
    for (const [s, e] of entered) {
      const taken = new Set(e.keys);
      s.pending = s.pending.filter((p) => !taken.has(p.key));
      this.changes.push({ entityId: e.o.entityId, ring: e.kind, entered: e.keys.sort(), left: [] });
    }
  }
}
