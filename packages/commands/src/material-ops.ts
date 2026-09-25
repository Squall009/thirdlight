/**
 * Phase 9.4: project materials and the environment.
 *
 * `setMaterial {material}` creates or replaces one material (by materialId);
 * `deleteMaterial {materialId}` removes one (refused while an object or an
 * asset still uses it — the resulting-state check reports the reference);
 * `setEnvironment {environment}` replaces the environment block. Each is one
 * undo; the change records carry the whole block before and after.
 *
 * Phase 9.6: `setLighting {sceneId, lighting}` sets or clears one scene's
 * bake (`content.lighting[sceneId]`); the change carries that bake before and
 * after.
 */

import { canonicalAnimators, canonicalFlow, canonicalInput, validateAnimatorController, validateFlow, validateInput, type AnimatorController, type GameFlow, type InputConfig } from '@thirdlight/project-model';
import { canonicalEnvironment, canonicalLighting, GRAPH_KINDS, graphDocumentsContext, validateEnvironment, validateLightingBake, validateMaterials, type EnvironmentConfig, type GraphDocument, type LightingBake, type MaterialDef, type ModelErrorV2 } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetAnimatorsChange, SetEnvironmentChange, SetFlowChange, SetInputChange, SetLightingChange, SetMaterialsChange } from './types';

type WithMaterials = ContentDocument & { materials?: MaterialDef[]; environment?: EnvironmentConfig; lighting?: Record<string, LightingBake>; animators?: AnimatorController[]; input?: InputConfig; flow?: GameFlow };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

function commit(
  input: OpInput,
  next: WithMaterials,
  change: SetMaterialsChange | SetEnvironmentChange | SetLightingChange | SetAnimatorsChange | SetInputChange | SetFlowChange,
  inverse:
    | { kind: 'setMaterials'; restore: MaterialDef[] }
    | { kind: 'setEnvironment'; restore: EnvironmentConfig | null }
    | { kind: 'setLighting'; sceneId: string; restore: LightingBake | null }
    | { kind: 'setAnimators'; restore: AnimatorController[] }
    | { kind: 'setInput'; restore: InputConfig | null }
    | { kind: 'setFlow'; restore: GameFlow | null },
): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse } };
}

export function applySetMaterial(input: OpInput, args: { material: MaterialDef }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  const errors: ModelErrorV2[] = [];
  // Phase 18.0: a graph material's calls resolve against the project's material functions.
  validateMaterials([args.material], '', errors, graphDocumentsContext(GRAPH_KINDS, (catalog as { graphs?: GraphDocument[] }).graphs));
  if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/material') };
  const previous = deepClone(catalog.materials ?? []);
  const next = [...previous.filter((m) => m.materialId !== args.material.materialId), deepClone(args.material)];
  const content: WithMaterials = { ...catalog, materials: next };
  const out = commit(input, content, { type: 'setMaterials', previous, next: [] }, { kind: 'setMaterials', restore: previous });
  if (out.ok) (out.op.change as SetMaterialsChange).next = deepClone(((out.op.content as WithMaterials | undefined)?.materials ?? []));
  return out;
}

export function applyDeleteMaterial(input: OpInput, args: { materialId: string }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  const previous = deepClone(catalog.materials ?? []);
  if (!previous.some((m) => m.materialId === args.materialId)) {
    return { ok: false, error: fieldValue('/args/materialId', args.materialId, 'an existing materialId', 'no material with this id') };
  }
  const next = previous.filter((m) => m.materialId !== args.materialId);
  const content: WithMaterials = { ...catalog };
  if (next.length > 0) content.materials = next;
  else delete content.materials;
  return commit(input, content, { type: 'setMaterials', previous, next }, { kind: 'setMaterials', restore: previous });
}

