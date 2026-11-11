/**
 * Collision on its own path: bodies need a surface, not meshes, pieces,
 * navigation, light or shader data, so a chunk round a moving body that has
 * no derived result yet gets a collision-only derive (derived-data.ts
 * `deriveCollision`: the same evaluation and code as the full derive, its
 * `collision` and `ground` byte for byte, joined as the full join joins
 * them) ahead of the drawing work, round the bodies and along their way, not
 * round the camera.
 *
 * - **What is asked for.** The host names the collision foci each update
 *   (the bodies that move and points ahead of them along their velocity,
 *   and the camera only where level 0 is drawn round it); the chunks within
 *   the collision ring's add bounds of one, resident, whose sections have
 *   never all had their full result, get a job, nearest to their focus
 *   first, in the pool's edit lane (an edit's rebuild and a body's ground are
 *   what a player waits for).
 * - **Staleness.** A job snapshots its chunk's section stamps (the section
 *   derives' own: they move with any change within reach); a result whose
 *   stamps moved meanwhile is kept for the body it stands for (a full
 *   result's stale copy is kept the same way while it is rebuilt) and asked
 *   for again.
 * - **Hand-over.** Once every section of the chunk has its full result of
 *   its inputs as they are now, the collision-only result goes: the body is
 *   then made from the full join, the same surface, so nothing that stands
 *   on it moves. Until then a current collision-only result is preferred to
 *   a full one being rebuilt ({@link CollisionDerives.fresh}).
 * - **Budget.** A result is counted as its chunk's {@link COLLISION_ALONE_PART}
 *   and goes with the chunk.
 */
import { apronTransfer, buildApron } from './apron';
import { rulesRef, type AssemblyRuleSet } from './assembly';
import { joinCollisionParts } from './chunk-join';
import { payloadTransfer } from './chunk-wire';
import { chunkInWorld, chunkKey, type ChunkGrid, type SectionEdge } from './coords';
import type { CollisionSource } from './derived-collision';
import { collisionPartBytes, type CollisionPart } from './derived-data';
import type { DirtyTracker } from './dirty-tracker';
import type { PieceTable } from './piece-table';
import { DERIVED_PART } from './record';
import type { DeriveInput, DeriveOutput } from './stream-job';
import type { DeriveView } from './stream-sections';
import type { Focus } from './stream-ring';
import type { CollisionRingBounds } from './collision-ring';
import type { WorkerPool } from './worker-pool';

/** The budget part a chunk's collision-only result is counted as. */
export const COLLISION_ALONE_PART = 'collision-alone';

/** A chunk's collision-only result arrived (its body is to be made again from {@link CollisionDerives.source}). */
export interface CollisionEvent {
  readonly type: 'collision';
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
}

/** What the collision-only derives need of the streamer and its section derives. */
export interface CollisionDeriveHost {
  readonly store: DeriveView;
  readonly grid: ChunkGrid;
  readonly gridId: number;
  readonly pool: WorkerPool;
  readonly tracker: DirtyTracker;
  readonly radius: number;
  readonly rules: AssemblyRuleSet;
  readonly sectionEdge: SectionEdge;
  pieceTable(): PieceTable | null;
  isResident(cx: number, cy: number, cz: number): boolean;
  /** Whether every section of the chunk has had its full result (or is stranded at the load ring's edge). */
  fullReady(cx: number, cy: number, cz: number): boolean;
  /** Whether every section's full result is of its inputs as they are now (none being rebuilt). */
  fullCurrent(cx: number, cy: number, cz: number): boolean;
  /** The chunk's section input stamps by section id (null: the chunk has no sections). */
  stamps(cx: number, cy: number, cz: number): readonly number[] | null;
  /** Whether every section of the chunk can derive now (its chunk and every chunk its sections reach are resident). */
  derivable(cx: number, cy: number, cz: number): boolean;
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean;
  emit(e: CollisionEvent): void;
  poke(): void;
  readonly counters: { collisionDerives: number; collisionAir: number; collisionRefused: number };
}

interface Entry {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** The newest result's join (null: none yet). */
  source: CollisionSource | null;
  /** The section stamps the newest result was derived from. */
  stamps: readonly number[] | null;
  /** Live job (0: none). */
  job: number;
}

const EMPTY_SURFACE = Object.freeze({ vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0) });
const EMPTY_COLLISION = Object.freeze({ boxes: new Uint16Array(0), fullBoxes: 0, ramps: EMPTY_SURFACE });

