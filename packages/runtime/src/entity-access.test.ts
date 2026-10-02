/**
 * `EntityAccess` on its own — the switched-off set with
 * children, a new run, the save record, a conflict with an owned transform
 * intent, the per-step limit, objects that leave.
 */
import { describe, expect, it } from 'vitest';
import type { EntityV3 } from '@thirdlight/project-model';

import { EntityAccess, MAX_ENTITY_WRITES_PER_STEP, type EntityAccessHost } from './entity-access';
import { RuntimeMaterials } from './material-params';
import type { DiagnosticErrorEntry, TransformState } from './types';

const T = (x: number, y: number) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const ent = (id: string, components: Record<string, unknown>, parentId?: string, extra: Record<string, unknown> = {}): EntityV3 =>
  ({ id, ...(parentId !== undefined ? { parentId } : {}), ...extra, components: { transform: T(0, 0), ...components } }) as unknown as EntityV3;

function harness(entities: EntityV3[]) {
  const docs = new Map(entities.map((e) => [e.id, e]));
  const curr = new Map<string, TransformState>(entities.map((e) => [e.id, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }]));
  const hidden = new Set<string>();
  const movers = new Map<string, { speed: number; active: boolean }>();
  for (const e of entities) {
    const m = (e.components as { mover?: { speed: number } }).mover;
    if (m !== undefined) movers.set(e.id, { speed: m.speed, active: true });
  }
  const records: DiagnosticErrorEntry[] = [];
  const changes: { off: string[]; on: string[] }[] = [];
  let step = 0;
  let intentWrote = new Set<string>();
  const host: EntityAccessHost = {
    doc: (id) => docs.get(id),
    stepStartTransform: (id) => curr.get(id),
    curr,
    order: () => [...docs.keys()],
    parentOf: (id) => docs.get(id)?.parentId,
    controllerId: 'player',
    isKept: () => false,
    keepProblem: () => null,
    setKept: () => undefined,
    isPhysicsBody: (id) => id === 'player' || (docs.get(id)?.components as { collider?: unknown } | undefined)?.collider !== undefined,
    transformIntentWrote: (id) => intentWrote.has(id),
    hiddenAtStepStart: (id) => hidden.has(id),
    setVisible: (id, v) => void (v ? hidden.delete(id) : hidden.add(id)),
    moverState: (id) => movers.get(id) ?? null,
    setMover: (id, p) => void Object.assign(movers.get(id)!, p),
    materials: new RuntimeMaterials(undefined),
    inactiveChanged: (off, on) => void changes.push({ off: [...off], on: [...on] }),
    record: (e) => void records.push(e),
    stepIndex: () => step,
  };
  const access = new EntityAccess(host);
  const h = (id: string) => access.control.handle('script "s" on "x"', id)!;
  return {
    access,
    h,
    curr,
    hidden,
    movers,
    records,
    changes,
    docs,
    next(): void {
      access.applyQueued();
      step += 1;
      intentWrote = new Set();
    },
    intent(id: string): void {
      intentWrote.add(id);
    },
  };
}

