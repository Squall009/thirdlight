/**
 * Phase 23.3: named collision layers as project data — `setCollisionLayers`
 * (validation, undo/redo), a collider's `layers` (setComponent; only names
 * the project has, "default" always; 3D projects only), a layer a collider
 * lists cannot be removed, and the 3D physics config carries the names and
 * each collider's layers to the port.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateContentV4, validateSceneV4 } from '@thirdlight/project-model';
import { applyMutation, createCommandState, type CommandState, type ContentDocument } from '@thirdlight/commands';
import { physics3DConfigOf, staticColliderOf3D } from '@thirdlight/runtime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type State = CommandState<Any>;
const DIR = join(__dirname, '..', '..', '..', 'fixtures', 'commands', 'scenarios', '01-retry-lost-ack', 'disk-before');

function fresh(): State {
  const sceneFile = JSON.parse(readFileSync(join(DIR, 'scenes', 'scene-main.json'), 'utf8')) as { scene: unknown };
  const contentFile = JSON.parse(readFileSync(join(DIR, 'content.json'), 'utf8')) as { revision: number; content: unknown };
  const scene = validateSceneV4(sceneFile.scene);
  const content = validateContentV4(contentFile.content);
  if (!scene.ok || !content.ok) throw new Error('fixture invalid');
  return createCommandState({ ...scene.normalized, revision: Math.max(scene.normalized.revision, contentFile.revision) }, content.normalized as unknown as ContentDocument) as State;
}
let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { ok: boolean; state: State; result: Any } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: 'demo-0003', expectedRevision: state.scene.revision, requestId: `req-${(0x23300000 + counter).toString(16).padStart(32, '0')}`, args });
  return { ok: out.ok, state: (out as { state?: State }).state ?? state, result: out.result };
}
function must(state: State, op: string, args: Record<string, unknown>): State {
  const r = run(state, op, args);
  expect(r.ok, `${op}: ${JSON.stringify(r.result)}`).toBe(true);
  return r.state;
}
const layersOf = (s: State): string[] | undefined => (s.content as { collisionLayers?: string[] }).collisionLayers;
const collider = (s: State, id: string): Any => s.scene.entities.find((e: Any) => e.id === id).components.collider;
const BOX = { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 };

describe('collision layers (phase 23.3)', () => {
  it('setCollisionLayers names layers, refuses bad lists, undoes and redoes; empty removes the field', () => {
    let s = fresh();
    s = must(s, 'setSettings', { settings: { physics_dimension: 3 } });
    s = must(s, 'setCollisionLayers', { layers: ['units', 'props'] });
    expect(layersOf(s)).toEqual(['units', 'props']);
    for (const bad of [['default'], ['a', 'a'], ['9x'], Array.from({ length: 16 }, (_, i) => `l${i}`)]) expect(run(s, 'setCollisionLayers', { layers: bad }).ok, JSON.stringify(bad)).toBe(false);
    expect(run(s, 'setCollisionLayers', { layers: 'units' }).ok).toBe(false);
    expect(run(s, 'setCollisionLayers', { layers: ['units', 'props'] }).result.error.code).toBe('no_change');
    const undone = must(s, 'undo', {});
    expect(layersOf(undone)).toBeUndefined();
    expect(layersOf(must(undone, 'redo', {}))).toEqual(['units', 'props']);
    expect(layersOf(must(s, 'setCollisionLayers', { layers: [] }))).toBeUndefined();
  });

  it('a collider lists default or named layers (3D only); a listed layer cannot be removed', () => {
    let s = fresh();
    // 2D plane: layers are refused.
    const flat = run(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { shape: { type: 'box', hx: 0.5, hy: 0.5 }, layers: ['default'] } });
    expect(flat.ok).toBe(false);
    s = must(s, 'setSettings', { settings: { physics_dimension: 3 } });
    s = must(s, 'setCollisionLayers', { layers: ['units'] });
    const unknown = run(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { shape: BOX, layers: ['props'] } });
    expect(unknown.ok).toBe(false);
    expect(JSON.stringify(unknown.result)).toContain('props');
    s = must(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { shape: BOX, layers: ['default', 'units'] } });
    expect(collider(s, 'group-0001')).toEqual({ shape: BOX, layers: ['default', 'units'] });
    // layers alone edits the field (the shape stays); null removes it.
    s = must(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { layers: ['units'] } });
    expect(collider(s, 'group-0001')).toEqual({ shape: BOX, layers: ['units'] });
    expect(run(s, 'setCollisionLayers', { layers: [] }).ok).toBe(false); // "units" is still listed
    s = must(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { layers: null } });
    expect(collider(s, 'group-0001')).toEqual({ shape: BOX });
    s = must(s, 'setCollisionLayers', { layers: [] });
    expect(run(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { layers: [] } }).ok).toBe(false);
  });

  it('the 3D physics config carries the names and each collider\'s layers; no controller → a world without a character', () => {
    const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    const entities = [
      { id: 'a', components: { transform: T, collider: { shape: BOX } } },
      { id: 'b', components: { transform: T, collider: { shape: BOX, layers: ['units'] } } },
    ];
    const cfg = physics3DConfigOf(entities, { gravity_y: -9.8, max_slope_climb_deg: 45, min_slope_slide_deg: 30 }, { layers: ['units'] })!;
    expect(cfg.layers).toEqual(['units']);
    expect(cfg.noCharacter).toBe(true);
    expect(cfg.statics.map((x) => x.layers)).toEqual([undefined, ['units']]);
    expect(staticColliderOf3D('b', entities[1]!.components)?.layers).toEqual(['units']);
    // Without names the field is absent (older configs stay as they were).
    const plain = physics3DConfigOf([...entities, { id: 'p', components: { transform: T, controller: {} } }], { gravity_y: -9.8, max_slope_climb_deg: 45, min_slope_slide_deg: 30 })!;
    expect('layers' in plain).toBe(false);
    expect('noCharacter' in plain).toBe(false);
  });
});
