/**
 * Phase 15.2: the Scene-view handles against the real descriptor registry
 * and the real command layer, on a neutral v4 fixture (a camera, two lights,
 * two boxes, an empty object):
 *
 * - every handle kind a descriptor names is read from a real component, a
 *   grip is dragged (snapped, inside the field's range), and the value the
 *   handle stores is one `setComponent` the commands accept — and one undo
 *   restores the component exactly;
 * - polygon corners: drag, add on an edge, delete, a concave drag refused;
 * - a collider from a model outline (hull, corner limit) is a valid collider;
 * - instance copies: the buffer edits (move, delete, brush) keep the layout;
 * - `playerSpawn.facing` is v4 data (validated, canonical, removable).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DESCRIPTORS, HANDLE_KINDS, validateContentV4, validateSceneV4, type FieldDescriptor } from '@thirdlight/project-model';
import { applyMutation, createCommandState, type CommandState, type ContentDocument } from '@thirdlight/commands';
import { commitValue, deletePoint, dragGrip, gripsOf, handleShapesOf, insertPoint, maxPolygonCorners, type HandleShape, type P3 } from '@thirdlight/editor/handles';
import { boxFromOutline, convexHull, polygonFromOutline } from '@thirdlight/editor/outline';
import { copyAt, copyCount, spacedPoints, withAddedCopies, withCopy, withoutCopy } from '@thirdlight/editor/instance-copies';

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
  const out = applyMutation(state, { op, projectId: 'demo-0003', expectedRevision: state.scene.revision, requestId: `req-${(0x15200000 + counter).toString(16).padStart(32, '0')}`, args });
  return { ok: out.ok, state: (out as { state?: State }).state ?? state, result: out.result };
}
function must(state: State, op: string, args: Record<string, unknown>, what: string): State {
  const r = run(state, op, args);
  expect(r.ok, `${what}: ${JSON.stringify(r.result)}`).toBe(true);
  return r.state;
}
const entityOf = (s: State, id: string): Any => s.scene.entities.find((e: Any) => e.id === id);
/** The editor's projection of an entity, as far as the handles read it. */
const projected = (s: State, id: string): Any => {
  const e = entityOf(s, id);
  const t = e.components.transform;
  return { id, name: id, parentId: null, kind: 'entity', active: true, locked: false, static: false, tags: 0, position: t.position, rotation: t.rotation, scale: t.scale, components: e.components };
};
const p3 = (x: number, y: number, z = 0): P3 => ({ x, y, z });

/** Read the shape of `kind` on `component`, drag `grip` to `to`, store it; check `stored` and that one undo restores the component. */
function dragAndStore(s: State, id: string, component: string, kind: string, grip: string, to: P3, snap: boolean, stored: (v: Any) => void): State {
  const shape = handleShapesOf(projected(s, id), DESCRIPTORS).find((x) => x.component === component && x.kind === kind);
  expect(shape, `${component} ${kind} shape`).toBeDefined();
  expect(gripsOf(shape!).map((g) => g.id)).toContain(grip);
  const moved = dragGrip(shape!, grip, to, snap);
  const edit = commitValue(moved);
  expect(edit, `${component} ${kind} commit`).not.toBeNull();
  expect(edit!.ok, JSON.stringify(edit)).toBe(true);
  const before = JSON.parse(JSON.stringify(entityOf(s, id).components[component]));
  const after = must(s, 'setComponent', { entityId: id, component, value: (edit as Any).value }, `${component} ${kind} ${grip}`);
  stored(entityOf(after, id).components[component]);
  const undone = must(after, 'undo', {}, `undo ${component} ${kind}`);
  expect(entityOf(undone, id).components[component]).toEqual(before);
  return after;
}

