/**
 * The physics bridge: the colliders in the physics world, the player
 * controllers and their placements (respawns, arrivals, a save's placement,
 * scripts' placements and walks), the physics queries scripts make, the
 * active player spawn and `ctx.lifecycle`.
 *
 * Bodies over streamed ground that is not loaded are suspended here
 * (`body-suspension.ts`): one rule for the characters, patrols and gravity
 * bodies.
 *
 * Placements go through the port here, where a port failure fail-stops the
 * run.
 */
import type { EntityV3 } from '@thirdlight/project-model';

import type { GameplayBlocks } from './blocks';
import { BodySuspension } from './body-suspension';
import { CharacterDirector } from './character-director';
import { CharacterPlacement, ControllerPlacements } from './character-placement';
import { ColliderSystem } from './collider-system';
import type { EntityAccess } from './entity-access';
import { clipMessage } from './errors';
import type { RuntimeGrid } from './grid';
import { phaseScopedState } from './guard';
import type { KeptObjects } from './kept';
import { PhysicsQueries } from './physics-queries';
import { PlaneLocks } from './plane-locks';
import { PlayerControllers } from './player-controllers';
import type { Vec2 } from './ports';
import type { RuntimeFaults } from './runtime-faults';
import type { RuntimeInput } from './runtime-input';
import type { RuntimePhases } from './runtime-phases';
import type { RuntimeScenes } from './runtime-scenes';
import type { RuntimeSim } from './runtime-sim';
import { LIFECYCLE_RESTART_DEPRECATED } from './scene-control';
import type { LiveTagIndex } from './scene-set';
import type { BehaviorLifecycle, ModuleResetContext } from './types';
import type { RuntimeViews } from './views';

/** The parts the physics bridge reaches (read when used: some are made after it). */
export interface CharacterHost {
  readonly blocks: GameplayBlocks | null;
  readonly grid: RuntimeGrid;
  readonly views: RuntimeViews;
  readonly kept: KeptObjects;
  readonly scenes: RuntimeScenes;
  readonly phases: RuntimePhases;
  readonly entityAccess: EntityAccess;
  readonly input: RuntimeInput;
  readonly queryTags: LiveTagIndex | null;
  /** A run restart at the next step boundary (`ctx.lifecycle.restart`). */
  requestRestart(): void;
  /** Where the active camera's yaw comes from, if not the camera brain (null: the brain's view). */
  yawSource(): (() => number | undefined) | null;
}

export class RuntimeCharacters {
  /** The colliders in the physics world: placed where their objects are, and those that follow a moving object. */
  readonly colliders: ColliderSystem;
  /** The player controllers (several share the view in local co-op; the first is what a call naming none means). */
  readonly controllers: PlayerControllers;
  /** Respawns, arrivals, a save's placement and script placements of each player controller, and the way it faces. */
  readonly placement: ControllerPlacements;
  /** Placements, walks, turns, impulses and a cutscene's hold on the player controllers (`ctx.character`, the character track). */
  readonly director: CharacterDirector;
  /** `ctx.physics` (and the engine modules' queries) with the step's query budget. */
  readonly queries: PhysicsQueries;
  /** The plane locks scripts set and clear (applied at step boundaries). */
  readonly planes: PlaneLocks;
  /** `ctx.lifecycle`: respawn, the spawn point and the restart. */
  readonly lifecycle: BehaviorLifecycle;
  /** Which bodies the engine moves are outside the loaded collision this step (they stand still). */
  readonly suspension: BodySuspension;
  /** The player spawn respawns use (null: the first one loaded, else where the player started). */
  activeSpawn: string | null = null;
  /** `port.step()` calls. */
  physicsSteps = 0;