export function applySetEnvironment(input: OpInput, args: { environment: EnvironmentConfig }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  const errors: ModelErrorV2[] = [];
  validateEnvironment(args.environment, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/environment') };
  const previous = catalog.environment !== undefined ? deepClone(catalog.environment) : null;
  const next = canonicalEnvironment(args.environment);
  return commit(input, { ...catalog, environment: next }, { type: 'setEnvironment', previous, next }, { kind: 'setEnvironment', restore: previous });
}

export function applySetLighting(input: OpInput, args: { sceneId: string; lighting: LightingBake | null }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  let next: LightingBake | null = null;
  if (args.lighting !== null) {
    const errors: ModelErrorV2[] = [];
    validateLightingBake(args.lighting, '', errors);
    if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/lighting') };
    next = canonicalLighting({ [args.sceneId]: args.lighting })[args.sceneId]!;
  }
  const previous = catalog.lighting?.[args.sceneId] !== undefined ? deepClone(catalog.lighting[args.sceneId]!) : null;
  if (previous === null && next === null) {
    return { ok: false, error: fieldValue('/args/lighting', null, 'a bake', 'this scene has no bake to clear') };
  }
  // Unknown scenes and non-texture atlases are refused by the resulting-state check.
  return commit(input, withLighting(catalog, args.sceneId, next) as WithMaterials, { type: 'setLighting', sceneId: args.sceneId, previous, next }, { kind: 'setLighting', sceneId: args.sceneId, restore: previous });
}

/** Phase 9.7: create or replace one animator controller (by controllerId). */
export function applySetAnimator(input: OpInput, args: { controller: AnimatorController }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  const errors: ModelErrorV2[] = [];
  validateAnimatorController(args.controller, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/controller') };
  const previous = deepClone(catalog.animators ?? []);
  const next = canonicalAnimators([...previous.filter((c) => c.controllerId !== args.controller.controllerId), deepClone(args.controller)]);
  return commit(input, withAnimators(catalog, next) as WithMaterials, { type: 'setAnimators', previous, next }, { kind: 'setAnimators', restore: previous });
}

/** Phase 9.7: remove a controller (refused while an animator still uses it — the resulting-state check reports it). */
export function applyDeleteAnimator(input: OpInput, args: { controllerId: string }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  const previous = deepClone(catalog.animators ?? []);
  if (!previous.some((c) => c.controllerId === args.controllerId)) {
    return { ok: false, error: fieldValue('/args/controllerId', args.controllerId, 'an existing controllerId', 'no animator controller with this id') };
  }
  const next = previous.filter((c) => c.controllerId !== args.controllerId);
  return commit(input, withAnimators(catalog, next) as WithMaterials, { type: 'setAnimators', previous, next }, { kind: 'setAnimators', restore: previous });
}

/** Phase 9.8: replace the input actions (null = back to the defaults). */
export function applySetInput(input: OpInput, args: { input: InputConfig | null }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  let next: InputConfig | null = null;
  if (args.input !== null) {
    const errors: ModelErrorV2[] = [];
    validateInput(args.input, '', errors);
    if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/input') };
    next = canonicalInput(args.input);
  }
  const previous = catalog.input !== undefined ? deepClone(catalog.input) : null;
  return commit(input, withInput(catalog, next) as WithMaterials, { type: 'setInput', previous, next }, { kind: 'setInput', restore: previous });
}

/** Phase 9.10: replace the game flow (null = one level, as before). */
export function applySetFlow(input: OpInput, args: { flow: GameFlow | null }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  let next: GameFlow | null = null;
  if (args.flow !== null) {
    const errors: ModelErrorV2[] = [];
    validateFlow(args.flow, '', errors);
    if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/flow') };
    next = canonicalFlow(args.flow);
  }
  const previous = catalog.flow !== undefined ? deepClone(catalog.flow) : null;
  return commit(input, withFlow(catalog, next) as WithMaterials, { type: 'setFlow', previous, next }, { kind: 'setFlow', restore: previous });
}

export function withFlow(content: ContentDocument, value: GameFlow | null): ContentDocument {
  const c = { ...(content as WithMaterials) };
  if (value !== null) c.flow = deepClone(value);
  else delete c.flow;
  return c;
}

export function withInput(content: ContentDocument, value: InputConfig | null): ContentDocument {
  const c = { ...(content as WithMaterials) };
  if (value !== null) c.input = deepClone(value);
  else delete c.input;
  return c;
}

export function withAnimators(content: ContentDocument, list: AnimatorController[]): ContentDocument {
  const c = { ...(content as WithMaterials) };
  if (list.length > 0) c.animators = deepClone(list);
  else delete c.animators;
  return c;
}

/** Restore a materials list or an environment block (undo/redo of the ops above). */
export function withMaterials(content: ContentDocument, list: MaterialDef[]): ContentDocument {
  const c = { ...(content as WithMaterials) };
  if (list.length > 0) c.materials = deepClone(list);
  else delete c.materials;
  return c;
}

export function withEnvironment(content: ContentDocument, env: EnvironmentConfig | null): ContentDocument {
  const c = { ...(content as WithMaterials) };
  if (env !== null) c.environment = deepClone(env);
  else delete c.environment;
  return c;
}

export function withLighting(content: ContentDocument, sceneId: string, bake: LightingBake | null): ContentDocument {
  const c = { ...(content as WithMaterials) };
  const map = { ...(c.lighting ?? {}) };
  if (bake !== null) map[sceneId] = deepClone(bake);
  else delete map[sceneId];
  if (Object.keys(map).length > 0) c.lighting = map;
  else delete c.lighting;
  return c;
}
