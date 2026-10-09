/**
 * Making a runtime: the configuration and snapshot validated, the module
 * set resolved and checked (phases, ownership, exclusions, the physics
 * port), the initial simulation state built and one instance created per
 * module, then the runtime instance (`runtime.ts`) made of the result.
 */
import { resolveGameplaySettings, viewLensOf, type EntityV3 } from '@thirdlight/project-model';

import type { AnimatorControllerLike } from './animator';
import { BehaviorHostError, createTagQuery } from './behavior';
import { ColliderSystem } from './collider-system';
import type { RuntimeError } from './errors';
import type { BehaviorLogLevel } from './intents';
import type { PhysicsVec3 } from './ports';
import { validatePhaseList } from './registry';
import { cloneTransform, engineTimingSteps, messageOf, RuntimeInstance, type BehaviorLogSink, type ModuleEntry } from './runtime';
import { fail, parseConfig, PHYSICS_PORT_REASON } from './runtime-config';
import { deepFreeze, validateRuntimeSnapshot } from './snapshot';
import { SIM_REGISTRY_BRAND, type GameplaySettings, type ModuleConfig, type Runtime, type RuntimeSnapshot, type SimEntityData, type SimulationModule, type SimulationModuleSpec, type SimulationPhase, type SimulationPhaseModule, type TransformState } from './types';

/**
 * Create a runtime instance. Validates the snapshot
 * (deep-freezing it on success), resolves the selected modules, validates
 * the M2 phase/ownership/exclusion rules, builds the initial mutable state
 * (`prev = curr = snapshot transforms`, stepIndex 0, simTime 0), and creates
 * one module instance per selection entry. No loop, timer, listener, or
 * renderer is installed at instantiate.
 */