  constructor(
    private readonly sim: RuntimeSim,
    private readonly faults: RuntimeFaults,
    private readonly host: CharacterHost,
    a: { controllerEntityIds: readonly string[]; initialEntities: readonly EntityV3[]; modelColliders?: import('@thirdlight/project-model').ModelColliderTable },
  ) {
    const sim_ = sim;
    // A terrain tile in its ring collides once its data has arrived.
    const tileReady = (entityId: string, key: string): boolean => host.grid.terrain.tileReady(entityId, key);
    this.suspension = new BodySuspension((x, z) => host.grid.stream.loadedAt(x, z, tileReady), () => host.grid.stream.active);
    this.colliders = new ColliderSystem({
      get physics3d() {
        return sim_.physics3d;
      },
      curr: () => sim.curr,
      parentOf: (id) => sim.parentOf(id),
      inactive: () => host.entityAccess.inactive(),
      ownedIds: () => sim.entries.flatMap((entry) => entry.owners),
      componentsOf: (id) => host.scenes.entityDocument(id)?.components as unknown as Readonly<Record<string, unknown>> | undefined,
      warn: (message) => faults.log('thirdlight.runtime:colliders', 'warn', message),
      planeOf: (id) => this.planes.scriptPlane(id),
    }, a.modelColliders);
    if (sim.physics3d !== undefined) this.colliders.track(a.initialEntities);
    this.controllers = new PlayerControllers({
      hz: sim.hz,
      settings: sim.settings,
      physics3d: sim.physics3d,
      curr: () => sim.curr,
      currentPhase: () => sim.currentPhase,
      carry3D: (id) => host.blocks?.carryDelta3(id) ?? [0, 0, 0],
      flushCollision: () => host.grid.flushCollision(sim.physics3d),
      countStep: () => void (this.physicsSteps += 1),
      status3D: (id) => {
        for (const entry of sim.entries) {
          const probe = entry.instance as { character3DStatus?: (id?: string) => { enabled: boolean; climbing: boolean; yaw: number } | null };
          if (typeof probe.character3DStatus === 'function') return probe.character3DStatus(id);
        }
        return null;
      },
      placed: (id) => host.blocks?.placed(id),
      suspended: (id) => this.suspension.has(id),
    }, a.controllerEntityIds, a.initialEntities);
    this.placement = new ControllerPlacements(this.controllers.ids, (id) => this.buildPlacement(id), (sceneId) => host.scenes.isLoading(sceneId));
    const controllers = this.controllers;
    this.director = new CharacterDirector({
      hz: () => sim.hz, settings: () => sim.settings, resolve: (id) => controllers.resolve(id), transform: (id) => sim.curr.get(id), entityDocument: (id) => host.scenes.entityDocument(id),
      channels: (id) => host.phases.channelsOf(id), placeFacing: (id, degrees) => this.placement.of(id)?.placeFacing(degrees), turn: (id, yaw) => this.placement.of(id)?.turn(yaw),
      canPlace: () => sim.physics3d !== undefined, addImpulse: (id, v) => controllers.addImpulse(id, v),
      intentsChanged: () => host.phases.changed(), warn: (message) => faults.log('thirdlight.runtime:character', 'warn', message), loading: () => host.scenes.anyLoading(), moveAction: (id) => controllers.actionsOf(id)?.move,
      setPlane: (id, plane) => this.planes.request(id, plane),
    });
    const colliders = this.colliders;
    this.planes = new PlaneLocks({
      get physics3d() { return sim_.physics3d; },
      isCharacter: (id) => controllers.has(id),
      hasBody: (id) => colliders.has(id),
      setCharacterPlane: (id, plane) => void controllers.setPlane(id, plane),
      characterPlane: (id) => controllers.planeOf(id),
      componentsOf: (id) => host.scenes.entityDocument(id)?.components as unknown as Readonly<Record<string, unknown>> | undefined,
      curr: () => sim.curr,
      parentOf: (id) => sim.parentOf(id),
    });
    this.queries = new PhysicsQueries({
      get physics3d() { return sim_.physics3d; },
      controllers,
      get views() { return host.views; },
      get grid() { return host.grid; },
      get tags() { return host.queryTags; },
      planes: this.planes,
      scenePlaneOf: (id) => host.scenes.planeOf(id),
      suspension: this.suspension,
      pointer: () => host.input.pointer(),
      stepIndex: () => sim.stepIndex,
      warn: (m) => faults.log('thirdlight.runtime:physics', 'warn', m),
    });
    this.lifecycle = this.buildLifecycle();
  }

  /**
   * The step boundary, after the streaming rings moved: the characters (at
   * their positions) and the gameplay blocks' bodies are tested against the
   * loaded collision; those outside stand still this step.
   */
  suspendBodies(): void {
    const curr = this.sim.curr;
    const blocks = this.host.blocks;
    this.suspension.update((test) => {
      for (const id of this.controllers.ids) {
        const t = curr.get(id);
        if (t !== undefined) test(id, t.position[0], t.position[2]);
      }
      blocks?.primitives.suspensionPoints(test);
    });
  }

  /** A player controller's placement view of the runtime (placements go through the ports here, where a failure fail-stops). */
  private buildPlacement(controllerId: string): CharacterPlacement {
    const sim = this.sim;
    const host = this.host;
    return new CharacterPlacement({
      controllerId: () => controllerId,
      transform: (id) => sim.curr.get(id),
      entityDocument: (id) => host.scenes.entityDocument(id),
      sceneLoading: (sceneId) => host.scenes.isLoading(sceneId),
      setActiveSpawn: (spawnId) => {
        this.activeSpawn = spawnId;
      },
      arrivalMissed: (message) => this.faults.record({ code: 'scene_invalid', message: clipMessage(message), stepIndex: sim.stepIndex, reason: 'transfer' }),
      isKept: (id) => host.kept.has(id),
      listedSpawnOf: (sceneId) => host.scenes.listedSpawnOf(sceneId),
      place3D: (x, y, z) => this.controllers.place3D(controllerId, x, y, z),
      intents: () => host.phases.channelsOf(controllerId),
      intentsChanged: () => host.phases.changed(),
      setImpulse: (v) => this.controllers.setImpulse(controllerId, v),
      // The way it faces too (the controller's yaw, as characterState().facing reads it).
      lastMotion: () => this.controllers.lastMotion(controllerId),
      hz: () => sim.hz,
    });
  }

