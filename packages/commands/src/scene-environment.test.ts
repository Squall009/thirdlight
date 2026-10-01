/**
 * A scene's look through the commands: `setEnvironment {sceneId}` edits the
 * scene document (one undo), the project's part keeps the quality and the
 * presets, and the scene-index ops carry a scene's look so a new scene can
 * copy one and an undone delete gets its look back.
 */
import { describe, expect, it } from 'vitest';
import type { SceneEnvironment, SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
let counter = 0;
const run = (state: State, op: string, args: Record<string, unknown>, extra: Partial<State> = {}) => {
  counter += 1;
  return applyMutation({ ...state, ...extra } as State, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x2710e00 + counter).toString(16).padStart(32, '0')}`, args });
};
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const LOOK: SceneEnvironment = { sky: { mode: 'color', color: '#203040' }, fog: { mode: 'linear', color: '#AABBCC', near: 5, far: 50 }, wind: { direction: [0, 1], strength: 2, gust: 0, gustFrequency: 0, turbulence: 0 } };
const lookOf = (s: State): unknown => (s.scene as { environment?: unknown }).environment;

describe('a scene look through setEnvironment {sceneId}', () => {
  it('sets the scene document, canonical, as one undo; redo puts it back', () => {
    const r = run(fresh(), 'setEnvironment', { sceneId: 'scene-main', environment: LOOK });
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    if (!r.ok) return;
    expect(lookOf(r.state)).toEqual({ wind: LOOK.wind, sky: { color: '#203040', mode: 'color' }, fog: { color: '#aabbcc', far: 50, mode: 'linear', near: 5 } });
    expect(r.result.change).toMatchObject({ type: 'setEnvironment', sceneId: 'scene-main', previous: null });
    // The content is untouched.
    expect((r.state.content as { environment?: unknown }).environment).toBeUndefined();
    const undone = run(r.state, 'undo', {});
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(lookOf(undone.state)).toBeUndefined();
    expect(undone.result.change).toMatchObject({ type: 'setEnvironment', sceneId: 'scene-main', next: null });
    const redone = run(undone.state, 'redo', {});
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(lookOf(redone.state)).toEqual(lookOf(r.state));
  });

  it('an empty look clears the scene to the engine defaults', () => {
    const r = run(fresh(), 'setEnvironment', { sceneId: 'scene-main', environment: LOOK });
    if (!r.ok) throw new Error(JSON.stringify(r.result));
    const cleared = run(r.state, 'setEnvironment', { sceneId: 'scene-main', environment: {} });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect('environment' in cleared.state.scene).toBe(false);
  });

  it('refuses a look without a sceneId, the project part with one, and an unknown scene, each saying why', () => {
    const noScene = run(fresh(), 'setEnvironment', { environment: { sky: LOOK.sky } });
    expect(noScene.ok).toBe(false);
    expect(JSON.stringify(noScene.result)).toContain('sceneId');
    const quality = run(fresh(), 'setEnvironment', { sceneId: 'scene-main', environment: { quality: 'low' } });
    expect(quality.ok).toBe(false);
    expect(JSON.stringify(quality.result)).toContain("project's");
    const other = run(fresh(), 'setEnvironment', { sceneId: 'scene-nope', environment: LOOK });
    expect(other.ok).toBe(false);
    expect(run(fresh(), 'setEnvironment', { sceneId: 3, environment: LOOK }).ok).toBe(false);
  });

  it("the project's part keeps the quality and the presets", () => {
    const r = run(fresh(), 'setEnvironment', { environment: { quality: 'medium', presets: [{ presetId: 'night', name: 'Night', sky: { mode: 'color', color: '#000000' } }] } });
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    if (r.ok) expect((r.state.content as { environment?: { quality?: string } }).environment?.quality).toBe('medium');
  });
});

describe('scene-index ops carry a scene look', () => {
  it('createScene {environmentFrom} records the copied look for the new scene; the default is none', () => {
    const looked = run(fresh(), 'setEnvironment', { sceneId: 'scene-main', environment: LOOK });
    if (!looked.ok) throw new Error(JSON.stringify(looked.result));
    const copy = run(looked.state, 'createScene', { sceneId: 'level-two', name: 'Two', environmentFrom: 'scene-main' });
    expect(copy.ok, JSON.stringify(copy.result)).toBe(true);
    if (!copy.ok) return;
    expect((copy.result.change as { environments?: unknown }).environments).toEqual({ 'level-two': lookOf(looked.state) });
    const plain = run(looked.state, 'createScene', { sceneId: 'level-three', name: 'Three' });
    expect(plain.ok).toBe(true);
    if (plain.ok) expect('environments' in plain.result.change).toBe(false);
    // Another scene's look comes from the host's facts.
    const other = run(copy.state, 'createScene', { sceneId: 'level-four', name: 'Four', environmentFrom: 'level-two' }, { sceneEnvironments: new Map([['level-two', { sky: { mode: 'color', color: '#ffffff' } }]]) });
    expect(other.ok).toBe(true);
    if (other.ok) expect((other.result.change as { environments?: unknown }).environments).toEqual({ 'level-four': { sky: { mode: 'color', color: '#ffffff' } } });
    expect(run(looked.state, 'createScene', { name: 'X', environmentFrom: 'nowhere' }).ok).toBe(false);
  });

  it("deleteScene records the deleted scene's look; its undo and redo carry it", () => {
    const two = run(fresh(), 'createScene', { sceneId: 'level-two', name: 'Two' });
    if (!two.ok) throw new Error(JSON.stringify(two.result));
    const look = { sky: { mode: 'color' as const, color: '#102030' } };
    const del = run(two.state, 'deleteScene', { sceneId: 'level-two' }, { sceneEnvironments: new Map([['level-two', look]]) });
    expect(del.ok, JSON.stringify(del.result)).toBe(true);
    if (!del.ok) return;
    expect((del.result.change as { environments?: unknown }).environments).toEqual({ 'level-two': look });
    const undone = run(del.state, 'undo', {});
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.result.change).toMatchObject({ type: 'setSceneIndex', environments: { 'level-two': look } });
    const redone = run(undone.state, 'redo', {});
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(redone.result.change).toMatchObject({ type: 'setSceneIndex', environments: { 'level-two': look } });
  });
});
