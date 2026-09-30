/**
 * Project materials and the environment.
 *
 * `setMaterial {material}` creates or replaces one material (by materialId);
 * `deleteMaterial {materialId}` removes one (refused while an object or an
 * asset still uses it — the resulting-state check reports the reference);
 * `setEnvironment {environment}` replaces the environment block. Each is one
 * undo; the change records carry the whole block before and after.
 *
 * `setLighting {sceneId, lighting}` sets or clears one scene's
 * bake (`content.lighting[sceneId]`); the change carries that bake before and
 * after.
 */

import { canonicalAnimators, canonicalInput, validateAnimatorController, validateInput, type AnimatorController, type InputConfig } from '@thirdlight/project-model';
import { canonicalEnvironment, canonicalLighting, GRAPH_KINDS, graphDocumentsContext, validateEnvironment, validateLightingBake, validateMaterials, type EnvironmentConfig, type GraphDocument, type LightingBake, type MaterialDef, type ModelErrorV2 } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { withListRecord } from './record-lists';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetAnimatorChange, SetEnvironmentChange, SetInputChange, SetLightingChange, SetMaterialChange } from './types';

type WithMaterials = ContentDocument & { materials?: MaterialDef[]; environment?: EnvironmentConfig; lighting?: Record<string, LightingBake>; animators?: AnimatorController[]; input?: InputConfig };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

function commit(
  input: OpInput,
  next: WithMaterials,
  change: SetMaterialChange | SetEnvironmentChange | SetLightingChange | SetAnimatorChange | SetInputChange,
  inverse:
    | { kind: 'setMaterial'; materialId: string; restore: MaterialDef | null }
    | { kind: 'setEnvironment'; restore: EnvironmentConfig | null }
    | { kind: 'setLighting'; sceneId: string; restore: LightingBake | null }
    | { kind: 'setAnimator'; controllerId: string; restore: AnimatorController | null }
    | { kind: 'setInput'; restore: InputConfig | null },
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
  // A graph material's calls resolve against the project's material functions.
  validateMaterials([args.material], '', errors, graphDocumentsContext(GRAPH_KINDS, (catalog as { graphs?: GraphDocument[] }).graphs));
  if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/material') };
  const id = args.material.materialId;
  const found = (catalog.materials ?? []).find((m) => m.materialId === id);
  const previous = found !== undefined ? deepClone(found) : null;
  const out = commit(input, withMaterial(catalog, id, args.material) as WithMaterials, { type: 'setMaterial', materialId: id, previous, next: null }, { kind: 'setMaterial', materialId: id, restore: previous });
  // The change carries the material as stored (canonical).
  if (out.ok) {
    const stored = ((out.op.content as WithMaterials | undefined)?.materials ?? []).find((m) => m.materialId === id);
    (out.op.change as SetMaterialChange).next = stored !== undefined ? deepClone(stored) : null;
  }
  return out;
}

export function applyDeleteMaterial(input: OpInput, args: { materialId: string }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  const found = (catalog.materials ?? []).find((m) => m.materialId === args.materialId);
  if (found === undefined) {
    return { ok: false, error: fieldValue('/args/materialId', args.materialId, 'an existing materialId', 'no material with this id') };
  }
  const previous = deepClone(found);
  return commit(input, withMaterial(catalog, args.materialId, null) as WithMaterials, { type: 'setMaterial', materialId: args.materialId, previous, next: null }, { kind: 'setMaterial', materialId: args.materialId, restore: previous });
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

/** Create or replace one animator controller (by controllerId). */
export function applySetAnimator(input: OpInput, args: { controller: AnimatorController }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  const errors: ModelErrorV2[] = [];
  validateAnimatorController(args.controller, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/controller') };
  const id = args.controller.controllerId;
  const found = (catalog.animators ?? []).find((c) => c.controllerId === id);
  const previous = found !== undefined ? deepClone(found) : null;
  const next = canonicalAnimators([args.controller])[0]!;
  return commit(input, withAnimator(catalog, id, next) as WithMaterials, { type: 'setAnimator', controllerId: id, previous, next: deepClone(next) }, { kind: 'setAnimator', controllerId: id, restore: previous });
}

/** Remove a controller (refused while an animator still uses it — the resulting-state check reports it). */
export function applyDeleteAnimator(input: OpInput, args: { controllerId: string }): OpOutcome {
  const catalog = contentOf(input.content) as WithMaterials;
  const found = (catalog.animators ?? []).find((c) => c.controllerId === args.controllerId);
  if (found === undefined) {
    return { ok: false, error: fieldValue('/args/controllerId', args.controllerId, 'an existing controllerId', 'no animator controller with this id') };
  }
  const previous = deepClone(found);
  return commit(input, withAnimator(catalog, args.controllerId, null) as WithMaterials, { type: 'setAnimator', controllerId: args.controllerId, previous, next: null }, { kind: 'setAnimator', controllerId: args.controllerId, restore: previous });
}

/** Replace the input actions (null = back to the defaults). */
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

export function withInput(content: ContentDocument, value: InputConfig | null): ContentDocument {
  const c = { ...(content as WithMaterials) };
  if (value !== null) c.input = deepClone(value);
  else delete c.input;
  return c;
}

/** Set or remove one animator controller (the list's others unchanged). */
export function withAnimator(content: ContentDocument, controllerId: string, controller: AnimatorController | null): ContentDocument {
  const c = { ...(content as WithMaterials) };
  const list = withListRecord(c.animators, (x) => x.controllerId, controllerId, controller === null ? null : deepClone(controller));
  if (list.length > 0) c.animators = list;
  else delete c.animators;
  return c;
}

/** Set or remove one material (the list's others unchanged). */
export function withMaterial(content: ContentDocument, materialId: string, material: MaterialDef | null): ContentDocument {
  const c = { ...(content as WithMaterials) };
  const list = withListRecord(c.materials, (x) => x.materialId, materialId, material === null ? null : deepClone(material));
  if (list.length > 0) c.materials = list;
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
