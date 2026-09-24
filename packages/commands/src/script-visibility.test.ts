/**
 * Phase 15.4: script property visibility (public/private) at the command
 * level — a private property is never stored and never settable per object
 * or per prefab copy; `"public"` is normalized away; groups/headers/tooltips
 * are kept; a declaration update keeps the published source; a declaration
 * derived from code is edited in the code only.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type ContentDocument = typeof BEFORE.content;

/** The stored behavior component of one scene entity. */
function behaviorOf(state: CommandState<SceneV4>, id: string): { behaviorId: string; values: Record<string, unknown> } | undefined {
  const e = state.scene.entities.find((x) => x.id === id);
  return (e?.components as unknown as { behavior?: { behaviorId: string; values: Record<string, unknown> } } | undefined)?.behavior;
}

let counter = 0;
function rid(): string {
  counter += 1;
  return `req-${(0x15400000 + counter).toString(16).padStart(32, '0')}`;
}

function base(content: ContentDocument = BEFORE.content): CommandState<SceneV4> {
  return createCommandState(BEFORE.scene, content);
}

function run(state: CommandState<SceneV4>, op: string, args: unknown): ReturnType<typeof applyMutation> {
  return applyMutation(state, { op, projectId: 'demo-0003', expectedRevision: state.scene.revision, requestId: rid(), origin: { kind: 'mcp', clientId: 'visibility' }, args });
}

