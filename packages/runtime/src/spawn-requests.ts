/**
 * `ctx.spawn` / `ctx.destroy` requests and the save document's `spawned`
 * section. Requests are checked when a script makes them and queued with
 * the step; ids are handed out at once. The runtime applies the queue at the
 * next step boundary (it owns the entities, colliders and scripts the copies
 * become) and tells this part what arrived and what went.
 */
import type { EntityV3, PrefabDefinition } from '@thirdlight/project-model';

import { BehaviorHostError } from './behavior';
import type { SavedSpawnCopy } from './save-sections';
import { MAX_LIVE_SPAWNED, MAX_SPAWNS_PER_STEP, SPAWN_ID_PREFIX, expandPrefab, parseSpawnOptions } from './spawn';
import type { BehaviorSpawnControl, TransformState } from './types';

/** One requested spawn or destroy, applied at the next step boundary in request order. */
export type SpawnOp =
  | { op: 'spawn'; entities: readonly EntityV3[]; origin?: string; properties?: Readonly<Record<string, unknown>> }
  | { op: 'destroy'; entityId: string };

/** What the requests read of the running game. */
export interface SpawnRequestHost {
  readonly prefabs: ReadonlyMap<string, PrefabDefinition>;
  /** The live spawned entities, in spawn order (parents before children); live blocks' objects among them. */
  spawned(): ReadonlyMap<string, EntityV3>;
  /** Whether a spawned object is a live block's (its cell owns it: never destroyed, counted or saved here). */
  live(entityId: string): boolean;
  /** The live blocks' objects among the spawned ones. */
  liveCount(): number;
  /** Any object of the game has this id (authored or spawned). */
  inGame(entityId: string): boolean;
  /** The object's transform this step (undefined: not loaded). */
  transformOf(entityId: string): TransformState | undefined;
  /** A behavior's `entityRef` property keys (undefined: a behavior this game has no module for). */
  entityRefKeysOf(behaviorId: string): readonly string[] | undefined;
  /** Why values cannot be a copy's own for this behavior (null: they can). */
  valuesProblem(behaviorId: string, values: Readonly<Record<string, unknown>>): string | null;
  /** One `spawn_refused` line in the runtime's diagnostics. */
  refused(message: string): void;
}

export class SpawnRequests {
  /** Spawns and destroys waiting for the next step boundary. */
  private ops: SpawnOp[] = [];
  /** Ids handed out to spawns that are not live yet. */
  private readonly reserved = new Set<string>();
  /** Destroys queued (so a second destroy of the same id reports false). */
  private readonly pendingDestroys = new Set<string>();
  /** The last `spawn-<n>` number handed out (never reset while the game runs). */
  private spawnSerial = 0;
  private spawnsThisStep = 0;
  private refusalLogged = false;
  /** The property values each live copy was spawned with (by root id), kept by a save. */
  private readonly copyProperties = new Map<string, Readonly<Record<string, unknown>>>();

  constructor(private readonly host: SpawnRequestHost) {}

  /** The last `spawn-<n>` number handed out. */
  get serial(): number {
    return this.spawnSerial;
  }

  /** An id handed out and not live yet. */
  isReserved(entityId: string): boolean {
    return this.reserved.has(entityId);
  }