  /** Build one `ModuleResetContext` (the character was placed). */
  resetContext(reset: 'replay' | 'transfer', ordinal: number, target: Vec2, writableOwners: ReadonlySet<string>, characterId?: string): ModuleResetContext {
    const sim = this.sim;
    return Object.freeze({
      reason: reset,
      stepIndex: ordinal,
      playerCenter: Object.freeze({ ...target }),
      ...(characterId !== undefined ? { characterId } : {}),
      state: phaseScopedState({
        order: sim.order,
        entities: sim.entities,
        stepIndex: sim.stepIndex,
        simTime: sim.simTime,
        prev: sim.prev,
        curr: sim.curr,
        writableOwners,
      }),
    });
  }

  /** The player spawns loaded now, in entity order. */
  private playerSpawnIds(): string[] {
    const out: string[] = [];
    for (const id of this.sim.order) if (this.sim.entities.get(id)?.componentKinds?.includes('playerSpawn') === true) out.push(id);
    return out;
  }

  /** Where a respawn puts a player controller: the spawn's position, else where it started (null: no such controller). */
  private respawnTarget(spawnId: string | null, player: string): [number, number, number] | null {
    const id = spawnId ?? this.activeSpawn ?? this.playerSpawnIds()[0] ?? null;
    const t = id !== null ? this.sim.curr.get(id) : undefined;
    if (t !== undefined) return [t.position[0], t.position[1], t.position[2]];
    const data = this.sim.entities.get(player);
    return data === undefined ? null : [data.transform.position[0], data.transform.position[1], data.transform.position[2]];
  }

  private buildLifecycle(): BehaviorLifecycle {
    const spawnOk = (id: unknown): id is string => typeof id === 'string' && this.sim.entities.get(id)?.componentKinds?.includes('playerSpawn') === true;
    return Object.freeze({
      respawn: (spawnId?: string, entityId?: string): boolean => {
        const player = typeof entityId === 'string' || entityId === undefined ? this.controllers.resolve(entityId) : undefined;
        if (player === undefined) return false;
        if (spawnId !== undefined && spawnId !== '' && !spawnOk(spawnId)) return false;
        if (spawnId !== undefined && spawnId !== '') this.activeSpawn = spawnId;
        const target = this.respawnTarget(null, player);
        if (target === null) return false;
        this.placement.of(player)?.requestRespawn(target);
        return true;
      },
      setSpawn: (spawnId: string): boolean => {
        if (!spawnOk(spawnId)) return false;
        this.activeSpawn = spawnId;
        return true;
      },
      spawnPoint: (): string => this.activeSpawn ?? this.playerSpawnIds()[0] ?? '',
      restart: (): boolean => {
        this.host.requestRestart();
        this.faults.problem(LIFECYCLE_RESTART_DEPRECATED.code, `ctx.lifecycle.restart() is deprecated and will be removed (it restarts the whole run); use ${LIFECYCLE_RESTART_DEPRECATED.replacement} — see the migration notes`);
        return true;
      },
    });
  }

  /** A run's start at a step boundary, the first run's and every restart's alike (the physics world, the bodies); false after a fail-stop. */
  startRun(): boolean {
    try {
      // The planes scripts set go back to the authored ones before the world is rebuilt.
      this.planes.restart();
      this.controllers.startRun();
    } catch (e) {
      this.faults.failStopFromError(e, this.sim.stepIndex);
    }
    return this.sim.stateName !== 'failed';
  }

  /** The plane locks scripts asked for in the last step take effect (false after a fail-stop). */
  applyPlanes(): boolean {
    try {
      this.planes.applyAtBoundary();
    } catch (e) {
      this.faults.failStopFromError(e, this.sim.stepIndex);
    }
    return this.sim.stateName !== 'failed';
  }

  /** Bring the moving colliders up to date at a step boundary (false after a fail-stop). */
  syncColliders(): boolean {
    const failed = this.colliders.sync();
    if (failed === null) return true;
    this.faults.failStop('physics_port_error', 'script_colliders', failed, this.sim.stepIndex);
    return false;
  }

  /**
   * The active camera's yaw for the 3D character's move input —
   * radians about +Y (0 looking along −Z) — or undefined (world axes). It is
   * the camera brain's committed view (resolved in the simulation at the
   * end of the previous step, so a replay reads the same yaw); without virtual cameras the character moves along world axes. An
   * injected source (`CharacterHost.yawSource`) takes precedence.
   */
  cameraYaw3D(): number | undefined {
    const source = this.host.yawSource();
    if (source !== null) {
      const v = source();
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    }
    return this.host.views.yaw();
  }

  /**
   * Objects were switched off or on (with their children): their colliders
   * leave the physics world (and come back where they are now); a port
   * failure fail-stops.
   */
  activeChanged(off: readonly string[], on: readonly string[]): void {
    const colliderOf = (id: string): boolean => !this.controllers.has(id) && this.sim.entities.get(id)?.hasCollider === true;
    const leaving = off.filter(colliderOf);
    const coming = on.filter(colliderOf);
    if (leaving.length === 0 && coming.length === 0) return;
    const failed = this.colliders.activeChanged(leaving, coming);
    if (failed !== null) this.faults.failStop('physics_port_error', 'entity_active', failed, this.sim.stepIndex);
  }
}
