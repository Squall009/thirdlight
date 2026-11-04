/**
 * Voxel kits (`content.voxelKits`).
 *
 * `setVoxelKit {kit}` creates or replaces one kit (by voxelKitId: its format,
 * material type, test material binding, cases, join profiles, trim layout and
 * game data); `deleteVoxelKit {voxelKitId}` removes one. Each is one undo; the
 * change records the kit before and after (`setVoxelKit {voxelKitId,
 * previous, next}`, null = none).
 *
 * The model assets a kit's meshes name are not checked here: deleting an
 * asset is never refused because a kit names it; the kit check reports it.
 */
import { canonicalVoxelKit, canonicalVoxelKits, validateVoxelKit, type ModelErrorV2, type VoxelKit } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetVoxelKitChange } from './types';
import { withListRecord } from './record-lists';

type WithVoxelKits = ContentDocument & { voxelKits?: VoxelKit[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

/** The content with one voxel kit set (or removed when null); the list stays canonical and is absent when empty. */
export function withVoxelKit(content: ContentDocument, voxelKitId: string, kit: VoxelKit | null): ContentDocument {
  const c = { ...(content as WithVoxelKits) };
  const list = withListRecord(c.voxelKits, (k) => k.voxelKitId, voxelKitId, kit === null ? null : canonicalVoxelKits([deepClone(kit)])[0]!);
  if (list.length > 0) c.voxelKits = list;
  else delete c.voxelKits;
  return c as ContentDocument;
}

export const voxelKitsOf = (content: ContentDocument): VoxelKit[] => (content as WithVoxelKits).voxelKits ?? [];

function commit(input: OpInput, next: ContentDocument, voxelKitId: string, previous: VoxelKit | null): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = voxelKitsOf((gate.content ?? next) as ContentDocument).find((k) => k.voxelKitId === voxelKitId) ?? null;
  const change: SetVoxelKitChange = { type: 'setVoxelKit', voxelKitId, previous: previous === null ? null : deepClone(previous), next: stored === null ? null : deepClone(stored) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setVoxelKit', voxelKitId, restore: previous === null ? null : deepClone(previous) } } };
}

/** `setVoxelKit`: create or replace one voxel kit. */
export function applySetVoxelKit(input: OpInput, args: { kit: VoxelKit }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateVoxelKit(args.kit, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/kit') };
  const kit = canonicalVoxelKit(args.kit);
  const previous = voxelKitsOf(catalog).find((k) => k.voxelKitId === kit.voxelKitId) ?? null;
  return commit(input, withVoxelKit(catalog, kit.voxelKitId, kit), kit.voxelKitId, previous);
}

/** `deleteVoxelKit`: remove one voxel kit (the assets it names stay). */
export function applyDeleteVoxelKit(input: OpInput, args: { voxelKitId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = voxelKitsOf(catalog).find((k) => k.voxelKitId === args.voxelKitId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/voxelKitId', args.voxelKitId, 'an existing voxelKitId', 'no voxel kit with this id'), code: 'reference_missing' } };
  return commit(input, withVoxelKit(catalog, args.voxelKitId, null), args.voxelKitId, previous);
}
