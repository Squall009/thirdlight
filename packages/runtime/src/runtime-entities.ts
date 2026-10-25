/**
 * The entity set: how objects come into the simulation and leave it — a
 * loaded scene's, a spawned prefab copy's, a live block's — with everything
 * that belongs to them (state and draw order, colliders, tags, animators,
 * gameplay blocks, views, sockets, written fields, sounds), and the scripts'
 * spawn and destroy requests applied at the step boundary.
 *
 * Every part an object reaches is told in one place, in a fixed order, so a
 * load, an unload, a reload and a spawn release and rebuild alike.
 */
import type { EntityV3, PrefabDefinition } from '@thirdlight/project-model';

import type { AnimatorSystem } from './animator-system';
import { arrivalProblem, playersArrive } from './arriving-players';
import type { AudioMixer } from './audio-mixer';
import type { GameplayBlocks } from './blocks';
import type { ControllerPlacements } from './character-placement';
import type { PlaneLocks } from './plane-locks';
import type { ColliderSystem } from './collider-system';
import type { EntityAccess } from './entity-access';
import { clipMessage } from './errors';
import type { RuntimeGrid } from './grid';
import type { KeptObjects } from './kept';
import type { RuntimeMaterials } from './material-params';
import type { PlayerControllers } from './player-controllers';
import type { RuntimeFaults } from './runtime-faults';
import { cloneTransform, messageOf, type ModuleEntry, type RuntimeSim } from './runtime-sim';
import type { LiveTagIndex } from './scene-set';
import type { SocketSystem } from './sockets';
import { SpawnRequests } from './spawn-requests';
import { SpawnScenes } from './spawn-scenes';
import { deepFreeze } from './snapshot';
import type { BehaviorSpawnControl, SimEntityData, SimulationPhaseModule } from './types';
import type { RuntimeViews } from './views';

/** The parts an object reaches, and the scene set's two answers about spawned copies. */
export interface EntityHost {
  readonly kept: KeptObjects;
  readonly colliders: ColliderSystem;
  /** The plane locks scripts set (an object that leaves the game drops its own). */
  readonly planes: PlaneLocks;
  readonly grid: RuntimeGrid;
  readonly controllers: PlayerControllers;
  readonly placement: ControllerPlacements;
  readonly materials: RuntimeMaterials;
  readonly animators: AnimatorSystem;
  readonly blocks: GameplayBlocks | null;
  readonly views: RuntimeViews;
  readonly sockets: SocketSystem;
  readonly entityAccess: EntityAccess;
  readonly audio: AudioMixer;
  readonly liveTags: LiveTagIndex | null;
  /** The step's transform-intent bits per entity (an object that leaves takes its entry along). */
  intentAxes(): Map<string, number>;
  /** The loaded scene holding an object (undefined: none). */
  sceneOf(entityId: string): string | undefined;
  /** The scene set's view is stale (copies came or went). */
  sceneSetChanged(): void;
}

export class RuntimeEntities {
  readonly prefabs: ReadonlyMap<string, PrefabDefinition>;
  /** The live spawned entities, in spawn order (parents before children). */
  readonly spawned = new Map<string, EntityV3>();
  /** `ctx.spawn` / `ctx.destroy` requests waiting for the next step boundary, and the saved copies. */
  readonly spawnRequests: SpawnRequests;
  /** `ctx.spawn` of scripts that name no spawner. */
  readonly spawnControl: BehaviorSpawnControl;
  /** Each script object's own `ctx.spawn` (its copies are spawned in its scene). */
  private readonly spawnControls = new Map<string, BehaviorSpawnControl>();
  /** The scene each spawned copy was spawned in (a scene reload removes them). */
  private readonly spawnScenes = new SpawnScenes();
  /** The behavior group of each loaded entity that carries one (`behaviorGroup` component). */
  readonly behaviorGroupOf = new Map<string, string>();
  readonly spawnerOwned = (entityId: string): BehaviorSpawnControl => {
    let c = this.spawnControls.get(entityId);
    if (c === undefined) this.spawnControls.set(entityId, (c = this.spawnRequests.control(entityId)));
    return c;
  };
  /**
   * A behavior's `entityRef` property keys (its module's
   * declaration), for the typed remap of prefab-local references in spawned
   * copies; undefined for a behavior this game has no module for.
   */
  readonly entityRefKeysOf = (behaviorId: string): readonly string[] | undefined => {
    const entry = this.sim.entries.find((e) => e.id === `thirdlight.behavior:${behaviorId}`);
    const probe = entry?.instance as { behaviorEntityRefKeys?: () => readonly string[] } | undefined;
    return typeof probe?.behaviorEntityRefKeys === 'function' ? probe.behaviorEntityRefKeys() : undefined;
  };

