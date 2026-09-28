/**
 * `pasteEntities` (2026-09-24): Duplicate and Copy/Paste as one transaction —
 * new ids, hierarchy kept, internal references remapped, offset in world
 * space only, undo/redo.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m2EnvelopeV4, m3NeutralJson } from './test-fixtures';

interface EnvelopeFixture {
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}
const BEFORE = m3NeutralJson<EnvelopeFixture>('commands/scenario.before.json');
/**
 * A scene whose entities reference each other: the `Station` group
 * (`group-0001`) holds a box and two models; the `Lantern` model
 * (`model-0001`) carries a behavior whose `target` (an `entityRef`) names the
 * station.
 */
const STATION = m2EnvelopeV4('contracts/commands/prefab-scenario.after.json');
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

/** A root folder `room` holding the Station group (moved in, world position kept). */
function withGroup(): State {
  let s = createCommandState(structuredClone(STATION.scene), structuredClone(STATION.content)) as unknown as State;
  s = ok(s, 'createEntity', { kind: 'folder', name: 'room' });
  const folder = ents(s).at(-1)!.id;
  s = ok(s, 'moveEntities', { entityIds: ['group-0001'], parentId: folder });
  return s;
}
/** The folder and its whole subtree, in document order. */
function roomValues(s: State): Ent[] {
  const room = ents(s).find((e) => e.name === 'room')!;
  const inside = new Set([room.id]);
  for (const e of ents(s)) if (e.parentId !== undefined && inside.has(e.parentId)) inside.add(e.id);
  return ents(s).filter((e) => inside.has(e.id));
}

describe('pasteEntities', () => {
  it('phase 24.7: remaps a trigger\'s scene-transition spawn inside the copy (the deleted exit zone\'s rule)', () => {
    let s = createCommandState(structuredClone(STATION.scene), structuredClone(STATION.content)) as unknown as State;
    s = ok(s, 'createEntity', { kind: 'folder', name: 'room' });
    const folder = ents(s).at(-1)!.id;
    s = ok(s, 'createEntity', { kind: 'group', name: 'Arrival', parentId: folder, transform: T(40), components: { playerSpawn: {} } });
    const spawn = ents(s).at(-1)!.id;
    s = ok(s, 'createEntity', { kind: 'group', name: 'Door', parentId: folder, transform: T(41), components: { trigger: { size: [1, 2], signal: 'door', sceneTransition: { scene: s.scene.sceneId, spawn } } } });
    const values = roomValues(s);
    const r = run(s, 'pasteEntities', { entities: values, offset: [10, 0, 0] });
    expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
    const [, arrival, door] = ents(r.state).slice(-3) as [Ent, Ent, Ent];
    expect(arrival.name).toBe('Arrival');
    expect(arrival.id).not.toBe(spawn);
    expect(door.components['trigger'].sceneTransition).toEqual({ scene: s.scene.sceneId, spawn: arrival.id });
  });

  it('copies a folder subtree with new ids, remaps an internal entity reference, offsets world positions; one undo', () => {
    const g = withGroup();
    const values = roomValues(g);
    expect(values.map((e) => e.id).slice(1)).toEqual(['group-0001', 'box-0001', 'model-0001', 'model-0002']);
    const station = values[1]!;
    const n0 = ents(g).length;
    const r = run(g, 'pasteEntities', { entities: values, offset: [5, 0, 0] });
    expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
    const all = ents(r.state);
    expect(all.length).toBe(n0 + 5);
    const [folder, group, box, lantern, ramp] = all.slice(-5) as [Ent, Ent, Ent, Ent, Ent];
    expect(folder.components['folder']).toEqual({});
    expect(folder.parentId).toBeUndefined();
    expect(new Set([folder.id, group.id, box.id, lantern.id, ramp.id]).size).toBe(5);
    for (const e of [group, box, lantern, ramp]) expect(values.some((v) => v.id === e.id)).toBe(false);
    expect(group.parentId).toBe(folder.id);
    expect(box.parentId).toBe(group.id);
    expect(lantern.parentId).toBe(group.id);
    expect(ramp.parentId).toBe(group.id);
    // The behavior's entityRef named the copied station: it now names the copy.
    expect(lantern.components['behavior'].values.target).toBe(group.id);
    // The group sits in world space (its folder has no transform): offset;
    // its children are local to it: unchanged.
    const p = station.components['transform'].position as number[];
    expect(group.components['transform'].position).toEqual([p[0]! + 5, p[1], p[2]]);
    expect(box.components['transform'].position).toEqual(values[2]!.components['transform'].position);
    expect(r.result.createdId).toBe(folder.id);
    expect(r.result.change.type).toBe('pasteEntities');

    const undone = ok(r.state, 'undo', {});
    expect(ents(undone).length).toBe(n0);
    const redone = ok(undone, 'redo', {});
    expect(ents(redone).map((e) => e.id)).toEqual(all.map((e) => e.id));
  });

  it('keeps a reference that points outside the copy', () => {
    const g = withGroup();
    const lantern = ents(g).find((e) => e.id === 'model-0001')!;
    const r = run(g, 'pasteEntities', { entities: [lantern], parentId: null, offset: [1, 0, 0] });
    expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
    const copy = ents(r.state).at(-1)!;
    expect(copy.id).not.toBe('model-0001');
    expect(copy.components['behavior'].values.target).toBe('group-0001');
    expect(copy.parentId).toBeUndefined();
  });

  it('keeps the original parent when parentId is absent, uses the given one otherwise', () => {
    const s0 = withGroup();
    const box = ents(s0).find((e) => e.id === 'box-0001')!;
    expect(ents(ok(s0, 'pasteEntities', { entities: [box] })).at(-1)!.parentId).toBe('group-0001');
    expect(ents(ok(s0, 'pasteEntities', { entities: [box], parentId: null })).at(-1)!.parentId).toBeUndefined();
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
