/**
 * Phase 20.0: visual effects (`content.effects`).
 *
 * `setEffect {effect}` creates or replaces one effect (by effectId: its
 * settings, parameters and systems with their graphs — adding or removing a
 * system is a `setEffect`); `deleteEffect {effectId}` removes one (refused
 * while an `effect` component still names it — the resulting-state check
 * reports the object); `renameEffect {effectId, name}` changes its name
 * only. Each is one undo; the change records the effect before and after
 * (`setEffect {effectId, previous, next}`, null = none).
 *
 * A system's graph is edited node by node with the generic `graphEdit`
 * (owner kind `effect`, owner id `<effectId>/<systemId>`, graph-ops.ts).
 */
import { canonicalEffect, canonicalEffects, validateEffect, type EffectDef, type ModelErrorV2 } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetEffectChange } from './types';

type WithEffects = ContentDocument & { effects?: EffectDef[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

/** The content with one effect set (or removed when null); the list stays canonical and is absent when empty. */
export function withEffect(content: ContentDocument, effectId: string, effect: EffectDef | null): ContentDocument {
  const c = { ...(content as WithEffects) };
  const list = (c.effects ?? []).filter((e) => e.effectId !== effectId);
  if (effect !== null) list.push(deepClone(effect));
  if (list.length > 0) c.effects = canonicalEffects(list);
  else delete c.effects;
  return c as ContentDocument;
}

export const effectsOf = (content: ContentDocument): EffectDef[] => (content as WithEffects).effects ?? [];

function commit(input: OpInput, next: ContentDocument, effectId: string, previous: EffectDef | null): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = effectsOf((gate.content ?? next) as ContentDocument).find((e) => e.effectId === effectId) ?? null;
  const change: SetEffectChange = { type: 'setEffect', effectId, previous: previous === null ? null : deepClone(previous), next: stored === null ? null : deepClone(stored) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setEffect', effectId, restore: previous === null ? null : deepClone(previous) } } };
}

/** `setEffect`: create or replace one effect. */
export function applySetEffect(input: OpInput, args: { effect: EffectDef }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateEffect(args.effect, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/effect') };
  const effect = canonicalEffect(args.effect);
  const previous = effectsOf(catalog).find((e) => e.effectId === effect.effectId) ?? null;
  return commit(input, withEffect(catalog, effect.effectId, effect), effect.effectId, previous);
}

/** `deleteEffect`: remove one effect (refused by the resulting-state check while a component names it). */
export function applyDeleteEffect(input: OpInput, args: { effectId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = effectsOf(catalog).find((e) => e.effectId === args.effectId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/effectId', args.effectId, 'an existing effectId', 'no effect with this id'), code: 'reference_missing' } };
  return commit(input, withEffect(catalog, args.effectId, null), args.effectId, previous);
}

/** `renameEffect`: change one effect's name. */
export function applyRenameEffect(input: OpInput, args: { effectId: string; name: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = effectsOf(catalog).find((e) => e.effectId === args.effectId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/effectId', args.effectId, 'an existing effectId', 'no effect with this id'), code: 'reference_missing' } };
  const next = { ...deepClone(previous), name: args.name };
  const errors: ModelErrorV2[] = [];
  validateEffect(next, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args') };
  return commit(input, withEffect(catalog, args.effectId, next), args.effectId, previous);
}