  constructor(
    private readonly sim: RuntimeSim,
    private readonly faults: RuntimeFaults,
    private readonly host: EntityHost,
    prefabs: readonly PrefabDefinition[],
  ) {
    this.prefabs = new Map(prefabs.map((d) => [d.prefabId, d]));
    this.spawnRequests = new SpawnRequests({
      prefabs: this.prefabs,
      spawned: () => this.spawned,
      live: (id) => this.host.grid.isLive(id),
      liveCount: () => this.host.grid.liveCount,
      inGame: (id) => this.sim.entities.has(id),
      transformOf: (id) => this.sim.curr.get(id),
      entityRefKeysOf: (b) => this.entityRefKeysOf(b),
      valuesProblem: (b, values) => this.behaviorValuesProblem(b, values),
      refused: (message) => this.faults.record({ code: 'spawn_refused', message: clipMessage(message), stepIndex: this.sim.stepIndex }),
    });
    this.spawnControl = this.spawnRequests.control();
  }

  /** Why values cannot be a spawned copy's own for a behavior (its module's declaration; null: they can, or no module checks them). */
  private behaviorValuesProblem(behaviorId: string, values: Readonly<Record<string, unknown>>): string | null {
    const entry = this.sim.entries.find((e) => e.id === `thirdlight.behavior:${behaviorId}`);
    const probe = entry?.instance as { behaviorValuesProblem?: (v: Readonly<Record<string, unknown>>) => string | null } | undefined;
    return typeof probe?.behaviorValuesProblem === 'function' ? probe.behaviorValuesProblem(values) : null;
  }