export function instantiateRuntime(
  config: unknown,
): { ok: true; runtime: Runtime } | { ok: false; error: RuntimeError } {
  const parsed = parseConfig(config);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const { snapshot, registry, modules, actions, physics, physics3d, settings, clock, clockLabel, driverKind, hz, onFrame, variables, projectSettings, startMode } = parsed.cfg;

  const snap = validateRuntimeSnapshot(snapshot);
  if ('error' in snap) return { ok: false, error: snap.error };
  // A start mode names one of the project's modes (ignored without modes).
  if (startMode !== undefined && snap.modes !== undefined && !snap.modes.modes.some((m) => m.modeId === startMode)) {
    return { ok: false, error: fail('config_invalid', `config field "startMode": the project has no game mode "${startMode}"`, { reason: 'reference', path: '/startMode' }) };
  }
  const { scene, sceneVersion, snapshotId, revision } = snap;
  // The scene catalog (v4 only; null: one fixed scene).
  const sceneRows = snap.scenes;

  // Resolve the selection: unknown or duplicate
  // module ID ⇒ config_invalid; stepping order is the REGISTRATION order.
  const registered = registry[SIM_REGISTRY_BRAND];
  if (new Set(modules).size !== modules.length) {
    return {
      ok: false,
      error: fail('config_invalid', 'config field "modules" contains a duplicate module ID', {
        reason: 'duplicate_module',
        path: '/modules',
      }),
    };
  }
  const selection = new Set(modules);
  const selected: SimulationModuleSpec[] = [];
  for (const spec of registered.values()) {
    if (selection.has(spec.id)) selected.push(spec);
  }
  for (const id of selection) {
    if (!registered.has(id)) {
      return {
        ok: false,
        error: fail('config_invalid', `unknown module id "${id}" (not present in the registry)`, {
          reason: 'unknown_module',
          path: '/modules',
        }),
      };
    }
  }

  // Validate every declared phase list (non-empty, unique, canonical).
  for (const spec of selected) {
    if (spec.phases === undefined) continue;
    const check = validatePhaseList(spec.phases);
    if (!check.ok) {
      return {
        ok: false,
        error: fail('config_invalid', `module "${spec.id}": ${check.message}`, {
          reason: 'module_phases',
          path: '/modules',
        }),
      };
    }
  }

  const isM2 = selected.some((s) => s.phases !== undefined);
  // Deep-freeze the snapshot (normative) — the input is
  // never written to; all mutable data is in the simulation state.
  // For a v3 scene, modules see the scene with folders and
  // inactive entities resolved away (the input stays frozen as well).
  const inputSnapshot = deepFreeze(snapshot as RuntimeSnapshot);
  const frozenSnapshot = deepFreeze({ ...inputSnapshot, scene } as RuntimeSnapshot);

  // Resolve + deep-freeze the gameplay settings.
  const settingsResult = resolveSettings(settings);
  if ('error' in settingsResult) return { ok: false, error: settingsResult.error };
  const resolvedSettings = deepFreeze(settingsResult.settings);

  // M2 module-set validation — before any instance is
  // created and before any port method is called.
  const controllerSpecs = selected.filter((s) => s.phases?.includes('controller') === true);
  const controllerIds = scene.entities
    .filter((e) => (e.components as { controller?: unknown }).controller !== undefined)
    .map((e) => e.id);
  if (isM2) {
    const selectedIds = new Set(selected.map((s) => s.id));
    for (const spec of selected) {
      for (const excluded of spec.excludes ?? []) {
        if (selectedIds.has(excluded)) {
          return {
            ok: false,
            error: fail('module_combination_unsupported', `modules "${spec.id}" and "${excluded}" cannot coexist`, {
              reason: `${spec.id}+${excluded}`,
              detail: `${spec.id}+${excluded}`,
            }),
          };
        }
      }
    }
    if (controllerSpecs.length > 0 && controllerIds.length === 0) {
      return {
        ok: false,
        error: fail(
          'config_invalid',
          'a controller module requires a components.controller entity (found 0)',
          { reason: 'controller_target', path: '/modules' },
        ),
      };
    }
    const needsPort = selected.some((s) => s.requiresPhysicsPort === true);
    // A 3D port serves a module that needs physics too (the 3D character controller).
    if (needsPort && physics === undefined && physics3d === undefined) {
      return {
        ok: false,
        error: fail('config_invalid', 'the selected module set requires an injected physics port', {
          reason: PHYSICS_PORT_REASON,
          path: '/physics',
        }),
      };
    }
  }

  // Build the initial mutable state: prev = curr = the
  // snapshot transforms (both deep copies — the snapshot is never aliased).
  const order = scene.entities.map((e) => e.id);
  const entities = new Map<string, SimEntityData>();
  const prev = new Map<string, TransformState>();
  const curr = new Map<string, TransformState>();
  const colliderEntityIds = new Set<string>();
  const controllerEntityIds: string[] = [];
  for (const e of scene.entities) {
    const t = e.components.transform;
    const components = e.components;
    const data: SimEntityData = { id: e.id, parentId: e.parentId ?? null, transform: cloneTransform(t) };
    if (e.name !== undefined) data.name = e.name;
    data.componentKinds = Object.freeze(Object.keys(components));
    const box = components.box;
    if (box) data.box = { size: [box.size[0], box.size[1], box.size[2]], material: { color: box.material.color } };
    const v2 = components as { collider?: unknown; controller?: unknown };
    if (v2.collider !== undefined) {
      data.hasCollider = true;
      colliderEntityIds.add(e.id);
    }
    if (v2.controller !== undefined) {
      data.hasController = true;
      controllerEntityIds.push(e.id);
    }
    entities.set(e.id, data);
    prev.set(e.id, cloneTransform(t));
    curr.set(e.id, cloneTransform(t));
  }

  // The view's lens while no virtual camera sets its own (the project's camera settings).
  const viewLens = viewLensOf(resolvedSettings);

  // One module instance per selection entry (created at instantiate). The
  // behavior-log sink routes a behavior's accepted `ctx.log` entries into the
  // runtime's own bounded diagnostics ring; the holder
  // is bound to the RuntimeInstance once it exists (no log can be emitted
  // before the first step).
  const logSink: BehaviorLogSink = { handler: null };
  // With a scene catalog the tag index follows loads/unloads.
  const liveTags = sceneRows !== null ? createTagQuery(frozenSnapshot) : null;
  const configFor = (specId: string): ModuleConfig => ({
    fixedStepHz: hz,
    settings: resolvedSettings,
    sceneVersion,
    behaviorLog: (level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }) => logSink.handler?.(specId, level, message, at),
    ...(liveTags !== null ? { tags: liveTags } : {}),
    // A 3D project (scripts may drive colliders through intents there).
    ...(physics3d !== undefined ? { physicsDimension: 3 as const } : {}),
    // The 3D character controller's read-only world queries.
    ...(physics3d !== undefined
      ? {
          character3D: {
            raycast: (origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number) => (typeof physics3d.raycast === 'function' ? physics3d.raycast(origin, direction, maxDistance) : null),
            clearance: (origin: PhysicsVec3) => (typeof physics3d.characterClearance === 'function' ? physics3d.characterClearance(origin) : null),
          },
        }
      : {}),
  });
  const entries: ModuleEntry[] = [];
  const disposeCreated = (): void => {
    for (const entry of entries) {
      const d = entry.instance.dispose;
      if (typeof d === 'function') {
        try {
          d.call(entry.instance);
        } catch {
          /* a failing module dispose must not break instantiation */
        }
      }
    }
  };
  for (const spec of selected) {
    let instance: SimulationModule | SimulationPhaseModule;
    try {
      instance = spec.create(frozenSnapshot, configFor(spec.id));
    } catch (e) {
      disposeCreated();
      // A behavior host create() failure carries its own contract code
      // (`config_invalid` prepare/instantiate/property, `transform_owner_forbidden`
      // ownership) instead of the generic `module_create`.
      if (e instanceof BehaviorHostError) {
        return {
          ok: false,
          error: fail(e.code, `module "${spec.id}" create() failed: ${messageOf(e)}`, {
            reason: e.reason,
            moduleId: spec.id,
            ...(e.detail !== undefined ? { detail: e.detail } : {}),
          }),
        };
      }
      return {
        ok: false,
        error: fail('config_invalid', `module "${spec.id}" create() threw: ${messageOf(e)}`, {
          reason: 'module_create',
        }),
      };
    }
    if (typeof instance?.step !== 'function') {
      disposeCreated();
      return {
        ok: false,
        error: fail('config_invalid', `module "${spec.id}" create() did not return { step }`, {
          reason: 'module_step',
        }),
      };
    }
    const phased = spec.phases !== undefined;
    const phases: readonly SimulationPhase[] = phased ? (spec.phases as readonly SimulationPhase[]) : ['transform'];
    if (phased) {
      const owners = (instance as SimulationPhaseModule).transformOwners;
      if (!Array.isArray(owners) || owners.some((o) => typeof o !== 'string')) {
        disposeCreated();
        return {
          ok: false,
          error: fail('config_invalid', `module "${spec.id}" must declare string transformOwners at create`, {
            reason: 'module_owners',
          }),
        };
      }
    }
    entries.push({ id: spec.id, phases, phased, instance, owners: [] });
  }

  // Transform ownership (declared at create), duplicate-writer
  // and forbidden-entity rejection. A failure disposes every created
  // instance — no runtime instance is created and no port method is called.
  if (isM2) {
    // First pass: collect owners, then detect duplicate claims and missing
    // entities (the error table's order).
    const ownerByEntity = new Map<string, string>();
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const spec = selected[i]!;
      const owners = entry.phased
        ? (entry.instance as SimulationPhaseModule).transformOwners
        : spec.legacyTransformOwners
          ? spec.legacyTransformOwners(frozenSnapshot)
          : [];
      entry.owners = owners;
      for (const entityId of owners) {
        // An owner in a scene that is not loaded is checked when it loads.
        if (!entities.has(entityId) && sceneRows === null) {
          disposeCreated();
          return {
            ok: false,
            error: fail('transform_owner_conflict', `module "${entry.id}" claims missing entity "${entityId}"`, {
              reason: entityId,
              moduleId: entry.id,
            }),
          };
        }
        const other = ownerByEntity.get(entityId);
        if (other !== undefined && other !== entry.id) {
          disposeCreated();
          return {
            ok: false,
            error: fail('transform_owner_conflict', `entity "${entityId}" is claimed by "${other}" and "${entry.id}"`, {
              reason: entityId,
              moduleId: entry.id,
            }),
          };
        }
        ownerByEntity.set(entityId, entry.id);
      }
    }
    // Second pass: physics-entity protections.
    for (const entry of entries) {
      const isController = entry.phases.includes('controller');
      for (const entityId of entry.owners) {
        // In a 3D project a transform-phase module (a script) may drive a collider
        // that no mover moves — the runtime poses it as a kinematic body (ColliderSystem).
        const drivable = physics3d !== undefined && ColliderSystem.drivable(scene.entities.find((x) => x.id === entityId)?.components);
        if ((colliderEntityIds.has(entityId) || controllerEntityIds.includes(entityId)) && !isController && !drivable) {
          disposeCreated();
          return {
            ok: false,
            error: fail('transform_owner_forbidden', `module "${entry.id}" claims physics entity "${entityId}" without the controller phase`, {
              reason: 'physics_entity',
              moduleId: entry.id,
              detail: 'physics_entity',
            }),
          };
        }
      }
    }
  }

  // The start scenes as batches (members listed by the host;
  // unlisted entities belong to the first start scene).
  const startBatches: { sceneId: string; entities: EntityV3[] }[] = [];
  if (sceneRows !== null) {
    const starts = sceneRows.filter((r) => r.start);
    const sceneOfEntity = new Map<string, string>();
    for (const row of starts) for (const id of row.entityIds ?? []) sceneOfEntity.set(id, row.sceneId);
    const bySceneId = new Map<string, EntityV3[]>(starts.map((r) => [r.sceneId, []]));
    for (const e of scene.entities) {
      bySceneId.get(sceneOfEntity.get(e.id) ?? starts[0]!.sceneId)!.push(e as unknown as EntityV3);
    }
    for (const row of starts) startBatches.push({ sceneId: row.sceneId, entities: bySceneId.get(row.sceneId)! });
  }

  const rt = new RuntimeInstance({
    snapshotId,
    revision,
    hz,
    clock,
    clockLabel,
    driverKind,
    onFrame,
    modules: selected.map((s) => s.id),
    entries,
    isM2,
    timing: engineTimingSteps(hz),
    actions,
    physics,
    ...(physics3d !== undefined ? { physics3d } : {}),
    settings: resolvedSettings,
    controllerEntityIds,
    order,
    entities,
    viewLens,
    prev,
    curr,
    logSink,
    sceneRows,
    startBatches,
    liveTags,
    // The tag index 3D queries filter by (the live one when the project has a scene catalog).
    queryTags: liveTags ?? (physics3d !== undefined ? createTagQuery(frozenSnapshot) : null),
    animatorControllers: snap.animators as unknown as readonly AnimatorControllerLike[],
    initialEntities: scene.entities as unknown as readonly EntityV3[],
    prefabs: snap.prefabs,
    modelBounds: snap.modelBounds,
    audioDurations: snap.audioDurations,
    ...(snap.rigs !== undefined ? { rigs: snap.rigs } : {}),
    ...(snap.modelColliders !== undefined ? { modelColliders: snap.modelColliders } : {}),
    ...(snap.architectureStyles !== undefined ? { architectureStyles: snap.architectureStyles } : {}),
    ...(variables !== undefined ? { variables } : {}),
    blockTypes: snap.blockTypes,
    cellFields: snap.cellFields,
    ...(snap.materialCatalog !== undefined ? { materialCatalog: snap.materialCatalog } : {}),
    ...(snap.materialIds !== undefined ? { materialIds: snap.materialIds } : {}),
    ...(snap.saveSchema !== undefined ? { saveSchema: snap.saveSchema } : {}),
    ...(projectSettings !== undefined ? { projectSettings } : {}),
    environmentPresets: snap.environmentPresets ?? [],
    uiDocuments: snap.uiDocuments,
    ...(snap.dialogue !== undefined ? { dialogue: snap.dialogue } : {}),
    ...(snap.modes !== undefined ? { modes: snap.modes } : {}),
    ...(startMode !== undefined ? { startMode } : {}),
    ...(snap.timelines !== undefined ? { timelines: snap.timelines } : {}),
    ...(snap.eventCues !== undefined ? { eventCues: snap.eventCues } : {}),
    ...(snap.sceneList !== undefined ? { sceneList: snap.sceneList } : {}),
  });
  return { ok: true, runtime: rt };
}

function resolveSettings(input: unknown): { settings: GameplaySettings } | { error: RuntimeError } {
  // project-model owns the settings registry and validation; the runtime
  // consumes the resolved, frozen object.
  const content = input === undefined ? {} : input;
  const result = resolveGameplaySettings(content);
  if (!result.ok) {
    return {
      error: fail('config_invalid', 'gameplay settings are invalid', {
        reason: 'settings',
        path: '/settings',
      }),
    };
  }
  return { settings: result.normalized };
}