describe('EntityAccess', () => {
  it('switching a parent off takes its children along; switching it on brings them back (a child switched off itself stays off)', () => {
    const t = harness([ent('cam', { virtualCamera: { rig: 'fixed' } }), ent('player', { controller: {} }), ent('group', {}), ent('a', {}, 'group'), ent('b', {}, 'a'), ent('c', {})]);
    expect(t.h('b').set('object', { active: false }).ok).toBe(true);
    t.next();
    expect([...t.access.inactive()]).toEqual(['b']);
    expect(t.h('group').set('object', { active: false }).ok).toBe(true);
    t.next();
    expect([...t.access.inactive()].sort()).toEqual(['a', 'b', 'group']);
    expect(t.changes.at(-1)).toEqual({ off: ['group', 'a'], on: [] });
    t.h('group').set('object', { active: true });
    t.next();
    expect([...t.access.inactive()]).toEqual(['b']);
    expect(t.changes.at(-1)).toEqual({ off: [], on: ['group', 'a'] });
    // The object's own flag is what `get` reports (a child under a switched-off parent reads its own).
    expect(t.h('b').get('object')).toMatchObject({ active: false, visible: true });
    // A parent of the character stays on; a camera is a shot like any object (switching it off takes it out of the view).
    const withRig = harness([ent('rig', {}), ent('cam', { virtualCamera: { rig: 'fixed' } }, 'rig'), ent('body', {}), ent('player', { controller: {} }, 'body')]);
    expect(withRig.h('rig').set('object', { active: false }).ok).toBe(true);
    expect(withRig.h('body').set('object', { active: false })).toMatchObject({ ok: false, code: 'entity_character', field: 'object.active' });
  });

  it('a static object is fixed; a baked light too', () => {
    const t = harness([ent('wall', {}, undefined, { static: true }), ent('sun', { light: { type: 'point', color: '#ffffff', intensity: 3, mode: 'baked' } })]);
    expect(t.h('wall').set('object', { visible: false })).toMatchObject({ ok: false, code: 'entity_static' });
    expect(t.h('wall').set('transform', { position: [1, 0, 0] })).toMatchObject({ ok: false, code: 'entity_static' });
    expect(t.h('sun').set('light', { intensity: 1 })).toMatchObject({ ok: false, code: 'entity_static', field: 'light.intensity' });
  });

  it('a transform an owned intent also wrote this step: the write wins and the conflict is reported', () => {
    const t = harness([ent('box', {})]);
    t.h('box').set('transform', { position: [4, 5, 6] });
    t.intent('box');
    t.next();
    expect(t.curr.get('box')!.position).toEqual([4, 5, 6]);
    expect(t.records).toMatchObject([{ code: 'entity_write', reason: 'conflict', detail: 'transform.position' }]);
    expect(t.access.conflicts).toBe(1);
  });

  it('a refusal is noted once per step, script and field; the write limit per step', () => {
    const t = harness([ent('lamp', { light: { type: 'point', color: '#ffffff', intensity: 3 } })]);
    for (let i = 0; i < 3; i++) t.h('lamp').set('light', { type: 'spot' });
    expect(t.records.length).toBe(1);
    expect(t.access.refused).toBe(3);
    for (let i = 0; i < MAX_ENTITY_WRITES_PER_STEP; i++) expect(t.h('lamp').set('light', { intensity: 1 }).ok).toBe(true);
    expect(t.h('lamp').set('light', { intensity: 2 })).toMatchObject({ ok: false, code: 'write_limit' });
    t.next();
    expect(t.h('lamp').set('light', { intensity: 2 }).ok).toBe(true);
  });

  it('a new run puts every written field back; the save record restores them', () => {
    const t = harness([ent('lamp', { light: { type: 'point', color: '#ffffff', intensity: 3, range: 2 } }), ent('lift', { mover: { waypoints: [[1, 0, 0]], speed: 2, mode: 'loop' } }), ent('box', {})]);
    t.h('lamp').set('light', { intensity: 9 });
    t.h('lift').set('mover', { speed: 5, active: false });
    t.h('box').set('object', { active: false, visible: false });
    t.next();
    const saved = t.access.saveState();
    expect(saved).toEqual({ box: { active: false, visible: false }, lamp: { light: { intensity: 9 } }, lift: { mover: { speed: 5, active: false } } });
    expect(t.access.digestText()).not.toBeNull();
    expect(t.access.checkState(saved)).toBeNull();
    expect(t.access.checkState({ lamp: { light: { type: 'spot' } } })).toMatch(/light\.type is fixed/);
    expect(t.access.checkState({ gone: { active: false } })).toMatch(/not in this game/);
    t.access.reset();
    expect(t.access.lightOverrides().size).toBe(0);
    expect(t.access.inactive().size).toBe(0);
    expect(t.access.digestText()).toBeNull();
    t.access.restoreState(saved);
    expect(t.access.lightOverrides().get('lamp')).toEqual({ intensity: 9 });
    expect([...t.access.inactive()]).toEqual(['box']);
    expect(t.hidden.has('box')).toBe(true);
    expect(t.movers.get('lift')).toEqual({ speed: 5, active: false });
  });

  it('objects that leave take their writes along', () => {
    const t = harness([ent('lamp', { light: { type: 'point', color: '#ffffff', intensity: 3 } }), ent('box', {})]);
    t.h('lamp').set('light', { intensity: 9 });
    t.h('box').set('object', { active: false });
    t.next();
    t.access.removed(new Set(['lamp', 'box']));
    expect(t.access.lightOverrides().size).toBe(0);
    expect(t.access.inactive().size).toBe(0);
  });
});