describe('the Scene-view handles over the real registry and commands', () => {
  it('every descriptor handle binds fields that exist; `point` is defined but no field uses it yet', () => {
    const used = new Set(DESCRIPTORS.components.flatMap((c) => c.handles.map((h) => h.kind)));
    for (const k of HANDLE_KINDS) if (k !== 'point') expect(used, k).toContain(k);
    expect(used.has('point')).toBe(false);
  });

  it('box3 (a box mesh), box2 (areas; an enemy stands on its feet; a collider\'s half extents) and bounds', () => {
    let s = fresh();
    // box3: the box's width from its side grip (the frame is its whole transform).
    s = dragAndStore(s, 'box-0001', 'box', 'box3', 'side', p3(1.26, 0, 0), true, (v) => expect(v.size).toEqual([2.5, 1, 1]));
    s = dragAndStore(s, 'box-0001', 'box', 'box3', 'depth', p3(0, 0, 0.9), true, (v) => expect(v.size).toEqual([2.5, 1, 1.8]));
    // box2 sizes: a trigger grows around its centre; an enemy's top moves with its feet kept.
    s = must(s, 'createEntity', { parentId: null, kind: 'group', name: 'Sensor', transform: { position: [4, 1, 0] }, components: { trigger: { size: [1, 1], signal: 'hello' } } }, 'sensor');
    const sensor = s.scene.entities.at(-1).id;
    s = dragAndStore(s, sensor, 'trigger', 'box2', 'top', p3(0, 0.83), true, (v) => expect(v.size).toEqual([1, 1.65]));
    s = must(s, 'createEntity', { parentId: null, kind: 'group', name: 'Walker', transform: { position: [8, 0, 0] }, components: { enemy: { patrol: 'points', range: [-2, 2], speed: 1.5, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1, chase: 3 } } }, 'walker');
    const walker = s.scene.entities.at(-1).id;
    const enemyBox = handleShapesOf(projected(s, walker), DESCRIPTORS).find((x) => x.component === 'enemy' && x.kind === 'box2')!;
    expect(gripsOf(enemyBox).find((g) => g.id === 'top')!.at).toEqual(p3(0, 0.8, 0));
    s = dragAndStore(s, walker, 'enemy', 'box2', 'top', p3(0, 1.21), true, (v) => expect(v.size).toEqual([0.8, 1.2]));
    // segment1d: the patrol range's right end; radius along X: the chase distance (a band).
    s = dragAndStore(s, walker, 'enemy', 'segment1d', 'right', p3(3.52, 0.4), true, (v) => expect(v.range).toEqual([-2, 3.5]));
    s = dragAndStore(s, walker, 'enemy', 'radius', 'side', p3(-4.52, 3), true, (v) => expect(v.chase).toBe(4.5));
    // The left end never passes the right one.
    const range = handleShapesOf(projected(s, walker), DESCRIPTORS).find((x) => x.kind === 'segment1d')!;
    expect((commitValue(dragGrip(range, 'left', p3(9, 0), true)) as Any).value.range).toEqual([3.45, 3.5]);
    // Half extents (a box collider turned with its object).
    s = must(s, 'createEntity', { parentId: null, kind: 'group', name: 'Ledge', transform: { position: [0, -2, 0] }, components: { collider: { shape: { type: 'box', hx: 1, hy: 0.25 } } } }, 'ledge');
    const ledge = s.scene.entities.at(-1).id;
    const colBox = handleShapesOf(projected(s, ledge), DESCRIPTORS).find((x) => x.kind === 'box2')!;
    expect(colBox.frame).toBe('rotationZ');
    s = dragAndStore(s, ledge, 'collider', 'box2', 'side', p3(1.5, 0.1), true, (v) => expect(v.shape).toEqual({ type: 'box', hx: 1.5, hy: 0.25 }));
    // World bounds of camera follow.
    s = must(s, 'setComponent', { entityId: 'cam-main', component: 'cameraFollow', value: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, bounds: { minX: -10, maxX: 10, minY: -5, maxY: 5 } } }, 'follow');
    const bounds = handleShapesOf(projected(s, 'cam-main'), DESCRIPTORS).find((x) => x.component === 'cameraFollow')!;
    expect(bounds.frame).toBe('world');
    expect(gripsOf(bounds).map((g) => g.id)).toEqual(['left', 'right', 'bottom', 'top']);
    dragAndStore(s, 'cam-main', 'cameraFollow', 'box2', 'right', p3(14.1, 0), true, (v) => expect(v.bounds).toEqual({ minX: -10, maxX: 14, minY: -5, maxY: 5 }));
  });

  it('capsule: the top grip keeps the feet; the offset is stored only when it is not zero', () => {
    let s = fresh();
    s = must(s, 'setComponent', { entityId: 'group-0001', component: 'controller', value: {} }, 'controller');
    const cap = handleShapesOf(projected(s, 'group-0001'), DESCRIPTORS).find((x) => x.kind === 'capsule')!;
    expect(gripsOf(cap).map((g) => [g.id, g.at])).toEqual([['top', p3(0, 0.9)], ['side', p3(0.3, 0)]]);
    s = dragAndStore(s, 'group-0001', 'controller', 'capsule', 'top', p3(0, 0.12), true, (v) => expect(v.capsule).toEqual({ radius: 0.3, height: 1, offset: [0, -0.4] }));
    dragAndStore(s, 'group-0001', 'controller', 'capsule', 'side', p3(0.52, 0), true, (v) => expect(v.capsule).toEqual({ radius: 0.5, height: 1, offset: [0, -0.4] }));
  });

  it('lights: a directional light\'s direction, a spot cone (direction, range, half-angle), a point light\'s range', () => {
    let s = fresh();
    // direction (world): the tip grip points the light.
    s = dragAndStore(s, 'light-0001', 'light', 'direction', 'tip', p3(1, -1, 0), true, (v) => expect(v.direction).toEqual([0.7, -0.7, 0]));
    // A spot light and a point light.
    s = must(s, 'createEntity', { parentId: null, kind: 'group', name: 'Spot', transform: { position: [0, 4, 0] }, components: { light: { type: 'spot', color: '#ffffff', intensity: 80, range: 6, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -1, 0] } } }, 'spot');
    const spot = s.scene.entities.at(-1).id;
    const cone = handleShapesOf(projected(s, spot), DESCRIPTORS).find((x) => x.kind === 'cone')!;
    expect(cone.frame).toBe('rotation');
    expect(gripsOf(cone).map((g) => g.id)).toEqual(['tip', 'angle']);
    s = dragAndStore(s, spot, 'light', 'cone', 'tip', p3(3, -3.9, 0), true, (v) => {
      expect(v.range).toBe(4.9);
      expect(v.direction).toEqual([0.6, -0.8, 0]);
    });
    // The angle grip: 2.45 m off the axis at the cone's 4.9 m end (its perpendicular is +Z here) is atan(0.5) = 26.6°, snapped to 25°.
    s = dragAndStore(s, spot, 'light', 'cone', 'angle', p3(2.94, -3.92, 2.45), true, (v) => expect(v.angle).toBe(25));
    s = must(s, 'createEntity', { parentId: null, kind: 'group', name: 'Lamp', transform: { position: [2, 2, 0] }, components: { light: { type: 'point', color: '#ffd9a0', intensity: 30, range: 8, decay: 2 } } }, 'lamp');
    const lamp = s.scene.entities.at(-1).id;
    dragAndStore(s, lamp, 'light', 'radius', 'side', p3(3, 4, 0), true, (v) => expect(v.range).toBe(5));
  });

  it('path: a mover waypoint drags on the grid; a point is inserted on a segment and deleted again', () => {
    let s = fresh();
    s = must(s, 'setComponent', { entityId: 'box-0001', component: 'mover', value: { waypoints: [[4, 0, 0]], speed: 2, mode: 'pingpong', wait: 0.5 } }, 'mover');
    s = dragAndStore(s, 'box-0001', 'mover', 'path', 'p0', p3(3.1, 1.9), true, (v) => expect(v.waypoints).toEqual([[3, 2, 0]]));
    const path = handleShapesOf(projected(s, 'box-0001'), DESCRIPTORS).find((x) => x.kind === 'path')!;
    const made = insertPoint(path, 'i1');
    expect(made).toBeNull(); // a pingpong path has no closing segment
    const added = insertPoint(path, 'i0')!;
    expect(added.grip).toBe('p0');
    const edit = commitValue(dragGrip(added.shape, 'p0', p3(0, 3), true)) as Any;
    expect(edit.value.waypoints).toEqual([[0, 3, 0], [3, 2, 0]]);
    s = must(s, 'setComponent', { entityId: 'box-0001', component: 'mover', value: edit.value }, 'insert');
    const two = handleShapesOf(projected(s, 'box-0001'), DESCRIPTORS).find((x) => x.kind === 'path')!;
    const del = deletePoint(two, 'p0');
    expect(del.ok).toBe(true);
    expect((commitValue((del as Any).shape) as Any).value.waypoints).toEqual([[3, 2, 0]]);
    expect(deletePoint((del as Any).shape, 'p0')).toEqual({ ok: false, message: 'Waypoints keeps at least 1 point' });
  });

  it('polygon: corners drag, add on an edge, delete; a concave or inside-out shape is refused before any command', () => {
    let s = fresh();
    s = must(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { shape: { type: 'polygon', vertices: [[-1, 0], [1, 0], [0, 1]] } } }, 'polygon');
    const poly = (): HandleShape => handleShapesOf(projected(s, 'group-0001'), DESCRIPTORS).find((x) => x.kind === 'polygon')!;
    expect(gripsOf(poly()).map((g) => g.id)).toEqual(['p0', 'p1', 'p2', 'i1', 'i2', 'i3']);
    s = dragAndStore(s, 'group-0001', 'collider', 'polygon', 'p2', p3(0.02, 1.52), true, (v) => expect(v.shape.vertices).toEqual([[-1, 0], [1, 0], [0, 1.5]]));
    // Add a corner on the edge p1→p2 and pull it out (still convex).
    const added = insertPoint(poly(), 'i2')!;
    const out = commitValue(dragGrip(added.shape, added.grip, p3(0.8, 1), true)) as Any;
    expect(out.value.shape.vertices).toEqual([[-1, 0], [1, 0], [0.8, 1], [0, 1.5]]);
    s = must(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: out.value }, 'insert corner');
    // Pulling it inside makes the shape concave: refused locally.
    const concave = dragGrip(poly(), 'p2', p3(0.2, 0.5), true);
    expect(concave.error).toBe('a polygon collider must stay convex');
    expect(commitValue(concave)).toEqual({ ok: false, message: 'a polygon collider must stay convex' });
    // Dragged across to the other side: inside out.
    expect(dragGrip(poly(), 'p3', p3(0, -3), true).error).toMatch(/counter-clockwise|convex/);
    // Delete a corner (back to a triangle), and a triangle keeps its three.
    const del = deletePoint(poly(), 'p2');
    expect(del.ok).toBe(true);
    s = must(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: (commitValue((del as Any).shape) as Any).value }, 'delete corner');
    expect(entityOf(s, 'group-0001').components.collider.shape.vertices).toEqual([[-1, 0], [1, 0], [0, 1.5]]);
    expect(deletePoint(poly(), 'p0')).toEqual({ ok: false, message: 'Polygon keeps at least 3 points' });
    // The corner limit comes from the registry.
    expect(maxPolygonCorners(DESCRIPTORS)).toBe(8);
  });

  it('box and polygon colliders from a model outline are valid colliders', () => {
    // A lumpy round outline, off the origin: the hull, at most 8 corners.
    const pts = Array.from({ length: 400 }, (_, i) => {
      const a = (i / 400) * Math.PI * 2;
      const r = 1 + 0.1 * Math.sin(7 * a);
      return { x: 0.5 + r * Math.cos(a), y: 1 + r * Math.sin(a) };
    });
    expect(convexHull(pts).length).toBeGreaterThan(8);
    const poly = polygonFromOutline(pts, maxPolygonCorners(DESCRIPTORS));
    expect(poly.ok).toBe(true);
    const shape = (poly as Any).shape;
    expect(shape.vertices.length).toBeLessThanOrEqual(8);
    let s = fresh();
    s = must(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { shape } }, 'outline polygon');
    // Off-centre: a box collider cannot be offset, so the rectangle is a 4-corner polygon (with a note).
    const box = boxFromOutline(pts);
    expect((box as Any).shape.type).toBe('polygon');
    expect((box as Any).note).toMatch(/not centred/);
    must(s, 'setComponent', { entityId: 'group-0001', component: 'collider', value: { shape: (box as Any).shape } }, 'outline box as polygon');
    // Centred: a box.
    expect(boxFromOutline([{ x: -0.4, y: -1 }, { x: 0.4, y: 1 }, { x: 0, y: 0 }])).toEqual({ ok: true, shape: { type: 'box', hx: 0.4, hy: 1 } });
    expect(polygonFromOutline([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], 8).ok).toBe(false); // a line has no area
  });

  it('instance copies: move one, delete one, paint new ones — the rest stay as they were', () => {
    const floats = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect(copyCount(floats)).toBe(2);
    const moved = withCopy(floats, 1, { position: [3, 1, 0], rotation: [0, 0.5, 0, 0.8660254], scale: [2, 2, 2] });
    expect(copyAt(moved, 0)).toEqual(copyAt(floats, 0));
    expect(copyAt(moved, 1)!.position).toEqual([3, 1, 0]);
    expect(Array.from(floats.slice(10, 13))).toEqual([2, 0, 0]); // the original is not touched
    const fewer = withoutCopy(moved, 0)!;
    expect(copyCount(fewer)).toBe(1);
    expect(copyAt(fewer, 0)!.position).toEqual([3, 1, 0]);
    expect(withoutCopy(fewer, 0)).toBeNull(); // a set keeps one copy
    const painted = withAddedCopies(fewer, spacedPoints([[0, 0, 0], [0.3, 0, 0], [1.2, 0, 0], [2.5, 0, 0]]));
    expect(copyCount(painted)).toBe(4);
    expect(copyAt(painted, 3)).toEqual({ position: [2.5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  });

  it('playerSpawn.facing: v4 data — stored, removed with null, a wrong value refused; the descriptor offers none/left/right', () => {
    let s = fresh();
    s = must(s, 'createEntity', { parentId: null, kind: 'group', name: 'Start', transform: { position: [0, 1, 0] }, components: { playerSpawn: { facing: 'left' } } }, 'spawn');
    const id = s.scene.entities.at(-1).id;
    expect(entityOf(s, id).components.playerSpawn).toEqual({ facing: 'left' });
    s = must(s, 'setComponent', { entityId: id, component: 'playerSpawn', value: { facing: 'right' } }, 'right');
    expect(entityOf(s, id).components.playerSpawn).toEqual({ facing: 'right' });
    expect(run(s, 'setComponent', { entityId: id, component: 'playerSpawn', value: { facing: 'up' } }).ok).toBe(false);
    expect(run(s, 'setComponent', { entityId: id, component: 'playerSpawn', value: { color: 'red' } }).ok).toBe(false);
    s = must(s, 'setComponent', { entityId: id, component: 'playerSpawn', value: { facing: null } }, 'none');
    expect(entityOf(s, id).components.playerSpawn).toEqual({});
    s = must(s, 'undo', {}, 'undo');
    expect(entityOf(s, id).components.playerSpawn).toEqual({ facing: 'right' });
    const facing = (DESCRIPTORS.components.find((c) => c.name === 'playerSpawn')!.value as Any).fields.find((f: FieldDescriptor) => f.key === 'facing');
    expect(facing.options.map((o: Any) => o.value)).toEqual(['none', 'left', 'right']);
    expect(facing.default).toBe('none');
  });
});