  /** The behavior groups of entities that came in. */
  noteBehaviorGroups(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const g = (e.components as { behaviorGroup?: { group?: unknown } }).behaviorGroup?.group;
      if (typeof g === 'string') this.behaviorGroupOf.set(e.id, g);
    }
  }

  // ---- Coming in and leaving -----------------------------------------------

  /**
   * Put resolved, frozen entities into the simulation: state, draw order,
   * tags, animators and gameplay blocks (a loaded scene, a spawned copy).
   */
  attach(frozen: readonly EntityV3[]): void {
    const sim = this.sim;
    const host = this.host;
    host.materials.addEntities(frozen);
    for (const e of frozen) {
      const t = e.components.transform;
      const data: SimEntityData = { id: e.id, parentId: e.parentId ?? null, transform: cloneTransform(t) };
      if (e.name !== undefined) data.name = e.name;
      data.componentKinds = Object.freeze(Object.keys(e.components));
      const box = e.components.box;
      if (box) data.box = { size: [box.size[0], box.size[1], box.size[2]], material: { color: box.material.color } };
      if ((e.components as { collider?: unknown }).collider !== undefined) data.hasCollider = true;
      sim.entities.set(e.id, data);
      sim.prev.set(e.id, cloneTransform(t));
      sim.curr.set(e.id, cloneTransform(t));
      sim.currShape += 1;
      sim.committed?.set(e.id, cloneTransform(t));
    }
    host.colliders.track(frozen);
    sim.order = [...sim.order, ...frozen.map((e) => e.id)];
    sim.entityCount = sim.order.length;
    // Their behavior groups (game modes tick groups).
    this.noteBehaviorGroups(frozen);
    host.liveTags?.add(frozen as readonly { id: string; tags?: number }[]);
    host.animators.add(frozen);
    host.blocks?.add(frozen);
    host.views.add(frozen);
    // Their models and authored sockets (resolved at the end of the step).
    host.sockets.add(frozen);
    // Children of a switched-off object arrive switched off.
    host.entityAccess.added();
  }

  /** The player controllers among attached entities (`playersArrive`). Returns false after a fail-stop. */
  playersArrive(frozen: readonly EntityV3[], placeReturning: boolean): boolean {
    const host = this.host;
    try {
      playersArrive(frozen, { controllers: host.controllers, placement: host.placement, blocks: host.blocks, transform: (id) => this.sim.curr.get(id) }, placeReturning);
    } catch (e) {
      this.faults.failStopFromError(e, this.sim.stepIndex);
      return false;
    }
    return true;
  }

  /** Tell the phased modules (the behavior host) about attached entities. Returns false after a fail-stop. */
  notifyLoaded(frozen: readonly EntityV3[]): boolean {
    const sim = this.sim;
    for (const entry of sim.entries) {
      const instance = entry.instance as SimulationPhaseModule;
      if (!entry.phased || typeof instance.sceneLoaded !== 'function') continue;
      sim.currentModuleId = entry.id;
      sim.currentPhase = undefined;
      try {
        instance.sceneLoaded(frozen);
      } catch (e) {
        this.faults.failStopFromError(e, sim.stepIndex);
        return false;
      }
      if (!this.refreshOwners(entry)) return false;
    }
    return true;
  }

  /**
   * Re-read a module's transform owners after entities came or
   * went (a behavior that owns "@self" owns each carrier, spawned copies
   * included). A new owner gets the instantiate-time checks: claimed by no
   * other module, not the camera, not a physics body. Returns false after a
   * fail-stop.
   */
  private refreshOwners(entry: ModuleEntry): boolean {
    if (!entry.phased) return true;
    const sim = this.sim;
    const next = (entry.instance as SimulationPhaseModule).transformOwners;
    if (next === entry.owners || !Array.isArray(next)) return true;
    const before = new Set(entry.owners);
    for (const id of next) {
      if (before.has(id)) continue;
      const other = sim.entries.find((en) => en !== entry && en.owners.includes(id));
      if (other !== undefined) {
        this.faults.failStop('transform_owner_conflict', id, `entity "${id}" is claimed by "${other.id}" and "${entry.id}"`, sim.stepIndex, entry.id);
        return false;
      }
      const data = sim.entities.get(id);
      // In 3D a script may drive a collider no mover moves (posed as a kinematic body).
      const drivable = sim.physics3d !== undefined && this.host.colliders.drivableId(id);
      const physicsBody = (data?.hasCollider === true && !drivable) || this.host.controllers.has(id);
      if (physicsBody && !entry.phases.includes('controller')) {
        const what = 'physics_entity';
        this.faults.failStop('transform_owner_forbidden', what, `module "${entry.id}" claims physics entity "${id}"`, sim.stepIndex, entry.id, undefined, what);
        return false;
      }
    }
    entry.owners = [...next];
    this.host.colliders.markDirty();
    return true;
  }

  /** Take entities out of the simulation and release what belongs to them (`what` names them in diagnostics). */
  detach(ids: ReadonlySet<string>, colliderIds: readonly string[], what: string, how: 'unload' | 'reload' = 'unload'): void {
    const sim = this.sim;
    const host = this.host;
    host.kept.removed(ids);
    // Sockets of (and on) these entities let go.
    host.sockets.remove(ids);
    host.materials.removeEntities(ids);
    for (const id of ids) {
      this.spawnControls.delete(id);
      this.behaviorGroupOf.delete(id);
    }
    host.colliders.forget(ids);
    host.planes.forget(ids);
    for (const entry of sim.entries) {
      const instance = entry.instance as SimulationPhaseModule;
      if (!entry.phased || typeof instance.sceneUnloaded !== 'function') continue;
      try {
        instance.sceneUnloaded(ids, how);
      } catch (e) {
        this.faults.record({ code: 'scene_load_failed', message: clipMessage(`module "${entry.id}" failed to release ${what}: ${messageOf(e)}`), stepIndex: sim.stepIndex, reason: 'unload', moduleId: entry.id });
      }
      // Owners that left ("@self" carriers) are released.
      const owners = instance.transformOwners;
      if (Array.isArray(owners)) entry.owners = owners.filter((id) => !ids.has(id));
    }
    // Unloaded block layers take their chunk colliders and their live blocks' objects along.
    const gridColliders = host.grid.removeLayers(ids);
    this.removeSpawnedIds(new Set(host.grid.takeGoneLive().filter((id) => this.spawned.has(id))));
    if (gridColliders.length > 0 && typeof sim.physics3d?.removeStaticColliders === 'function') {
      try {
        sim.physics3d.removeStaticColliders(gridColliders);
      } catch (e) {
        this.faults.record({ code: 'scene_load_failed', message: clipMessage(`removing the block colliders of ${what} failed: ${messageOf(e)}`), stepIndex: sim.stepIndex, reason: 'unload' });
      }
    }
    if (colliderIds.length > 0 && typeof sim.physics3d?.removeStaticColliders === 'function') {
      try {
        sim.physics3d.removeStaticColliders(colliderIds);
      } catch (e) {
        this.faults.record({ code: 'scene_load_failed', message: clipMessage(`removing the colliders of ${what} failed: ${messageOf(e)}`), stepIndex: sim.stepIndex, reason: 'unload' });
      }
    }
    const axes = host.intentAxes();
    for (const id of ids) {
      sim.entities.delete(id);
      sim.prev.delete(id);
      sim.curr.delete(id);
      sim.currShape += 1;
      sim.committed?.delete(id);
      axes.delete(id);
    }
    sim.order = sim.order.filter((id) => !ids.has(id));
    sim.entityCount = sim.order.length;
    host.liveTags?.remove(ids);
    host.animators.remove(ids);
    host.blocks?.remove(ids);
    host.views.remove(ids);
    // Their written fields go with them.
    host.entityAccess.removed(ids);
    // So do the sounds they own.
    host.audio.entitiesGone(ids);
  }

  // ---- Keeping objects loaded ------------------------------------------------

  /** Why a script cannot switch an object's keep flag now (null: it can). */
  keepProblem(id: string, keep: boolean): string | null {
    const kept = this.host.kept;
    const parent = this.sim.entities.get(id)?.parentId ?? null;
    if (parent !== null && kept.has(parent)) return keep ? null : `its parent "${parent}" keeps it loaded`;
    if (keep && parent !== null) return `its parent "${parent}" is not kept loaded (the object would go with it)`;
    if (!keep && kept.orphan(id) !== undefined) return 'its scene is not loaded: it would have nowhere to be';
    return null;
  }

  /** Keep (or stop keeping) an object and everything under it (a script's write, at the end of the step). */
  setKept(id: string, keep: boolean): void {
    const subtree = new Set([id]);
    for (const other of this.sim.order) {
      const p = this.sim.entities.get(other)?.parentId;
      if (p !== null && p !== undefined && subtree.has(p)) subtree.add(other);
    }
    this.host.kept.set([...subtree], keep);
  }

  // ---- Spawned prefab copies ---------------------------------------------------

  /** The queued spawns and destroys, in request order. Returns false after a fail-stop. */
  applySpawnOps(): boolean {
    const ops = this.spawnRequests.take();
    for (const op of ops) {
      if (op.op === 'destroy') {
        this.spawnRequests.destroyApplied(op.entityId);
        this.removeSpawned(op.entityId);
        continue;
      }
      this.spawnRequests.spawnApplied(op);
      if (!this.addSpawned(op.entities)) return false;
      if (!this.spawned.has(op.entities[0]!.id)) continue;
      this.spawnRequests.copyArrived(op);
      // Spawned in the spawner's scene (a kept or scene-less spawner: none).
      const origin = op.origin;
      if (origin !== undefined && !this.host.kept.has(origin)) {
        this.spawnScenes.record(op.entities.map((e) => e.id), this.host.sceneOf(origin) ?? this.spawnScenes.sceneOf(origin));
      }
    }
    return true;
  }

  /**
   * The live blocks' objects follow their cells: those of the cells changed
   * since the last call go and come through the spawned-copy path. Returns
   * false after a fail-stop.
   */
  syncLiveBlocks(): boolean {
    const d = this.host.grid.takeLive((id) => this.sim.entities.has(id), (b) => this.entityRefKeysOf(b));
    if (d === null) return true;
    this.removeSpawnedIds(new Set(d.remove.filter((id) => this.spawned.has(id))));
    if (d.refused.length > 0) {
      const message = clipMessage(`live blocks not spawned: objects of the game already have the ids ${d.refused.slice(0, 4).join(', ')}`);
      this.faults.record({ code: 'spawn_refused', message, stepIndex: this.sim.stepIndex });
    }
    return d.add.length === 0 || this.addSpawned(d.add, true);
  }

  /** Add one spawned copy (colliders, state, blocks, scripts; `owned`: made for this call, not copied again). Returns false after a fail-stop. */
  private addSpawned(entities: readonly EntityV3[], owned = false): boolean {
    const root = entities[0]!;
    const clash = entities.find((e) => this.sim.entities.has(e.id));
    if (clash !== undefined) {
      this.faults.record({ code: 'spawn_refused', message: clipMessage(`spawn "${root.id}" was not added: entity "${clash.id}" is already in the game`), stepIndex: this.sim.stepIndex });
      return true;
    }
    // A spawned player (a prefab with a controller) needs a port that adds characters, as a loaded scene's does.
    const players = arrivalProblem(entities, this.host.controllers, this.sim.physics3d);
    if (players !== null) {
      this.faults.record({ code: 'spawn_refused', message: clipMessage(`spawn "${root.id}" was not added: ${players}`), stepIndex: this.sim.stepIndex });
      return true;
    }
    const frozen = deepFreeze(owned ? [...entities] : entities.map((e) => structuredClone(e)));
    const added = this.host.colliders.add(frozen, `spawn "${root.id}"`);
    if (!added.ok && 'refused' in added) {
      this.faults.record({ code: 'spawn_refused', message: clipMessage(`spawn "${root.id}" was not added: ${added.refused}`), stepIndex: this.sim.stepIndex });
      return true;
    }
    if (!added.ok && 'failed' in added) {
      this.faults.failStop('physics_port_error', 'spawn_colliders', added.failed, this.sim.stepIndex);
      return false;
    }
    this.host.kept.add(frozen);
    this.attach(frozen);
    for (const e of frozen) this.spawned.set(e.id, e);
    this.host.sceneSetChanged();
    return this.playersArrive(frozen, false) && this.notifyLoaded(frozen);
  }

  /** Remove a spawned entity and every spawned entity below it. */
  private removeSpawned(entityId: string): void {
    if (!this.spawned.has(entityId)) return;
    const ids = new Set<string>([entityId]);
    // Spawn order puts parents before children: one pass collects the subtree.
    for (const e of this.spawned.values()) if (e.parentId !== undefined && ids.has(e.parentId)) ids.add(e.id);
    this.removeSpawnedIds(ids);
  }

  removeSpawnedIds(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    const colliderIds = [...ids].filter((id) => (this.spawned.get(id)?.components as { collider?: unknown } | undefined)?.collider !== undefined);
    this.detach(ids, colliderIds, `spawned "${[...ids][0]}"`);
    // A spawned player never comes back (spawned ids are not reused): it leaves the players and the physics world.
    const players = new Set([...ids].filter((id) => this.host.controllers.has(id)));
    for (const id of players) {
      try {
        this.host.controllers.remove(id);
      } catch (e) {
        this.faults.failStopFromError(e, this.sim.stepIndex);
      }
      this.host.placement.remove(id);
    }
    if (players.size > 0) this.host.blocks?.remove(players, true);
    for (const id of ids) this.spawned.delete(id);
    this.spawnScenes.removed(ids);
    this.spawnRequests.removed(ids);
    this.host.sceneSetChanged();
  }

  /** The copies a scene's objects spawned (its kept ones stay). */
  copiesOf(sceneId: string): Set<string> {
    return this.spawnScenes.copiesOf(sceneId, (id) => this.host.kept.has(id));
  }

  /**
   * A new run: every spawned entity goes and pending requests are dropped. Ids
   * keep counting (never reused in one game), so an id a script kept from the
   * last run cannot name a new copy.
   */
  clearSpawned(): void {
    this.removeSpawnedIds(new Set(this.spawned.keys()));
    this.spawnRequests.clear();
  }
}
