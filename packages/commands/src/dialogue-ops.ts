/**
 * Phase 23.16: dialogue content (`content.dialogues`, `content.speakers`,
 * `content.dialogueSettings`).
 *
 * `setDialogue {dialogue: {dialogueId, name, graph?}}` creates or replaces
 * one conversation (without a graph: a new one gets its Start node, an
 * existing one keeps its graph — a rename); its graph is edited with
 * `graphEdit` on owner kind `dialogue` (commands/src/graph-ops.ts).
 * `deleteDialogue {dialogueId}` removes one (refused by the resulting-state
 * check while a Jump of another conversation names it). `setSpeaker
 * {speaker}` / `deleteSpeaker {speakerId}` the same for the speaker registry
 * (a speaker a line names cannot be deleted). `setDialogueSettings
 * {settings | null}` replaces the settings. Each is one undo step; the change
 * records the value before and after (`setDialogue {dialogueKind, id,
 * previous, next}`).
 */
import {
  canonicalDialogue,
  canonicalDialogues,
  canonicalDialogueSettings,
  canonicalSpeaker,
  canonicalSpeakers,
  newDialogueGraph,
  validateDialogue,
  validateDialogueSettings,
  validateSpeaker,
  type DialogueDocument,
  type DialogueSettings,
  type DialogueSpeaker,
  type ModelErrorV2,
} from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, DialogueKind, SetDialogueArgs, SetDialogueChange } from './types';

type WithDialogue = ContentDocument & { dialogues?: DialogueDocument[]; speakers?: DialogueSpeaker[]; dialogueSettings?: DialogueSettings };
type Value = DialogueDocument | DialogueSpeaker | DialogueSettings;

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

export const dialoguesOf = (content: ContentDocument): DialogueDocument[] => (content as WithDialogue).dialogues ?? [];
export const speakersOf = (content: ContentDocument): DialogueSpeaker[] => (content as WithDialogue).speakers ?? [];

/** The value a dialogue op addresses (null: none). */
export function dialogueValueOf(content: ContentDocument, kind: DialogueKind, id: string): Value | null {
  if (kind === 'dialogue') return dialoguesOf(content).find((d) => d.dialogueId === id) ?? null;
  if (kind === 'speaker') return speakersOf(content).find((s) => s.speakerId === id) ?? null;
  return (content as WithDialogue).dialogueSettings ?? null;
}

/** The content with one value set (or removed when null); lists stay canonical and are absent when empty. */
export function withDialogueValue(content: ContentDocument, kind: DialogueKind, id: string, value: Value | null): ContentDocument {
  const c = { ...(content as WithDialogue) };
  if (kind === 'dialogue') {
    const list = (c.dialogues ?? []).filter((d) => d.dialogueId !== id);
    if (value !== null) list.push(deepClone(value as DialogueDocument));
    if (list.length > 0) c.dialogues = canonicalDialogues(list);
    else delete c.dialogues;
  } else if (kind === 'speaker') {
    const list = (c.speakers ?? []).filter((s) => s.speakerId !== id);
    if (value !== null) list.push(deepClone(value as DialogueSpeaker));
    if (list.length > 0) c.speakers = canonicalSpeakers(list);
    else delete c.speakers;
  } else if (value !== null) c.dialogueSettings = canonicalDialogueSettings(value as DialogueSettings);
  else delete c.dialogueSettings;
  return c as ContentDocument;
}

function commit(input: OpInput, next: ContentDocument, kind: DialogueKind, id: string, previous: Value | null): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = dialogueValueOf((gate.content ?? next) as ContentDocument, kind, id);
  const change: SetDialogueChange = { type: 'setDialogue', dialogueKind: kind, id, previous: previous === null ? null : deepClone(previous), next: stored === null ? null : deepClone(stored) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setDialogue', dialogueKind: kind, id, restore: previous === null ? null : deepClone(previous) } } };
}

/** `setDialogue`: create or replace one conversation (no graph: keep the stored one, or a new Start node). */
export function applySetDialogue(input: OpInput, args: SetDialogueArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const raw = args.dialogue as unknown as Record<string, unknown>;
  const id = typeof raw['dialogueId'] === 'string' ? raw['dialogueId'] : '';
  const previous = dialogueValueOf(catalog, 'dialogue', id) as DialogueDocument | null;
  const candidate = raw['graph'] === undefined ? { ...raw, graph: previous !== null ? previous.graph : newDialogueGraph() } : raw;
  const errors: ModelErrorV2[] = [];
  validateDialogue(candidate, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/dialogue') };
  const doc = canonicalDialogue(candidate as unknown as DialogueDocument);
  return commit(input, withDialogueValue(catalog, 'dialogue', doc.dialogueId, doc), 'dialogue', doc.dialogueId, previous);
}

/** `setSpeaker`: create or replace one speaker. */
export function applySetSpeaker(input: OpInput, args: { speaker: DialogueSpeaker }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateSpeaker(args.speaker, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/speaker') };
  const s = canonicalSpeaker(args.speaker);
  return commit(input, withDialogueValue(catalog, 'speaker', s.speakerId, s), 'speaker', s.speakerId, dialogueValueOf(catalog, 'speaker', s.speakerId));
}

/** `setDialogueSettings`: replace the settings (null: the defaults). */
export function applySetDialogueSettings(input: OpInput, args: { settings: DialogueSettings | null }): OpOutcome {
  const catalog = contentOf(input.content);
  if (args.settings !== null) {
    const errors: ModelErrorV2[] = [];
    validateDialogueSettings(args.settings, '', errors);
    if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/settings') };
  }
  const next = args.settings !== null ? canonicalDialogueSettings(args.settings) : null;
  return commit(input, withDialogueValue(catalog, 'settings', '', next), 'settings', '', dialogueValueOf(catalog, 'settings', ''));
}

/** `deleteDialogue` / `deleteSpeaker`: remove one (refused by the resulting-state check while something names it). */
export function applyDeleteDialogueValue(input: OpInput, kind: 'dialogue' | 'speaker', id: string): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = dialogueValueOf(catalog, kind, id);
  const field = kind === 'dialogue' ? 'dialogueId' : 'speakerId';
  if (previous === null) return { ok: false, error: { ...fieldValue(`/args/${field}`, id, `an existing ${field}`, `no ${kind} with this id`), code: 'reference_missing' } };
  return commit(input, withDialogueValue(catalog, kind, id, null), kind, id, previous);
}