  /** `ctx.spawn` / `ctx.destroy` for one script object (`origin`) or none. */
  control(origin?: string): BehaviorSpawnControl {
    const refuse = (reason: string, message: string): never => {
      throw new BehaviorHostError('module_error', reason, message);
    };
    return Object.freeze({
      spawn: (prefabId: string, options: Parameters<BehaviorSpawnControl['spawn']>[1]): string | null => {
        const def = typeof prefabId === 'string' ? this.host.prefabs.get(prefabId) : undefined;
        if (def === undefined) {
          const known = [...this.host.prefabs.keys()].slice(0, 8).join(', ') || 'none in this game';
          return refuse('behavior_spawn_invalid', `ctx.spawn: unknown prefab ${JSON.stringify(String(prefabId))} (known: ${known})`);
        }
        const parsed = parseSpawnOptions(def, options);
        if (!parsed.ok) return refuse('behavior_spawn_invalid', `ctx.spawn("${def.prefabId}"): ${parsed.message}`);
        const properties = parsed.placement.properties;
        if (properties !== undefined) {
          const problem = this.host.valuesProblem(def.entities[0]!.components.behavior!.behaviorId, properties);
          if (problem !== null) return refuse('behavior_spawn_invalid', `ctx.spawn("${def.prefabId}"): properties: ${problem}`);
        }
        const live = this.host.spawned().size - this.host.liveCount() + this.reserved.size;
        if (this.spawnsThisStep >= MAX_SPAWNS_PER_STEP || live + def.entities.length > MAX_LIVE_SPAWNED) {
          this.logRefusal(this.spawnsThisStep >= MAX_SPAWNS_PER_STEP
            ? `ctx.spawn("${def.prefabId}") refused: at most ${MAX_SPAWNS_PER_STEP} spawns per step`
            : `ctx.spawn("${def.prefabId}") refused: at most ${MAX_LIVE_SPAWNED} spawned entities alive (destroy some)`);
          return null;
        }
        this.spawnsThisStep += 1;
        const ids = def.entities.map(() => this.allocate());
        this.ops.push({ op: 'spawn', entities: expandPrefab(def, ids, parsed.placement, (b) => this.host.entityRefKeysOf(b)), ...(origin !== undefined ? { origin } : {}), ...(properties !== undefined ? { properties } : {}) });
        return ids[0]!;
      },
      destroy: (entityId: string): boolean => {
        if (typeof entityId !== 'string') return refuse('behavior_destroy_invalid', 'ctx.destroy: entityId must be a string');
        if (this.host.live(entityId)) return refuse('behavior_destroy_refused', `ctx.destroy: "${entityId}" is a live block's object: it goes with its cell (ctx.grid.clear)`);
        if (this.host.spawned().has(entityId) || this.reserved.has(entityId)) {
          if (this.pendingDestroys.has(entityId)) return false;
          this.pendingDestroys.add(entityId);
          this.ops.push({ op: 'destroy', entityId });
          return true;
        }
        if (this.host.transformOf(entityId) !== undefined) {
          return refuse('behavior_destroy_refused', `ctx.destroy: "${entityId}" is not a spawned entity (authored entities stay; hide one with ctx.game.setVisible)`);
        }
        return false;
      },
    });
  }

  /** The queued requests, in request order (the queue starts over). */
  take(): readonly SpawnOp[] {
    const ops = this.ops;
    this.ops = [];
    return ops;
  }

  /** A queued destroy was applied. */
  destroyApplied(entityId: string): void {
    this.pendingDestroys.delete(entityId);
  }

  /** A queued spawn is being applied: its ids are no longer reserved. */
  spawnApplied(op: Extract<SpawnOp, { op: 'spawn' }>): void {
    for (const e of op.entities) this.reserved.delete(e.id);
  }

  /** A queued spawn's copy is in the game: a save keeps the property values it was spawned with. */
  copyArrived(op: Extract<SpawnOp, { op: 'spawn' }>): void {
    if (op.properties !== undefined) this.copyProperties.set(op.entities[0]!.id, op.properties);
  }

  /** Spawned objects left the game. */
  removed(ids: Iterable<string>): void {
    if (this.copyProperties.size === 0) return;
    for (const id of ids) this.copyProperties.delete(id);
  }

  /** The step boundary: the per-step budget and its refusal line start over. */
  stepBoundary(): void {
    this.spawnsThisStep = 0;
    this.refusalLogged = false;
  }

  /** A new run: pending requests are dropped (ids keep counting). */
  clear(): void {
    this.ops = [];
    this.reserved.clear();
    this.pendingDestroys.clear();
  }

