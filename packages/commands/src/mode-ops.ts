/**
 * Phase 23.10: game modes and behavior groups.
 *
 * `setModes {modes}` replaces the whole list of game modes (`content.modes`;
 * the first is the start mode — order is data, so a reorder is one edit),
 * `setBehaviorGroups {groups}` the behavior group names
 * (`content.behaviorGroups`). Each is one undo step; the change carries the
 * whole list before and after. A mode's references (UI documents, input
 * maps, groups) and the groups objects carry are checked by the
 * resulting-state gate, so removing a group or a document still in use is
 * refused there. An empty list removes the field (the content bytes stay as
 * before modes existed).
 */
import { canonicalEventCues, canonicalModes, validateBehaviorGroups, validateEventCues, validateModes, type EventCue, type GameMode, type ModelErrorV2 } from '@thirdlight/project-model';

import type { CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetBehaviorGroupsChange, SetEventCuesChange, SetModesChange } from './types';

type WithModes = ContentDocument & { modes?: GameMode[]; behaviorGroups?: string[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

export const modesOf = (content: ContentDocument): GameMode[] => (content as WithModes).modes ?? [];
export const behaviorGroupsOf = (content: ContentDocument): string[] => (content as WithModes).behaviorGroups ?? [];

/** The content with the mode list replaced (canonical; an empty list removes the field). */
export function withModes(content: ContentDocument, modes: readonly GameMode[]): ContentDocument {
  const c = { ...(content as WithModes) };
  if (modes.length > 0) c.modes = canonicalModes(modes);
  else delete c.modes;
  return c as ContentDocument;
}

/** The content with the behavior group names replaced (an empty list removes the field). */
export function withBehaviorGroups(content: ContentDocument, groups: readonly string[]): ContentDocument {
  const c = { ...(content as WithModes) };
  if (groups.length > 0) c.behaviorGroups = [...groups];
  else delete c.behaviorGroups;
  return c as ContentDocument;
}

export function applySetModes(input: OpInput, args: { modes: GameMode[] }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateModes(args.modes, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/modes') };
  const previous = deepClone(modesOf(catalog));
  const next = canonicalModes(args.modes);
  const content = withModes(catalog, next);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, content);
  if (!gate.ok) return gate;
  const change: SetModesChange = { type: 'setModes', previous, next: deepClone(next) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setModes', restore: previous } } };
}

export function applySetBehaviorGroups(input: OpInput, args: { groups: string[] }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateBehaviorGroups(args.groups, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/groups') };
  const previous = [...behaviorGroupsOf(catalog)];
  const next = [...args.groups];
  const content = withBehaviorGroups(catalog, next);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, content);
  if (!gate.ok) return gate;
  const change: SetBehaviorGroupsChange = { type: 'setBehaviorGroups', previous, next };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setBehaviorGroups', restore: previous } } };
}

// ---- phase 24.4i: the event → cue table ------------------------------------------

export const eventCuesOf = (content: ContentDocument): EventCue[] => (content as ContentDocument & { eventCues?: EventCue[] }).eventCues ?? [];

/** The content with the event → cue table replaced (canonical; an empty table removes the field). */
export function withEventCues(content: ContentDocument, cues: readonly EventCue[]): ContentDocument {
  const c = { ...(content as ContentDocument & { eventCues?: EventCue[] }) };
  if (cues.length > 0) c.eventCues = canonicalEventCues(cues);
  else delete c.eventCues;
  return c as ContentDocument;
}

/** `setEventCues {cues}`: the whole table (one undo step; the sounds are checked by the resulting-state gate). */
export function applySetEventCues(input: OpInput, args: { cues: EventCue[] }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateEventCues(args.cues, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/cues') };
  const previous = deepClone(eventCuesOf(catalog));
  const next = canonicalEventCues(args.cues);
  const content = withEventCues(catalog, next);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, content);
  if (!gate.ok) return gate;
  const change: SetEventCuesChange = { type: 'setEventCues', previous, next: deepClone(next) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setEventCues', restore: previous } } };
}
