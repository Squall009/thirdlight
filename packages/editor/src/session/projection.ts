/**
 * Browser projection state (sessions.md §6.2/§8.3/§9; packet 10).
 *
 * The browser holds a PROJECTION of the backend's authoritative state. It is
 * hydrated from the full state (the establish result / `queryEntities` / a
 * resync) and updated incrementally from `mutation.applied` change data
 * (commands.md §5.3 — "a client projection updates from this alone"). The
 * projection is display state only: on ANY gap, conflict, or resync the
 * client re-hydrates from the backend (the sole authority). The browser never
 * writes to browser storage as the authoritative project database.
 *
 * Normative behaviors pinned here (m1-acceptance §2.2):
 *  - the browser DEDUPS its own `requestId` (a `mutation.applied` for an
 *    already-applied command is ignored, not double-applied);
 *  - the GAP RULE: a `mutation.applied` with `revision > lastSeen + 1` means
 *    events were missed ⇒ the projection is stale and a full resync is
 *    required (the incremental change is NOT applied);
 *  - a `revision_conflict` is explained (with `currentRevision`), never
 *    silently lost — the projection stays valid and the caller re-syncs.
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */

import type { Entity } from '@thirdlight/project-model';
import type { ChangeData } from '@thirdlight/commands';

/** One projected entity (the display projection of a backend Entity). */
export interface ProjectedEntity {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'box' | 'camera' | 'entity';
  position: number[];
  rotation: number[];
  scale: number[];
}

/** The result of applying one `mutation.applied` to the projection. */
export interface ApplyMutationResult {
  /** A `mutation.applied` for a requestId already applied (deduped). */
  deduped: boolean;
  /** The gap rule fired: revision jumped past lastSeen + 1 ⇒ resync needed. */
  gap: boolean;
  /** The change was applied to the projection. */
  applied: boolean;
}

/** A full-state hydration input (from establish / queryEntities / resync). */
export interface FullState {
  revision: number;
  entities: readonly Entity[];
}

/** A `mutation.applied` event (sessions.md §7). */
export interface MutationApplied {
  requestId: string;
  revision: number;
  change: ChangeData;
}

/** A structured conflict surfaced to the UI (commands.md §6.4). */
export interface ConflictInfo {
  code: 'revision_conflict';
  /** The backend's authoritative current revision. */
  currentRevision: number;
  /** The revision the failed command expected. */
  expectedRevision: number;
  message: string;
}

function toProjected(e: Entity): ProjectedEntity {
  const kind = e.components.box ? 'box' : e.components.camera ? 'camera' : 'entity';
  return {
    id: e.id,
    name: e.name ?? e.id,
    parentId: e.parentId ?? null,
    kind,
    position: [...e.components.transform.position],
    rotation: [...e.components.transform.rotation],
    scale: [...e.components.transform.scale],
  };
}

/**
 * The editor's projection of the backend scene. A single instance per
 * connection; hydrated from authoritative full state and updated from
 * `mutation.applied` change data.
 */
export class Projection {
  private entities = new Map<string, ProjectedEntity>();
  private order: string[] = [];
  private lastSeen = 0;
  private applied = new Set<string>();
  /** Set when the gap rule fires; the client must resync. */
  needsResync = false;

  /** Hydrate from authoritative full state (establish / queryEntities / resync). */
  hydrate(full: FullState): void {
    this.entities.clear();
    this.order = [];
    for (const e of full.entities) {
      const p = toProjected(e);
      this.entities.set(p.id, p);
      this.order.push(p.id);
    }
    this.lastSeen = full.revision;
    this.needsResync = false;
  }

  /** The current revision the projection reflects. */
  get revision(): number {
    return this.lastSeen;
  }

  /** Whether the projection is stale (a gap was observed) and needs a resync. */
  get stale(): boolean {
    return this.needsResync;
  }

  /** Document order (array of entity ids). */
  get entityOrder(): readonly string[] {
    return this.order;
  }

  getEntity(id: string): ProjectedEntity | undefined {
    return this.entities.get(id);
  }

  /** All projected entities in document order. */
  listEntities(): ProjectedEntity[] {
    const out: ProjectedEntity[] = [];
    for (const id of this.order) {
      const e = this.entities.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Apply one `mutation.applied` (sessions.md §6.2/§8.3).
   * Returns the outcome; NEVER throws. The gap rule and dedup are checked
   * before any mutation so a stale event cannot corrupt the projection.
   */
  applyMutationApplied(ev: MutationApplied): ApplyMutationResult {
    // Gap rule first: a jump past lastSeen+1 means we missed events. The
    // incremental change is NOT applied; the client must resync.
    if (ev.revision > this.lastSeen + 1) {
      this.needsResync = true;
      return { deduped: false, gap: true, applied: false };
    }
    // Dedup: a command we already applied (our own, or replayed) is ignored.
    if (this.applied.has(ev.requestId)) {
      this.lastSeen = Math.max(this.lastSeen, ev.revision);
      return { deduped: true, gap: false, applied: false };
    }
    const ok = this.applyChange(ev.change);
    if (ok) {
      this.applied.add(ev.requestId);
      this.lastSeen = Math.max(this.lastSeen, ev.revision);
    }
    return { deduped: false, gap: false, applied: ok };
  }

  private applyChange(change: ChangeData): boolean {
    switch (change.type) {
      case 'createEntity': {
        if (this.entities.has(change.id)) return true; // idempotent
        this.entities.set(change.id, toProjected(change.entity));
        this.order.push(change.id);
        return true;
      }
      case 'setTransform': {
        const p = this.entities.get(change.id);
        if (!p) return false;
        p.position = [...change.next.position];
        p.rotation = [...change.next.rotation];
        p.scale = [...change.next.scale];
        return true;
      }
      case 'deleteEntity': {
        const ids = new Set(change.deletedIds);
        for (const id of ids) this.entities.delete(id);
        this.order = this.order.filter((id) => !ids.has(id));
        return true;
      }
      case 'restoreSubtree': {
        for (const e of change.entities) {
          const p = toProjected(e);
          if (!this.entities.has(p.id)) {
            this.entities.set(p.id, p);
            this.order.push(p.id);
          }
        }
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Explain a `revision_conflict` (commands.md §6.4). The projection is left
   * valid; the caller re-syncs (re-reads the current revision + entity) and,
   * if permitted, auto-retries at most once. Never silently loses the edit.
   */
  describeConflict(expectedRevision: number, currentRevision: number, message: string): ConflictInfo {
    return { code: 'revision_conflict', currentRevision, expectedRevision, message };
  }
}