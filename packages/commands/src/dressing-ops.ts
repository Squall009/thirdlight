/**
 * Dressings (`content.dressings`).
 *
 * `setDressing {dressing}` creates or replaces one dressing (by dressingId:
 * its format, name and ordered species entries); `deleteDressing
 * {dressingId}` removes one. Each is one undo; the change records the
 * dressing before and after (`setDressing {dressingId, previous, next}`,
 * null = none).
 *
 * A material names its dressing in its own record (`setMaterial`,
 * `voxel.dressing`); deleting a dressing a material still names is refused
 * by the content rules (`dressing_missing`): clear the material's field
 * first. The model assets the species name are not checked here: deleting
 * an asset is never refused because a dressing names it.
 */
import { canonicalDressing, canonicalDressings, validateDressing, type DressingDef, type ModelErrorV2 } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetDressingChange } from './types';
import { withListRecord } from './record-lists';

type WithDressings = ContentDocument & { dressings?: DressingDef[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

/** The content with one dressing set (or removed when null); the list stays canonical and is absent when empty. */
export function withDressing(content: ContentDocument, dressingId: string, dressing: DressingDef | null): ContentDocument {
  const c = { ...(content as WithDressings) };
  const list = withListRecord(c.dressings, (d) => d.dressingId, dressingId, dressing === null ? null : canonicalDressings([deepClone(dressing)])[0]!);
  if (list.length > 0) c.dressings = list;
  else delete c.dressings;
  return c as ContentDocument;
}

export const dressingsOf = (content: ContentDocument): DressingDef[] => (content as WithDressings).dressings ?? [];

function commit(input: OpInput, next: ContentDocument, dressingId: string, previous: DressingDef | null): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = dressingsOf((gate.content ?? next) as ContentDocument).find((d) => d.dressingId === dressingId) ?? null;
  const change: SetDressingChange = { type: 'setDressing', dressingId, previous: previous === null ? null : deepClone(previous), next: stored === null ? null : deepClone(stored) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setDressing', dressingId, restore: previous === null ? null : deepClone(previous) } } };
}

/** `setDressing`: create or replace one dressing. */
export function applySetDressing(input: OpInput, args: { dressing: DressingDef }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateDressing(args.dressing, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/dressing') };
  const dressing = canonicalDressing(args.dressing);
  const previous = dressingsOf(catalog).find((d) => d.dressingId === dressing.dressingId) ?? null;
  return commit(input, withDressing(catalog, dressing.dressingId, dressing), dressing.dressingId, previous);
}

/** `deleteDressing`: remove one dressing (the assets it names stay; refused while a material names it). */
export function applyDeleteDressing(input: OpInput, args: { dressingId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = dressingsOf(catalog).find((d) => d.dressingId === args.dressingId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/dressingId', args.dressingId, 'an existing dressingId', 'no dressing with this id'), code: 'reference_missing' } };
  return commit(input, withDressing(catalog, args.dressingId, null), args.dressingId, previous);
}
