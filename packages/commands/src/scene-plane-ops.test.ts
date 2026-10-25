/**
 * A scene's default plane through the commands (`setScenePlane`), one undo
 * step, and the upgrade notes of a former 2D project settled by edits: an
 * edit that saves a noted component takes its note off, setting the scene's
 * plane takes the plane note off, and edits elsewhere leave them.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
let counter = 0;
const run = (state: State, op: string, args: Record<string, unknown>) => {
  counter += 1;
  return applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x3710e00 + counter).toString(16).padStart(32, '0')}`, args });
};
const must = (state: State, op: string, args: Record<string, unknown>): State => {
  const r = run(state, op, args);
  expect(r.ok, JSON.stringify(r.result)).toBe(true);
  return (r as { state: State }).state;
};
type Doc = SceneV4 & { defaultPlane?: unknown; migratedFrom2D?: { plane?: true; objects?: Record<string, string[]> } };
const sceneOf = (s: State): Doc => s.scene as Doc;

describe('setScenePlane', () => {
  it('sets and clears the scene default plane, one undo each', () => {
    let s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
    s = must(s, 'setScenePlane', { sceneId: 'scene-main', plane: { axis: 'x', origin: 2 } });
    expect(sceneOf(s).defaultPlane).toEqual({ axis: 'x', origin: 2 });
    const undone = must(s, 'undo', {});
    expect(sceneOf(undone).defaultPlane).toBeUndefined();
    const redone = must(undone, 'redo', {});
    expect(sceneOf(redone).defaultPlane).toEqual({ axis: 'x', origin: 2 });
    s = must(redone, 'setScenePlane', { sceneId: 'scene-main', plane: null });
    expect(sceneOf(s).defaultPlane).toBeUndefined();
  });

  it('refuses a plane that is not one, and another scene', () => {
    const s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
    expect(run(s, 'setScenePlane', { sceneId: 'scene-main', plane: { axis: 'y', origin: 0 } }).ok).toBe(false);
    expect(run(s, 'setScenePlane', { sceneId: 'scene-main' }).ok).toBe(false);
    expect(run(s, 'setScenePlane', { sceneId: 'scene-other', plane: null }).ok).toBe(false);
  });
});

describe("a former 2D project's upgrade notes", () => {
  it('go as the edits save what they note', () => {
    const scene = structuredClone(BEFORE.scene) as Doc;
    const [a, b] = scene.entities.filter((e) => e.components.camera === undefined && e.components.prefab === undefined);
    // As the upgrade leaves them: a converted collider (and a [w, h] trigger), noted.
    (a!.components as Record<string, unknown>)['collider'] = { shape: { type: 'box', hx: 1, hy: 1, hz: 0.5 } };
    (a!.components as Record<string, unknown>)['trigger'] = { size: [1, 2], signal: 'reached' };
    (b!.components as Record<string, unknown>)['collider'] = { shape: { type: 'box', hx: 1, hy: 1, hz: 0.5 } };
    scene.defaultPlane = { axis: 'z', origin: 0 };
    scene.migratedFrom2D = { plane: true, objects: { [a!.id]: ['collider:box', 'trigger:area-depth'], [b!.id]: ['collider:box'] } };
    let s = createCommandState(scene, structuredClone(BEFORE.content)) as State;
    // An edit of another component of a noted object leaves its notes.
    s = must(s, 'setTransform', { entityId: a!.id, transform: { position: [9, 9, 9] } });
    expect(sceneOf(s).migratedFrom2D?.objects?.[a!.id]).toEqual(['collider:box', 'trigger:area-depth']);
    // Saving the collider settles its note; the trigger's stays.
    s = must(s, 'setComponent', { entityId: a!.id, component: 'collider', value: { shape: { type: 'box', hx: 1, hy: 1, hz: 2 } } });
    expect(sceneOf(s).migratedFrom2D?.objects?.[a!.id]).toEqual(['trigger:area-depth']);
    // Deleting a noted object takes its notes with it.
    s = must(s, 'deleteEntity', { entityId: b!.id });
    expect(sceneOf(s).migratedFrom2D?.objects?.[b!.id]).toBeUndefined();
    // Setting the scene's plane (to the one it has) settles the plane note.
    s = must(s, 'setScenePlane', { sceneId: 'scene-main', plane: { axis: 'z', origin: 0 } });
    expect(sceneOf(s).migratedFrom2D).toEqual({ objects: { [a!.id]: ['trigger:area-depth'] } });
  });
});
