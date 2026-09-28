/**
 * The v3 presentation mutation op — commands.md §8.13 (`applySurfacePreset`),
 * packet 45. Phase 24.7: `setGameConfig` was deleted with the game block.
 *
 * It runs the SAME pure pipeline and history engine as every other op
 * (`applyMutation`): one revision, one history entry, one `change`, one
 * inverse, the uniform no-change check and resulting-state re-validation.
 * Nothing here reads files, stages blobs, holds a clock or touches a renderer.
 */

import { SURFACE_PRESETS } from '@thirdlight/project-model';

import { entityNotFound } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { componentsRecord, deepClone, gateResultState, type OpOutcome } from './ops';
import type { EntityV3 } from '@thirdlight/project-model';
import type { ApplySurfacePresetArgs, ApplySurfacePresetChange } from './types';
import { SURFACE_CHANGED_FIELDS } from './v3';

/** §8.13: copy one frozen preset row onto an entity's `surface`. */
export function applyApplySurfacePreset(
  input: OpInput,
  args: ApplySurfacePresetArgs,
): OpOutcome {
  const catalog = contentOf(input.content);
  const index = input.scene.entities.findIndex((e) => e.id === args.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(args.entityId) };
  const entity = input.scene.entities[index] as EntityV3;
  const components = componentsRecord(entity as unknown as EntityV3);
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
    ...componentsRecord(cloned as unknown as EntityV3),
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
  const canonicalEntity = gate.scene.entities[index] as EntityV3;
  const canonicalNext = deepClone(componentsRecord(canonicalEntity as unknown as EntityV3)['surface']);
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
