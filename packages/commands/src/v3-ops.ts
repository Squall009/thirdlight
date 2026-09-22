/**
 * The two v3 game/presentation mutation ops — commands.md §8.13
 * (`applySurfacePreset`) and §8.14 (`setGameConfig`), packet 45.
 *
 * Both run the SAME pure pipeline and history engine as every other op
 * (`applyMutation`): one revision, one history entry, one `change`, one
 * inverse, the uniform no-change check and resulting-state re-validation.
 * Nothing here reads files, stages blobs, holds a clock or touches a renderer.
 */

import {
  SURFACE_PRESETS,
  validateGameConfig,
  type GameConfig,
  type ModelErrorV3,
} from '@thirdlight/project-model';

import { entityNotFound, fieldUnexpected, fieldValue, noChangeContent, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { componentsRecord, deepClone, gateResultState, type OpOutcome } from './ops';
import type { EntityV2 } from '@thirdlight/project-model';
import type {
  ApplySurfacePresetArgs,
  ApplySurfacePresetChange,
  SetGameConfigArgs,
  SetGameConfigChange,
} from './types';
import { GAME_CONFIG_FIELDS, SURFACE_CHANGED_FIELDS, commandErrorFromModel } from './v3';

/** §8.13: copy one frozen preset row onto an entity's `surface`. */
export function applyApplySurfacePreset(
  input: OpInput,
  args: ApplySurfacePresetArgs,
): OpOutcome {
  const catalog = contentOf(input.content);
  const index = input.scene.entities.findIndex((e) => e.id === args.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(args.entityId) };
  const entity = input.scene.entities[index] as EntityV2;
  const components = componentsRecord(entity as unknown as EntityV2);
  if (components['box'] === undefined && components['model'] === undefined) {
    return {
      ok: false,
      error: {
        code: 'component_missing',
        cls: 'validation',
        entityId: args.entityId,
        component: 'surface',
        expected: 'box|model',
        message: `entity '${args.entityId}' carries neither box nor model, so it cannot hold a surface`,
      },
    };
  }
  const previous = components['surface'] === undefined ? null : deepClone(components['surface']);
  const next = deepClone(SURFACE_PRESETS[args.preset]);
  const cloned = deepClone(entity);
  (cloned as unknown as { components: Record<string, unknown> }).components = {
    ...componentsRecord(cloned as unknown as EntityV2),
    surface: next,
  };
  const nextEntities = [...input.scene.entities];
  nextEntities[index] = cloned;
  const resultScene = { ...input.scene, revision: input.scene.revision + 1, entities: nextEntities };
  const gate = gateResultState(
    { scene: input.scene, content: catalog, manifest: input.manifest },
    resultScene,
    catalog,
  );
  if (!gate.ok) return gate;
  const canonicalEntity = gate.scene.entities[index] as EntityV2;
  const canonicalNext = deepClone(componentsRecord(canonicalEntity as unknown as EntityV2)['surface']);
  const change: ApplySurfacePresetChange = {
    type: 'applySurfacePreset',
    id: args.entityId,
    preset: args.preset,
    previous,
    next: canonicalNext,
    changedFields: [...SURFACE_CHANGED_FIELDS],
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      // §9.1: the inverse is the `setComponent` surface restore; the redo
      // re-applies the recorded `next` value (recorded-value rule).
      inverse: {
        kind: 'setComponent',
        id: args.entityId,
        component: 'surface',
        restore: previous,
      },
    },
  };
}

/**
 * §8.14/authoring §A3.4: create (block absent + complete value), partial edit
 * (block present + non-empty object) or remove (`null`). The block's
 * references are resolved by the resulting-state gate (§23.5), never silently
 * repaired.
 */
