/**
 * Kits (`content.kits`).
 *
 * `setKit {kit}` creates or replaces one kit (by kitId: its name, trim
 * material, presets, block types and piece slots); `deleteKit {kitId}`
 * removes one. Each is one undo; the change records the kit before and
 * after (`setKit {kitId, previous, next}`, null = none).
 *
 * A kit only names its parts, so neither op checks that they exist and
 * deleting a part a kit names is never refused: what a kit names that the
 * project lacks is a problem the backend reports (`kitProblems`).
 */
import { canonicalKit, canonicalKits, validateKit, type KitDef, type ModelErrorV2 } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetKitChange } from './types';
import { withListRecord } from './record-lists';

type WithKits = ContentDocument & { kits?: KitDef[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

/** The content with one kit set (or removed when null); the list stays canonical and is absent when empty. */
export function withKit(content: ContentDocument, kitId: string, kit: KitDef | null): ContentDocument {
  const c = { ...(content as WithKits) };
  const list = withListRecord(c.kits, (k) => k.kitId, kitId, kit === null ? null : canonicalKits([deepClone(kit)])[0]!);
  if (list.length > 0) c.kits = list;
  else delete c.kits;
  return c as ContentDocument;
}

export const kitsOf = (content: ContentDocument): KitDef[] => (content as WithKits).kits ?? [];

function commit(input: OpInput, next: ContentDocument, kitId: string, previous: KitDef | null): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = kitsOf((gate.content ?? next) as ContentDocument).find((k) => k.kitId === kitId) ?? null;
  const change: SetKitChange = { type: 'setKit', kitId, previous: previous === null ? null : deepClone(previous), next: stored === null ? null : deepClone(stored) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setKit', kitId, restore: previous === null ? null : deepClone(previous) } } };
}

/** `setKit`: create or replace one kit. */
export function applySetKit(input: OpInput, args: { kit: KitDef }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateKit(args.kit, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/kit') };
  const kit = canonicalKit(args.kit);
  const previous = kitsOf(catalog).find((k) => k.kitId === kit.kitId) ?? null;
  return commit(input, withKit(catalog, kit.kitId, kit), kit.kitId, previous);
}

/** `deleteKit`: remove one kit (the parts it names stay). */
export function applyDeleteKit(input: OpInput, args: { kitId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = kitsOf(catalog).find((k) => k.kitId === args.kitId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/kitId', args.kitId, 'an existing kitId', 'no kit with this id'), code: 'reference_missing' } };
  return commit(input, withKit(catalog, args.kitId, null), args.kitId, previous);
}