const sameStamps = (a: readonly number[] | null, b: readonly number[] | null): boolean => a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]);

export class CollisionDerives {
  private readonly entries = new Map<number, Entry>();
  private foci: readonly Focus[] = [];
  /** The collision ring's add bounds (cells) the foci ask within. */
  bounds: Pick<CollisionRingBounds, 'radius' | 'height'> = { radius: 0, height: 0 };

  constructor(private readonly host: CollisionDeriveHost) {}

  /** Where bodies need ground (cells): the moving bodies, points ahead of them, the camera where level 0 is drawn. */
  setFoci(foci: readonly Focus[]): void {
    this.foci = foci.map((f) => ({ x: f.x, y: f.y, z: f.z }));
  }

  /** Live collision-only jobs. */
  get deriving(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.job !== 0) n++;
    return n;
  }

  /** Chunks holding a collision-only result. */
  get count(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.source !== null) n++;
    return n;
  }

  /** A chunk's collision-only join, current or not (null: none, or its full result took over). */
  source(cx: number, cy: number, cz: number): CollisionSource | null {
    if (!chunkInWorld(this.host.grid, cx, cy, cz)) return null;
    return this.entries.get(chunkKey(this.host.grid, cx, cy, cz))?.source ?? null;
  }

  /** Whether every section of a chunk has its full result of its inputs as they are now (the hand-over's test). */
  fullCurrent(cx: number, cy: number, cz: number): boolean {
    return this.host.fullCurrent(cx, cy, cz);
  }

  /** Whether a chunk's collision-only result is of its sections as they are now (none: false). */
  fresh(cx: number, cy: number, cz: number): boolean {
    if (!chunkInWorld(this.host.grid, cx, cy, cz)) return false;
    const e = this.entries.get(chunkKey(this.host.grid, cx, cy, cz));
    return e !== undefined && e.source !== null && sameStamps(e.stamps, this.host.stamps(cx, cy, cz));
  }

  /** The chunk left the stream: its result and job go (its parts went with the chunk). */
  dropped(cx: number, cy: number, cz: number): void {
    const key = chunkKey(this.host.grid, cx, cy, cz);
    const e = this.entries.get(key);
    if (e === undefined) return;
    if (e.job !== 0) this.host.pool.cancel(e.job);
    this.entries.delete(key);
  }

  /** Whether any job is out or could be sent (the streamer's idle check). */
  pending(): boolean {
    for (const e of this.entries.values()) if (e.job !== 0) return true;
    return this.wantedNow().length > 0;
  }

  /**
   * Lets go of results whose chunk has its full result now, then sends jobs for the chunks the foci want, nearest
   * to their focus first, as far as the pool has room and `msPerUpdate` of main-thread time lasts (one at least).
   */
  request(msPerUpdate: number): void {
    const h = this.host;
    for (const [key, e] of this.entries) {
      if (e.job !== 0 || !h.fullCurrent(e.cx, e.cy, e.cz)) continue;
      this.entries.delete(key);
      h.setPart(e.cx, e.cy, e.cz, COLLISION_ALONE_PART, 0);
    }
    const t0 = performance.now();
    let sent = 0;
    for (const w of this.wantedNow()) {
      if (h.pool.room() <= 0 || (sent > 0 && performance.now() - t0 > msPerUpdate)) break;
      this.send(w.cx, w.cy, w.cz, w.d2);
      sent++;
    }
  }

  /** Chunks the foci want a collision-only job for now, nearest to their focus first. */
  private wantedNow(): Array<{ cx: number; cy: number; cz: number; d2: number }> {
    const h = this.host;
    const g = h.grid;
    const e = g.edge;
    const { radius, height } = this.bounds;
    const out = new Map<number, { cx: number; cy: number; cz: number; d2: number }>();
    if (radius <= 0) return [];
    for (const f of this.foci) {
      const x0 = Math.floor((f.x - radius) / e);
      const x1 = Math.floor((f.x + radius) / e);
      const z0 = Math.floor((f.z - radius) / e);
      const z1 = Math.floor((f.z + radius) / e);
      const y0 = Math.floor((f.y - height) / e);
      const y1 = Math.floor((f.y + height) / e);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const gx = f.x < cx * e ? cx * e - f.x : f.x > cx * e + e ? f.x - cx * e - e : 0;
        const gz = f.z < cz * e ? cz * e - f.z : f.z > cz * e + e ? f.z - cz * e - e : 0;
        const h2 = gx * gx + gz * gz;
        if (h2 >= radius * radius) continue;
        for (let cy = y0; cy <= y1; cy++) {
          const gy = f.y < cy * e ? cy * e - f.y : f.y > cy * e + e ? f.y - cy * e - e : 0;
          if (gy >= height || !chunkInWorld(g, cx, cy, cz)) continue;
          const key = chunkKey(g, cx, cy, cz);
          // The column under a body before the air over it: the ground it stands on is lower than it.
          const d2 = h2 + (f.y >= cy * e ? 0 : gy * gy);
          const was = out.get(key);
          if (was !== undefined) {
            was.d2 = Math.min(was.d2, d2);
            continue;
          }
          const en = this.entries.get(key);
          if (en !== undefined && (en.job !== 0 || sameStamps(en.stamps, h.stamps(cx, cy, cz)))) continue;
          if (!h.isResident(cx, cy, cz) || h.fullReady(cx, cy, cz) || !h.derivable(cx, cy, cz)) continue;
          out.set(key, { cx, cy, cz, d2 });
        }
      }
    }
    return [...out.values()].sort((a, b) => a.d2 - b.d2);
  }

  private send(cx: number, cy: number, cz: number, d2: number): void {
    const h = this.host;
    const g = h.grid;
    const key = chunkKey(g, cx, cy, cz);
    let en = this.entries.get(key);
    if (en === undefined) this.entries.set(key, (en = { cx, cy, cz, source: null, stamps: null, job: 0 }));
    const stamps = h.stamps(cx, cy, cz);
    const n = (g.edge / h.sectionEdge) ** 3;
    const ids = Array.from({ length: n }, (_, i) => i);
    const apron = buildApron(h.store, cx, cy, cz, h.radius);
    if (h.store.chunkForm(cx, cy, cz) === 'absent' && apron.dense.every((d, k) => d === 0 && apron.uniform[k] === 0)) {
      // Air with air all round collides with nothing: answered here, as the full derive answers it.
      this.landed(en, { edge: g.edge, ground: EMPTY_SURFACE, collision: EMPTY_COLLISION }, stamps, 0);
      h.counters.collisionAir++;
      return;
    }
    const payload = h.store.chunkPayload(cx, cy, cz);
    const pieces = h.pieceTable();
    const id = h.tracker.beginJob({ grid: h.gridId, key }).id;
    h.tracker.expireJob(id);
    en.job = id;
    const input: DeriveInput = {
      edge: g.edge,
      chunk: { grid: h.gridId, cx, cy, cz },
      payload,
      radius: h.radius,
      apron,
      rules: rulesRef(h.rules),
      parts: DERIVED_PART.collision,
      ...(pieces === null ? {} : { pieces: pieces.bytes }),
      sections: { edge: h.sectionEdge, ids },
    };
    void h.pool.submit<DeriveOutput>({ id, kind: 'derive', lane: 'edit', distance: d2, input, transfer: payloadTransfer(payload, apronTransfer(apron)) }).then((o) => {
      h.poke();
      const e = this.entries.get(key);
      if (e === undefined || e.job !== id) return;
      e.job = 0;
      if (o.status !== 'done') {
        // Refused or failed: the same input fails again, so it is not asked for again until the chunk changes.
        if (o.status === 'refused' || o.status === 'failed') {
          e.stamps = stamps;
          h.counters.collisionRefused++;
        }
        return;
      }
      const out = o.output as DeriveOutput;
      const parts: Array<CollisionPart | null> = new Array<CollisionPart | null>(n).fill(null);
      for (const r of out.sections ?? []) parts[r.id] = r.collision ?? null;
      h.counters.collisionDerives++;
      this.landed(e, joinCollisionParts(g.edge, h.sectionEdge, parts), stamps, parts.reduce((s, p) => s + (p === null ? 0 : collisionPartBytes(p)), 0));
    });
  }

  /** A chunk's collision-only result is in: kept and announced, unless its full result landed meanwhile (the same surface, newer). */
  private landed(e: Entry, joined: CollisionSource, stamps: readonly number[] | null, bytes: number): void {
    const h = this.host;
    const { cx, cy, cz } = e;
    if (h.fullCurrent(cx, cy, cz)) {
      this.entries.delete(chunkKey(h.grid, cx, cy, cz));
      h.setPart(cx, cy, cz, COLLISION_ALONE_PART, 0);
      return;
    }
    e.source = joined;
    e.stamps = stamps;
    h.setPart(cx, cy, cz, COLLISION_ALONE_PART, bytes);
    h.emit({ type: 'collision', cx, cy, cz });
  }
}