function ok(r: ReturnType<typeof applyMutation>): CommandState<SceneV4> {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.result)}`);
  return r.state as CommandState<SceneV4>;
}

function err(r: ReturnType<typeof applyMutation>): Record<string, unknown> {
  if (r.ok) throw new Error('expected failure');
  return r.result.error as unknown as Record<string, unknown>;
}

const DECLARATION = {
  properties: [
    { key: 'speed', label: 'Speed', type: 'number', default: 3, min: 0, max: 10, visibility: 'public', group: 'Movement', header: 'Tuning', tooltip: 'Metres per second.' },
    { key: 'secret', label: 'Secret', type: 'number', default: 1, visibility: 'private' },
  ],
};

/** A plain leaf entity of the fixture scene (no camera, controller, physics or children). */
function plainEntityId(state: CommandState<SceneV4>): string {
  const e = state.scene.entities.find((x) => {
    const c = x.components as Record<string, unknown>;
    return c['camera'] === undefined && c['controller'] === undefined && c['collider'] === undefined && c['behavior'] === undefined && !state.scene.entities.some((y) => y.parentId === x.id);
  });
  if (e === undefined) throw new Error('no plain entity in the fixture');
  return e.id;
}

function published(): CommandState<SceneV4> {
  return ok(run(base(), 'publishBehavior', { behaviorId: 'mover-a', displayName: 'Mover', mode: 'declaration-create', declaration: DECLARATION }));
}

describe('phase 15.4: declared property visibility', () => {
  it('stores private, drops an explicit public and keeps group/header/tooltip', () => {
    const state = published();
    const record = state.content?.behaviors.find((b) => b.behaviorId === 'mover-a');
    expect(record?.declaration.properties).toEqual([
      { key: 'speed', label: 'Speed', type: 'number', default: 3, min: 0, max: 10, group: 'Movement', header: 'Tuning', tooltip: 'Metres per second.' },
      { key: 'secret', label: 'Secret', type: 'number', default: 1, visibility: 'private' },
    ]);
  });

  it('refuses a bad visibility or an over-long text', () => {
    const bad = (patch: Record<string, unknown>): Record<string, unknown> =>
      err(run(base(), 'publishBehavior', { behaviorId: 'mover-b', displayName: 'Mover', mode: 'declaration-create', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3, ...patch }] } }));
    expect(bad({ visibility: 'protected' })).toMatchObject({ code: 'property_value', key: 'speed' });
    expect(bad({ group: '' })).toMatchObject({ code: 'property_value', key: 'speed' });
    expect(bad({ tooltip: 'x'.repeat(257) })).toMatchObject({ code: 'property_value', key: 'speed' });
    expect(bad({ header: 'a\nb' })).toMatchObject({ code: 'property_value', key: 'speed' });
    expect(bad({ hidden: true })).toMatchObject({ code: 'field_unexpected' });
  });

  it('attaches with public values only and refuses a private override', () => {
    let state = published();
    const id = plainEntityId(state);
    state = ok(run(state, 'setBehaviorProperties', { entityId: id, behaviorId: 'mover-a', values: { speed: 5 } }));
    const stored = behaviorOf(state, id);
    expect(stored).toEqual({ behaviorId: 'mover-a', values: { speed: 5 } });
    const refused = err(run(state, 'setBehaviorProperties', { entityId: id, behaviorId: 'mover-a', values: { secret: 2 } }));
    expect(refused).toMatchObject({ code: 'property_private', cls: 'validation', behaviorId: 'mover-a', key: 'secret' });
  });

  it('refuses a private override on a prefab copy', () => {
    let state = published();
    const id = plainEntityId(state);
    state = ok(run(state, 'setBehaviorProperties', { entityId: id, behaviorId: 'mover-a', values: {} }));
    state = ok(run(state, 'createPrefab', { prefabId: 'prefab-vis', displayName: 'Vis', sourceEntityId: id }));
    const def = state.content?.prefabs.find((p) => p.prefabId === 'prefab-vis');
    const localId = def?.entities[0]?.localId as string;
    expect(err(run(state, 'instantiatePrefab', { prefabId: 'prefab-vis', overrides: [{ localId, key: 'secret', value: 9 }] }))).toMatchObject({ code: 'property_private', key: 'secret' });
    const placed = ok(run(state, 'instantiatePrefab', { prefabId: 'prefab-vis', overrides: [{ localId, key: 'speed', value: 7 }] }));
    const copy = placed.scene.entities.find((e) => (e.components as unknown as Record<string, unknown>)['prefab'] !== undefined && behaviorOf(placed, e.id)?.values['speed'] === 7);
    expect(copy !== undefined ? behaviorOf(placed, copy.id)?.values : null).toEqual({ speed: 7 });
  });

  it('a public property made private: its stored value becomes inert and the next write drops it', () => {
    let state = published();
    const id = plainEntityId(state);
    state = ok(run(state, 'setBehaviorProperties', { entityId: id, behaviorId: 'mover-a', values: { speed: 5 } }));
    const privateSpeed = { properties: [{ ...DECLARATION.properties[0], visibility: 'private' }, DECLARATION.properties[1]] };
    state = ok(run(state, 'publishBehavior', { behaviorId: 'mover-a', displayName: 'Mover', mode: 'declaration-update', declaration: privateSpeed }));
    // The document stays valid with the old value in place (inert) …
    expect(behaviorOf(state, id)?.values).toEqual({ speed: 5 });
    // … and a new property added to a declaration in use needs no stored value.
    const withNew = { properties: [...privateSpeed.properties, { key: 'jump', label: 'Jump', type: 'number', default: 2 }] };
    state = ok(run(state, 'publishBehavior', { behaviorId: 'mover-a', displayName: 'Mover', mode: 'declaration-update', declaration: withNew }));
    state = ok(run(state, 'setBehaviorProperties', { entityId: id, behaviorId: 'mover-a', values: { jump: 4 } }));
    expect(behaviorOf(state, id)?.values).toEqual({ jump: 4 });
  });

  it('a declaration update keeps the published source; a code-derived declaration is refused', () => {
    const source = {
      sourceDigest: 'a'.repeat(64),
      sourceByteLength: 100,
      entryPath: 'src/index.ts',
      fileCount: 1,
      manifestDigest: 'b'.repeat(64),
      outputDigest: 'c'.repeat(64),
      outputByteLength: 100,
      requiredModules: [],
      publishedRevision: 1,
    };
    const content = (declaredInCode: boolean): ContentDocument => ({
      ...BEFORE.content,
      behaviors: [...BEFORE.content.behaviors, { behaviorId: 'scripted', displayName: 'Scripted', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3 }] }, source: { ...source, ...(declaredInCode ? { declaredInCode: true as const } : {}) }, publishedRevision: 1 }],
    });
    const update = { behaviorId: 'scripted', displayName: 'Scripted', mode: 'declaration-update', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 4 }] } };
    const kept = ok(run(base(content(false)), 'publishBehavior', update));
    expect(kept.content?.behaviors.find((b) => b.behaviorId === 'scripted')?.source?.sourceDigest).toBe(source.sourceDigest);
    expect(err(run(base(content(true)), 'publishBehavior', update))).toMatchObject({ code: 'behavior_declaration_mismatch', reason: 'declared_in_code' });
  });
});
