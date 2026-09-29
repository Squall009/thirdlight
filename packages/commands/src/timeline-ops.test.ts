/**
 * Timelines through the commands — create, replace (keys come
 * back sorted by time), delete, references to audio assets / effects,
 * validation errors with paths, no_change, and undo/redo.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4, TimelineAsset } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetTimelineChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x2317a0 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: SetTimelineChange } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change as unknown as SetTimelineChange };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string; path?: string } {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  return r.result['error'] as { code: string; message: string; path?: string };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const timelines = (s: State): TimelineAsset[] => (s.content as { timelines?: TimelineAsset[] }).timelines ?? [];

const SHOT: TimelineAsset = {
  timelineId: 'shot',
  name: 'Shot',
  duration: 3,
  slots: [{ name: 'actor', entity: 'actor-1' }],
  tracks: [
    { trackId: 'move', type: 'transform', target: 'actor', keys: [{ time: 2, position: [1, 0, 0] }, { time: 0, position: [0, 0, 0] }] },
    { trackId: 'sig', type: 'signal', keys: [{ time: 1, name: 'go' }] },
  ],
};

describe('timelines through the commands', () => {
  it('creates (keys sorted), replaces with one undo step each, deletes', () => {
    let s = fresh();
    const made = ok(s, 'setTimeline', { timeline: SHOT });
    expect(made.change).toMatchObject({ type: 'setTimeline', timelineId: 'shot', previous: null });
    expect(made.change.next!.tracks[0]!.keys.map((k) => k.time)).toEqual([0, 2]);
    s = made.state;
    expect(refused(s, 'setTimeline', { timeline: SHOT }).code).toBe('no_change');
    const moved = structuredClone(timelines(s)[0]!);
    moved.tracks[0]!.keys[1]!.time = 2.5;
    s = ok(s, 'setTimeline', { timeline: moved }).state;
    s = ok(s, 'undo', {}).state;
    expect(timelines(s)[0]!.tracks[0]!.keys[1]!.time).toBe(2);
    s = ok(s, 'redo', {}).state;
    expect(timelines(s)[0]!.tracks[0]!.keys[1]!.time).toBe(2.5);
    s = ok(s, 'deleteTimeline', { timelineId: 'shot' }).state;
    expect((s.content as { timelines?: unknown }).timelines).toBeUndefined();
    expect(refused(s, 'deleteTimeline', { timelineId: 'shot' }).code).toBe('reference_missing');
    s = ok(s, 'undo', {}).state;
    expect(timelines(s).map((t) => t.timelineId)).toEqual(['shot']);
  });

  it('refuses malformed timelines with the path of the problem, missing references and bad args', () => {
    const s = fresh();
    const unbound = refused(s, 'setTimeline', { timeline: { ...SHOT, tracks: [{ ...SHOT.tracks[0]!, target: 'nobody' }] } });
    expect(unbound.code).toBe('reference_missing');
    expect(unbound.path).toBe('/args/timeline/tracks/0/target');
    const late = refused(s, 'setTimeline', { timeline: { ...SHOT, tracks: [{ trackId: 'sig', type: 'signal', keys: [{ time: 9, name: 'go' }] }] } });
    expect(late.path).toBe('/args/timeline/tracks/0/keys/0/time');
    // An audio key names an audio or music asset of the project; an effect key a project effect.
    expect(refused(s, 'setTimeline', { timeline: { ...SHOT, tracks: [{ trackId: 'a', type: 'audio', keys: [{ time: 0, kind: 'sfx', asset: 'no-such-sound' }] }] } }).code).toBe('reference_missing');
    expect(refused(s, 'setTimeline', { timeline: { ...SHOT, tracks: [{ trackId: 'e', type: 'effect', keys: [{ time: 0, effect: 'no-such-effect' }] }] } }).code).toBe('reference_missing');
    expect(refused(s, 'setTimeline', { tl: SHOT }).code).toBe('field_unexpected');
    expect(refused(s, 'deleteTimeline', { timelineId: 3 }).code).toBe('field_type');
  });
});
