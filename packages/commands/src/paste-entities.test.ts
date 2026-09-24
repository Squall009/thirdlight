/**
 * `pasteEntities` (2026-09-24): Duplicate and Copy/Paste as one transaction —
 * new ids, hierarchy kept, internal references remapped, offset in world
 * space only, undo/redo.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m3ContractJson } from './test-fixtures';

interface EnvelopeFixture {
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}
const BEFORE = m3ContractJson<EnvelopeFixture>('commands/scenario.before.json');
type State = CommandState<SceneV3>;
type Ent = { id: string; name?: string; parentId?: string; components: Record<string, any> };

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, any> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x7c100 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: (out as { state?: State }).state ?? state, result: out.result as unknown as Record<string, any> };
}
function ok(state: State, op: string, args: Record<string, unknown>): State {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return r.state;
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content) as unknown as ContentDocument) as unknown as State;
const ents = (s: State) => s.scene.entities as unknown as Ent[];
const T = (x: number) => ({ position: [x, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** A folder with a checkpoint zone, its safe spawn, and a box parented to the zone. */
function withGroup(): State {
  let s = fresh();
  s = ok(s, 'createEntity', { kind: 'folder', name: 'room' });
  const folder = ents(s).at(-1)!.id;
  s = ok(s, 'createEntity', { kind: 'group', name: 'safe', parentId: folder, transform: { position: [10, 1, 0] }, components: { playerSpawn: {} } });
  const spawn = ents(s).at(-1)!.id;
  s = ok(s, 'createEntity', {
    kind: 'group',
    name: 'cp',
    parentId: folder,
    transform: { position: [11, 1, 0] },
    components: { gameZone: { role: 'checkpoint', size: [1, 2], safeSpawnId: spawn, activation: { emissive: '#ffffff', emissiveIntensity: 1, cueAssetId: null } } },
  });
  return s;
}

describe('pasteEntities', () => {
  it('copies a folder subtree with new ids, remaps the safe spawn inside the copy, offsets world positions; one undo', () => {
    // (a v3 scene holds one checkpoint: paste after deleting the original room)
    const g = withGroup();
    const values = ents(g).filter((e) => ['room', 'safe', 'cp'].includes(e.name ?? ''));
    // Deleting the room takes its checkpoint and that checkpoint's safe spawn together.
    const s0 = ok(g, 'deleteEntity', { entityId: values[0]!.id });
    const n0 = ents(s0).length;
    const r = run(s0, 'pasteEntities', { entities: values, offset: [5, 0, 0] });
    expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
    const all = ents(r.state);
    expect(all.length).toBe(n0 + 3);
    const [folder, safe, cp] = all.slice(-3) as [Ent, Ent, Ent];
    expect(folder.components['folder']).toEqual({});
    expect(folder.parentId).toBeUndefined();
    expect(safe.parentId).toBe(folder.id);
    expect(cp.parentId).toBe(folder.id);
    expect(cp.components['gameZone'].safeSpawnId).toBe(safe.id);
    expect(safe.components['transform'].position).toEqual([15, 1, 0]);
    expect(r.result.createdId).toBe(folder.id);
    expect(r.result.change.type).toBe('pasteEntities');

    const undone = ok(r.state, 'undo', {});
    expect(ents(undone).length).toBe(n0);
    const redone = ok(undone, 'redo', {});
    expect(ents(redone).map((e) => e.id)).toEqual(all.map((e) => e.id));
  });

  it('keeps a reference that points outside the copy', () => {
    const g = withGroup();
    const cp = ents(g).find((e) => e.name === 'cp')!;
    const s0 = ok(g, 'deleteEntity', { entityId: cp.id });
    const r = run(s0, 'pasteEntities', { entities: [cp], parentId: null, offset: [1, 0, 0] });
    expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
    const copy = ents(r.state).at(-1)!;
    expect(copy.components['gameZone'].safeSpawnId).toBe(ents(s0).find((e) => e.name === 'safe')!.id);
    expect(copy.parentId).toBeUndefined();
  });

  it('keeps the original parent when parentId is absent, uses the given one otherwise', () => {
    const s0 = withGroup();
    const folder = ents(s0).find((e) => e.name === 'room')!;
    const safe = ents(s0).find((e) => e.name === 'safe')!;
    expect(ents(ok(s0, 'pasteEntities', { entities: [safe] })).at(-1)!.parentId).toBe(folder.id);
    expect(ents(ok(s0, 'pasteEntities', { entities: [safe], parentId: null })).at(-1)!.parentId).toBeUndefined();
  });

  it('refuses a camera, a missing outside parent, duplicate ids and bad args (nothing changes)', () => {
    const s0 = withGroup();
    const cam = ents(s0).find((e) => e.components['camera'] !== undefined)!;
    expect(run(s0, 'pasteEntities', { entities: [cam] }).result.ok).toBe(false);
    const orphan = { id: 'x-1', parentId: 'nope-0001', components: { transform: T(0) } };
    expect(run(s0, 'pasteEntities', { entities: [orphan] }).result.ok).toBe(false);
    const a = { id: 'a', components: { transform: T(0) } };
    expect(run(s0, 'pasteEntities', { entities: [a, a] }).result.ok).toBe(false);
    expect(run(s0, 'pasteEntities', { entities: [] }).result.ok).toBe(false);
    expect(run(s0, 'pasteEntities', { entities: [a], offset: [1, 2] }).result.ok).toBe(false);
    expect(run(s0, 'pasteEntities', { entities: [a], extra: 1 }).result.ok).toBe(false);
    const bad = run(s0, 'pasteEntities', { entities: [{ id: 'b', components: { transform: T(0), box: { size: 'big' } } }] });
    expect(bad.result.ok).toBe(false);
    expect(ents(bad.state).length).toBe(ents(s0).length);
  });

  it('a pasted value may come from another project scene: foreign ids are replaced', () => {
    const s0 = fresh();
    const foreign = [
      { id: 'box-0042', name: 'crate', components: { transform: T(2), box: { size: [1, 1, 1], material: { color: '#aa8844' } } } },
      { id: 'box-0043', name: 'lid', parentId: 'box-0042', components: { transform: T(0), box: { size: [1, 0.1, 1], material: { color: '#aa8844' } } } },
    ];
    const r = run(s0, 'pasteEntities', { entities: foreign });
    expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
    const [crate, lid] = ents(r.state).slice(-2) as [Ent, Ent];
    expect(crate.id).toBe('box-0002');
    expect(lid.parentId).toBe(crate.id);
  });
});