export function applySetGameConfig(input: OpInput, args: SetGameConfigArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const isV3 = (input.scene as { schemaVersion?: unknown }).schemaVersion === 3;
  if (!isV3) {
    return {
      ok: false,
      error: fieldValue(
        '/args/game',
        args.game,
        'content.game is a v3 (schemaVersion 3) feature',
        'content.game can only be written on a schemaVersion 3 scene',
      ),
    };
  }
  const previous = (catalog?.game ?? null) as GameConfig | null;
  const raw = args.game;

  let next: GameConfig;
  let changedFields: string[];
  if (raw === null) {
    if (previous === null) return { ok: false, error: noChangeContent() };
    // Removal is an ordinary edit: every reference is freed.
    const nextContent = { ...catalog, game: null };
    const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
    const gate = gateResultState(
      { scene: input.scene, content: catalog, manifest: input.manifest },
      resultScene,
      nextContent,
    );
    if (!gate.ok) return gate;
    const change: SetGameConfigChange = {
      type: 'setGameConfig',
      previous,
      next: null,
      changedFields: [...GAME_CONFIG_FIELDS],
    };
    return {
      ok: true,
      op: {
        scene: gate.scene,
        content: gate.content,
        change,
        inverse: { kind: 'setGameConfig', restore: previous },
      },
    };
  }

  if (previous === null) {
    // Create: the value must be a COMPLETE canonical block; the model's
    // block validator reports the `game_config_invalid` reason, which the
    // command layer maps to the §5.4 `field_*` code (project-model §23.9
    // document rule).
    const errors: ModelErrorV3[] = [];
    validateGameConfig(raw, '/args/game', errors);
    if (errors.length > 0) return { ok: false, error: gameConfigError(errors[0] as ModelErrorV3) };
    next = deepClone(raw) as unknown as GameConfig;
    changedFields = [...GAME_CONFIG_FIELDS];
  } else {
    const partial = raw as Record<string, unknown>;
    const keys = Object.keys(partial);
    for (const key of keys) {
      if (!(GAME_CONFIG_FIELDS as readonly string[]).includes(key)) {
        return {
          ok: false,
          error: fieldUnexpected(
            `/args/game/${key}`,
            key,
            GAME_CONFIG_FIELDS.join(', '),
          ),
        };
      }
    }
    if (keys.length === 0) {
      return {
        ok: false,
        error: fieldValue(
          '/args/game',
          {},
          'non-empty object: at least one top-level game field',
          'a partial edit must replace at least one top-level field',
        ),
      };
    }
    next = { ...deepClone(previous), ...deepClone(partial) } as unknown as GameConfig;
    const errors: ModelErrorV3[] = [];
    validateGameConfig(next, '/args/game', errors);
    if (errors.length > 0) return { ok: false, error: gameConfigError(errors[0] as ModelErrorV3) };
    changedFields = GAME_CONFIG_FIELDS.filter((f) =>
      Object.prototype.hasOwnProperty.call(partial, f),
    );
  }

  const nextContent = { ...catalog, game: next };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState(
    { scene: input.scene, content: catalog, manifest: input.manifest },
    resultScene,
    nextContent,
  );
  if (!gate.ok) return gate;
  const canonicalNext = (gate.content?.game ?? next) as GameConfig;
  const change: SetGameConfigChange = {
    type: 'setGameConfig',
    previous,
    next: deepClone(canonicalNext),
    changedFields,
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: { kind: 'setGameConfig', restore: previous },
    },
  };
}

/**
 * §23.9 document rule: the model reports one block-level `game_config_invalid`
 * with a `reason`; a command reports the corresponding `field_*` code.
 */
function gameConfigError(e: ModelErrorV3): CommandError {
  if (e.code !== 'game_config_invalid') return commandErrorFromModel(e);
  const out: Record<string, unknown> = {
    code: e.reason ?? 'field_value',
    cls: 'validation',
  };
  if (e.path !== undefined) out['path'] = e.path;
  if (e.found !== undefined) out['found'] = e.found;
  if (e.expected !== undefined) out['expected'] = e.expected;
  out['message'] = e.message;
  return out as unknown as CommandError;
}
