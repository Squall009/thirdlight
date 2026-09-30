/**
 * Event cues and transitions through the commands: `setEventCues` (the whole event →
 * cue table; its sounds must be audio assets; undo/redo; an empty table
 * removes the field), a trigger's `sceneTransition` (its shape; the scenes
 * and the spawn are the cross-scene project rule), a switch's `action`, a
 * velocity face-movement and a spawn's yaw through `setComponent`.
 */
import { describe, expect, it } from 'vitest';
import type { EventCue, SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetEventCuesChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
const AUDIO_RECIPE = { profile: 'audio', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } };
const AUDIO_METRICS = { format: 'wav', channels: 1, sampleRate: 48000, bitsPerSample: 16, durationMs: 2 };

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x244e0 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown; id: string } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change, id: String(r.result['createdId'] ?? '') };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(false);
  return r.result['error'] as { code: string; message: string };
}
function withSound(): State {
  const s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
  return ok(s, 'publishAsset', { mode: 'create', assetId: 'asset-sfx', kind: 'audio', sourceDigest: 'b'.repeat(64), sourceByteLength: 236, importRecipe: AUDIO_RECIPE, metrics: AUDIO_METRICS, importedAt: '2026-09-28T00:00:00Z' }).state;
}
const cuesOf = (s: State): EventCue[] | undefined => (s.content as { eventCues?: EventCue[] }).eventCues;
const comp = (s: State, id: string, name: string): unknown => (s.scene.entities.find((e) => e.id === id)?.components as Record<string, unknown> | undefined)?.[name];

describe('the event → cue table (setEventCues)', () => {
  it('sets the whole table (canonical), refuses a sound that is not audio, undoes and redoes; [] removes it', () => {
    let s = withSound();
    const cues: EventCue[] = [
      { on: 'signal', name: 'opened', assetId: 'asset-sfx' },
      { volume: 0.5, bus: 'ui', assetId: 'asset-sfx', entity: 'box-0001', name: 'collected', on: 'event' } as EventCue,
    ];
    const made = ok(s, 'setEventCues', { cues });
    expect(made.change as SetEventCuesChange).toMatchObject({ type: 'setEventCues', previous: [], next: [cues[0], { on: 'event', name: 'collected', entity: 'box-0001', assetId: 'asset-sfx', volume: 0.5, bus: 'ui' }] });
    s = made.state;
    expect(JSON.stringify(cuesOf(s)?.[1])).toBe('{"on":"event","name":"collected","entity":"box-0001","assetId":"asset-sfx","volume":0.5,"bus":"ui"}');
    expect(refused(s, 'setEventCues', { cues: [{ on: 'signal', name: 'x', assetId: 'asset-2b11d4a76c9f0e35' }] }).code).toBe('asset_reference_missing'); // a model
    expect(refused(s, 'setEventCues', { cues: [{ on: 'signal', name: 'x', assetId: 'asset-sfx', entity: 'box-0001' }] }).code).toBe('field_unexpected');
    expect(refused(s, 'setEventCues', { cues: [{ on: 'sometimes', name: 'x', assetId: 'asset-sfx' }] }).code).toBe('field_value');
    expect(refused(s, 'setEventCues', { cues: [{ on: 'signal', assetId: 'asset-sfx' }] }).code).toBe('field_missing');
    expect(refused(s, 'setEventCues', { cues: 'nope' }).code).toBe('field_type');
    // As many rows as the game needs.
    ok(s, 'setEventCues', { cues: Array.from({ length: 96 }, (_, i) => ({ ...cues[0], name: `cue-${i}` })) });
    const undone = ok(s, 'undo', {}).state;
    expect(cuesOf(undone)).toBeUndefined();
    const redone = ok(undone, 'redo', {}).state;
    expect(cuesOf(redone)).toEqual(cuesOf(s));
    const cleared = ok(redone, 'setEventCues', { cues: [] }).state;
    expect('eventCues' in (cleared.content ?? {})).toBe(false);
  });
});

describe('trigger scene transitions, switch actions, face velocity and spawn yaw (setComponent)', () => {
  it('a transition is stored (the scenes and the spawn are checked across scenes by the project rule, project-v4.test)', () => {
    let s = withSound();
    const trigger = { size: [2, 2], signal: 'door', sceneTransition: { scene: 'scene-b', spawn: 'spawn-b', unload: [] as string[] } };
    s = ok(s, 'setComponent', { entityId: 'box-0001', component: 'trigger', value: trigger }).state;
    expect(comp(s, 'box-0001', 'trigger')).toEqual(trigger);
    expect(refused(s, 'setComponent', { entityId: 'group-0001', component: 'trigger', value: { ...trigger, sceneTransition: { spawn: 'spawn-b' } } }).code).toBe('field_missing');
    expect(refused(s, 'setComponent', { entityId: 'group-0001', component: 'trigger', value: { ...trigger, sceneTransition: { scene: 'Scene B' } } }).code).toBe('field_value');
    expect(refused(s, 'setComponent', { entityId: 'group-0001', component: 'trigger', value: { ...trigger, sceneTransition: { scene: 'scene-b', unload: ['scene-a', 'scene-a'] } } }).code).toBe('field_value');
  });

  it('a switch reads its action; a face-movement faces its velocity; a spawn has a yaw', () => {
    let s = withSound();
    s = ok(s, 'setComponent', { entityId: 'box-0001', component: 'switch', value: { mode: 'interact', signal: 'open', size: [1, 1], action: 'use' } }).state;
    expect(comp(s, 'box-0001', 'switch')).toEqual({ mode: 'interact', signal: 'open', size: [1, 1], action: 'use' });
    expect(refused(s, 'setComponent', { entityId: 'box-0001', component: 'switch', value: { mode: 'stand', signal: 'open', size: [1, 1], action: 'use' } }).code).toBe('field_unexpected');
    expect(refused(s, 'setComponent', { entityId: 'box-0001', component: 'switch', value: { mode: 'interact', signal: 'open', size: [1, 1], action: 'not an action' } }).code).toBe('field_value');
    s = ok(s, 'setComponent', { entityId: 'model-0001', component: 'faceMovement', value: { mode: 'velocity', yawOffset: -90 } }).state;
    expect(comp(s, 'model-0001', 'faceMovement')).toEqual({ mode: 'velocity', yawOffset: -90 });
    expect(refused(s, 'setComponent', { entityId: 'model-0001', component: 'faceMovement', value: { mode: 'velocity', yawRight: 90 } }).code).toBe('field_unexpected');
    expect(refused(s, 'setComponent', { entityId: 'model-0002', component: 'faceMovement', value: { yawRight: 90 } }).code).toBe('field_missing');
    const spawn = ok(s, 'createEntity', { parentId: null, kind: 'group', name: 'Start', transform: { position: [0, 1, 0] }, components: { playerSpawn: {} } });
    s = ok(spawn.state, 'setComponent', { entityId: spawn.id, component: 'playerSpawn', value: { yaw: -45 } }).state;
    expect(comp(s, spawn.id, 'playerSpawn')).toEqual({ yaw: -45 });
    expect(refused(s, 'setComponent', { entityId: spawn.id, component: 'playerSpawn', value: { yaw: 400 } }).code).toBe('field_value');
  });
});