  /** The live spawned copies (prefab, ids in prefab order, the root's placement now, the copy's own property values). */
  savedCopies(): SavedSpawnCopy[] {
    const out: SavedSpawnCopy[] = [];
    const copyOf = new Map<string, string[]>();
    const roots: string[] = [];
    for (const e of this.host.spawned().values()) {
      // A live block's objects are saved with their cell (the grid section).
      if (this.pendingDestroys.has(e.id) || this.host.live(e.id)) continue;
      const parent = e.parentId;
      const ids = parent !== undefined ? copyOf.get(parent) : undefined;
      // Parents come before children: a child joins its parent's copy.
      if (ids !== undefined) {
        ids.push(e.id);
        copyOf.set(e.id, ids);
      } else {
        const own = [e.id];
        copyOf.set(e.id, own);
        roots.push(e.id);
      }
    }
    for (const rootId of roots) {
      const root = this.host.spawned().get(rootId)!;
      const prefabId = (root.components as { prefab?: { prefabId?: string } }).prefab?.prefabId;
      const t = this.host.transformOf(rootId);
      if (prefabId === undefined || t === undefined) continue;
      const properties = this.copyProperties.get(rootId);
      out.push({ prefabId, ids: [...copyOf.get(rootId)!], position: [t.position[0], t.position[1], t.position[2]], rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]], scale: [t.scale[0], t.scale[1], t.scale[2]], ...(properties !== undefined ? { properties: structuredClone(properties) as Record<string, unknown> } : {}) });
    }
    return out;
  }

  /** Why a save's `spawned` section cannot be restored (null: it can). */
  savedCopiesProblem(value: unknown): string | null {
    if (!Array.isArray(value)) return 'the spawned section is a list';
    const seen = new Set<string>();
    let total = 0;
    for (const c of value as SavedSpawnCopy[]) {
      if (typeof c !== 'object' || c === null || typeof c.prefabId !== 'string' || !Array.isArray(c.ids)) return 'a spawned copy is { prefabId, ids, position, rotation, scale, properties? }';
      const def = this.host.prefabs.get(c.prefabId);
      if (def === undefined) return `prefab "${c.prefabId.slice(0, 64)}" is not in this game`;
      if (c.ids.length !== def.entities.length) return `the copy of "${c.prefabId}" has ${c.ids.length} ids; the prefab has ${def.entities.length} objects`;
      for (const id of c.ids) {
        if (typeof id !== 'string' || !/^spawn-[1-9][0-9]{0,15}$/.test(id) || seen.has(id)) return 'spawned ids are spawn-<n>, each once';
        if (this.host.inGame(id) && !this.host.spawned().has(id)) return `"${id}" is an object of the scene`;
        seen.add(id);
      }
      total += c.ids.length;
      const parsed = parseSpawnOptions(def, savedOptions(c));
      if (!parsed.ok) return `the copy of "${c.prefabId}": ${parsed.message}`;
      if (parsed.placement.properties !== undefined) {
        const problem = this.host.valuesProblem(def.entities[0]!.components.behavior!.behaviorId, parsed.placement.properties);
        if (problem !== null) return `the copy of "${c.prefabId}": properties: ${problem}`;
      }
    }
    if (total > MAX_LIVE_SPAWNED) return `at most ${MAX_LIVE_SPAWNED} spawned objects`;
    return null;
  }

  /** The spawned copies become the saved ones at the next step boundary (checked with `savedCopiesProblem`). */
  restore(copies: readonly SavedSpawnCopy[]): void {
    this.ops = [];
    this.reserved.clear();
    this.pendingDestroys.clear();
    const spawned = this.host.spawned();
    for (const e of spawned.values()) {
      if ((e.parentId !== undefined && spawned.has(e.parentId)) || this.host.live(e.id)) continue;
      this.pendingDestroys.add(e.id);
      this.ops.push({ op: 'destroy', entityId: e.id });
    }
    for (const c of copies) {
      const def = this.host.prefabs.get(c.prefabId)!;
      const parsed = parseSpawnOptions(def, savedOptions(c));
      if (!parsed.ok) continue;
      for (const id of c.ids) {
        this.reserved.add(id);
        const n = Number(id.slice(SPAWN_ID_PREFIX.length));
        if (n > this.spawnSerial) this.spawnSerial = n;
      }
      const properties = parsed.placement.properties;
      this.ops.push({ op: 'spawn', entities: expandPrefab(def, c.ids, parsed.placement, (b) => this.host.entityRefKeysOf(b)), ...(properties !== undefined ? { properties } : {}) });
    }
  }

  /** The next free `spawn-<n>` id of this game (skipping any id already in it). */
  private allocate(): string {
    for (;;) {
      this.spawnSerial += 1;
      const id = `${SPAWN_ID_PREFIX}${this.spawnSerial}`;
      if (!this.host.inGame(id) && !this.reserved.has(id)) {
        this.reserved.add(id);
        return id;
      }
    }
  }

  /** One `spawn_refused` diagnostic per step (a runaway loop does not flood the ring). */
  private logRefusal(message: string): void {
    if (this.refusalLogged) return;
    this.refusalLogged = true;
    this.host.refused(message);
  }
}

/** A saved copy's placement as spawn options (older saves have no properties). */
function savedOptions(c: SavedSpawnCopy): Record<string, unknown> {
  return { position: c.position, rotation: c.rotation, scale: c.scale, ...(c.properties !== undefined ? { properties: c.properties } : {}) };
}
