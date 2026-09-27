/**
 * Phase 23.17: timelines (`content.timelines`, sequencer assets).
 *
 * `setTimeline {timeline}` creates or replaces one timeline (by timelineId —
 * its whole value: slots, markers, tracks and keys); `deleteTimeline
 * {timelineId}` removes one. Each is one undo step (the editor sends one
 * setTimeline per drag gesture); the change records the value before and
 * after (`setTimeline {timelineId, previous, next}`).
 */
import { canonicalTimeline, canonicalTimelines, validateTimeline, type ModelErrorV2, type TimelineAsset } from '@thirdlight/project-model';

import { fieldValue, noChangeContent, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetTimelineChange } from './types';

type WithTimelines = ContentDocument & { timelines?: TimelineAsset[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

export const timelinesOf = (content: ContentDocument): TimelineAsset[] => (content as WithTimelines).timelines ?? [];

/** The timeline with this id (null: none). */
export function timelineOf(content: ContentDocument, id: string): TimelineAsset | null {
  return timelinesOf(content).find((t) => t.timelineId === id) ?? null;
}

/** The content with one timeline set (or removed when null); the list stays canonical and is absent when empty. */
export function withTimeline(content: ContentDocument, id: string, value: TimelineAsset | null): ContentDocument {
  const c = { ...(content as WithTimelines) };
  const list = (c.timelines ?? []).filter((t) => t.timelineId !== id);
  if (value !== null) list.push(deepClone(value));
  if (list.length > 0) c.timelines = canonicalTimelines(list);
  else delete c.timelines;
  return c as ContentDocument;
}

function commit(input: OpInput, next: ContentDocument, id: string, previous: TimelineAsset | null): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = timelineOf((gate.content ?? next) as ContentDocument, id);
  const change: SetTimelineChange = { type: 'setTimeline', timelineId: id, previous: previous === null ? null : deepClone(previous), next: stored === null ? null : deepClone(stored) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setTimeline', timelineId: id, restore: previous === null ? null : deepClone(previous) } } };
}

/** `setTimeline`: create or replace one timeline (refused with no_change when it equals the stored one). */
export function applySetTimeline(input: OpInput, args: { timeline: TimelineAsset }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateTimeline(args.timeline, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/timeline') };
  const tl = canonicalTimeline(args.timeline);
  const previous = timelineOf(catalog, tl.timelineId);
  if (previous !== null && JSON.stringify(previous) === JSON.stringify(tl)) {
    return { ok: false, error: noChangeContent() };
  }
  return commit(input, withTimeline(catalog, tl.timelineId, tl), tl.timelineId, previous);
}

/** `deleteTimeline`: remove one timeline. */
export function applyDeleteTimeline(input: OpInput, id: string): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = timelineOf(catalog, id);
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/timelineId', id, 'an existing timelineId', 'no timeline with this id'), code: 'reference_missing' } };
  return commit(input, withTimeline(catalog, id, null), id, previous);
}
