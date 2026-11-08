/**
 * Physical profiles (`content.materialProfiles`, in `content.json`).
 *
 * `setMaterialProfile {profile}` creates or replaces one of the project's
 * profiles (by profileId; one with an engine profile's id overrides it);
 * `deleteMaterialProfile {profileId}` removes one (refused while a material
 * names a project-only profile: the resulting-state check reports it; a
 * project profile overriding an engine one falls back to the engine's). Each
 * is one undo; the change records the profile before and after
 * (`setMaterialProfile {profileId, previous, next}`, null = none).
 */
import { canonicalMaterialProfile, validateMaterialProfile, type MaterialProfile, type ModelErrorV2 } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetMaterialProfileChange } from './types';
import { withListRecord } from './record-lists';

type WithProfiles = ContentDocument & { materialProfiles?: MaterialProfile[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

export const materialProfilesOfContent = (content: ContentDocument): MaterialProfile[] => (content as WithProfiles).materialProfiles ?? [];

/** The content with one profile set (or removed when null); the list stays in id order and is absent when empty. */
export function withMaterialProfile(content: ContentDocument, profileId: string, profile: MaterialProfile | null): ContentDocument {
  const c = { ...(content as WithProfiles) };
  const list = withListRecord(c.materialProfiles, (p) => p.profileId, profileId, profile === null ? null : canonicalMaterialProfile(deepClone(profile)));
  if (list.length > 0) c.materialProfiles = list;
  else delete c.materialProfiles;
  return c as ContentDocument;
}

function commit(input: OpInput, next: ContentDocument, profileId: string, previous: MaterialProfile | null): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = materialProfilesOfContent((gate.content ?? next) as ContentDocument).find((p) => p.profileId === profileId) ?? null;
  const change: SetMaterialProfileChange = { type: 'setMaterialProfile', profileId, previous: previous === null ? null : deepClone(previous), next: stored === null ? null : deepClone(stored) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setMaterialProfile', profileId, restore: previous === null ? null : deepClone(previous) } } };
}

/** `setMaterialProfile`: create or replace one of the project's physical profiles. */
export function applySetMaterialProfile(input: OpInput, args: { profile: MaterialProfile }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateMaterialProfile(args.profile, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/profile') };
  const profile = canonicalMaterialProfile(args.profile);
  const previous = materialProfilesOfContent(catalog).find((p) => p.profileId === profile.profileId) ?? null;
  return commit(input, withMaterialProfile(catalog, profile.profileId, profile), profile.profileId, previous);
}

/** `deleteMaterialProfile`: remove one of the project's profiles. */
export function applyDeleteMaterialProfile(input: OpInput, args: { profileId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = materialProfilesOfContent(catalog).find((p) => p.profileId === args.profileId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/profileId', args.profileId, "a profileId of the project's profiles", 'no project profile with this id (the engine profiles are not stored)'), code: 'reference_missing' } };
  return commit(input, withMaterialProfile(catalog, args.profileId, null), args.profileId, previous);
}
