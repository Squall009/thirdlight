/**
 * Packet 28 — declared-property control model (Node; vitest).
 *
 * The controls are derived **only** from published declaration data; these
 * tests pin the contract's seven-type vocabulary, defaults, ranges and the
 * bounded invalid-input errors, plus the one typed `setBehaviorProperties`
 * command path (which must send the whole declared values map).
 */
import { describe, expect, it } from 'vitest';
import type { PropertyDeclaration } from '@thirdlight/project-model';
import {
  COMPONENT_EDIT_AVAILABLE,
  deriveBehaviorControls,
  deriveComponentControls,
  derivePropertyControls,
  parseColliderBox,
  parseColliderPolygon,
  parseControlInput,
  planAddController,
  planRemoveBehaviorProperties,
  planRemovePhysicsComponent,
  planSetBehaviorProperties,
  planSetCollider,
  validatePropertyValue,
} from './property-controls';

/** The accepted packet-16 fixture declaration ("Lantern Glow"). */
const DECLARATION: PropertyDeclaration = {
  properties: [
    { key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 },
    { key: 'label', label: 'Label', type: 'string', default: 'Lantern', maxLength: 64 },
    { key: 'visible', label: 'Visible', type: 'boolean', default: true },
    { key: 'offset', label: 'Offset', type: 'vec3', default: [0, 0.5, 0], bounds: { min: [-1000, -1000, -1000], max: [1000, 1000, 1000] } },
    { key: 'mode', label: 'Mode', type: 'enum', default: 'idle', values: ['idle', 'run', 'jump'] },
    { key: 'target', label: 'Target', type: 'entityRef', default: null },
    { key: 'material', label: 'Material', type: 'assetRef', default: 'asset-7f3a2c9e1b4d5068' },
  ],
};

/** The stored values of the accepted `prefab-scenario.after.json` lantern. */
const STORED = {
  speed: 4.5,
  label: 'Lantern',
  visible: true,
  offset: [0, 0.5, 0],
  mode: 'run',
  target: 'group-0001',
  material: 'asset-7f3a2c9e1b4d5068',
};

describe('packet 28 — schema-driven property controls (defaults/types/ranges)', () => {
  it('derives one control per declared property, in declaration order', () => {
    const controls = derivePropertyControls(DECLARATION, STORED);
    expect(controls.map((c) => c.key)).toEqual(['speed', 'label', 'visible', 'offset', 'mode', 'target', 'material']);
    expect(controls.map((c) => c.type)).toEqual(['number', 'string', 'boolean', 'vec3', 'enum', 'entityRef', 'assetRef']);
    expect(controls.map((c) => c.label)).toEqual(['Speed', 'Label', 'Visible', 'Offset', 'Mode', 'Target', 'Material']);
  });

  it('exposes the declaration default and every declared constraint', () => {
    const byKey = new Map(derivePropertyControls(DECLARATION, STORED).map((c) => [c.key, c]));
    expect(byKey.get('speed')?.default).toBe(3.5);
    expect(byKey.get('speed')?.current).toBe(4.5);
    expect(byKey.get('speed')?.modified).toBe(true);
    expect(byKey.get('speed')?.constraints).toEqual({ min: -1000, max: 1000, step: 0.25 });
    expect(byKey.get('label')?.constraints.maxLength).toBe(64);
    expect(byKey.get('mode')?.constraints.values).toEqual(['idle', 'run', 'jump']);
    expect(byKey.get('offset')?.constraints.bounds).toEqual({ min: [-1000, -1000, -1000], max: [1000, 1000, 1000] });
    expect(byKey.get('target')?.default).toBeNull();
    expect(byKey.get('speed')?.constraintText).toContain('number');
    expect(byKey.get('speed')?.constraintText).toContain('default 3.5');
    expect(byKey.get('mode')?.constraintText).toContain('one of: idle, run, jump');
  });

  it('falls back to the declaration default for absent keys (defaults are materialized)', () => {
    const controls = derivePropertyControls(DECLARATION, {});
    expect(controls.map((c) => c.current)).toEqual([3.5, 'Lantern', true, [0, 0.5, 0], 'idle', null, 'asset-7f3a2c9e1b4d5068']);
    expect(controls.every((c) => c.modified === false)).toBe(true);
  });

  it('surfaces a bounded error when a stored value violates its declaration', () => {
    const controls = derivePropertyControls(DECLARATION, { ...STORED, speed: 5000, visible: 'yes', offset: [0, 0], material: 'not an id!' });
    const byKey = new Map(controls.map((c) => [c.key, c]));
    expect(byKey.get('speed')?.error?.code).toBe('property_value');
    expect(byKey.get('visible')?.error?.code).toBe('property_type');
    expect(byKey.get('offset')?.error?.code).toBe('property_type');
    expect(byKey.get('material')?.error?.code).toBe('property_type');
    expect(byKey.get('label')?.error).toBeNull();
  });

  it('validates the seven types directly (no coercion, no evaluation)', () => {
    const prop = (over: Partial<PropertyDeclaration['properties'][number]>) =>
      ({ key: 'p', label: 'P', type: 'number', default: 1, ...over }) as PropertyDeclaration['properties'][number];
    expect(validatePropertyValue(prop({ type: 'number', min: 0, max: 10 }), 10)).toBeNull();
    expect(validatePropertyValue(prop({ type: 'number', min: 0, max: 10 }), 11)?.code).toBe('property_value');
    expect(validatePropertyValue(prop({ type: 'boolean' }), false)).toBeNull();
    expect(validatePropertyValue(prop({ type: 'string', maxLength: 2 }), 'abc')?.code).toBe('property_value');
    expect(validatePropertyValue(prop({ type: 'string', maxLength: 4 }), 'a\u0000b')?.code).toBe('property_value');
    expect(validatePropertyValue(prop({ type: 'enum', values: ['a'] }), 'b')?.code).toBe('property_value');
    expect(validatePropertyValue(prop({ type: 'vec3', bounds: { min: [0, 0, 0], max: [1, 1, 1] } }), [0.5, 0.5, 2])?.code).toBe('property_value');
    expect(validatePropertyValue(prop({ type: 'entityRef' }), null)).toBeNull();
    expect(validatePropertyValue(prop({ type: 'assetRef' }), 'Bad Id')?.code).toBe('property_type');
  });
});

describe('packet 28 — invalid numeric/reference input is rejected with an actionable error', () => {
  const controls = new Map(derivePropertyControls(DECLARATION, STORED).map((c) => [c.key, c]));
  const control = (key: string) => controls.get(key)!;

  it('parses a valid value of each type', () => {
    expect(parseControlInput(control('speed'), '9.75')).toEqual({ ok: true, value: 9.75 });
    expect(parseControlInput(control('visible'), 'true')).toEqual({ ok: true, value: true });
    expect(parseControlInput(control('label'), 'Lantern')).toEqual({ ok: true, value: 'Lantern' });
    expect(parseControlInput(control('mode'), 'jump')).toEqual({ ok: true, value: 'jump' });
    expect(parseControlInput(control('offset'), '1, 2, 3')).toEqual({ ok: true, value: [1, 2, 3] });
    expect(parseControlInput(control('target'), '')).toEqual({ ok: true, value: null });
    expect(parseControlInput(control('target'), 'group-0001', { entityIds: ['group-0001'] })).toEqual({ ok: true, value: 'group-0001' });
  });

  it('rejects invalid numeric input with range/bounds context', () => {
    expect(parseControlInput(control('speed'), '')).toMatchObject({ ok: false, error: { code: 'property_type' } });
    expect(parseControlInput(control('speed'), 'abc')).toMatchObject({ ok: false, error: { code: 'property_type' } });
    expect(parseControlInput(control('speed'), 'Infinity')).toMatchObject({ ok: false, error: { code: 'property_type' } });
    const range = parseControlInput(control('speed'), '5000');
    expect(range.ok).toBe(false);
    if (!range.ok) {
      expect(range.error.code).toBe('property_value');
      expect(range.error.message).toContain('<= 1000');
    }
    expect(parseControlInput(control('offset'), '1, 2')).toMatchObject({ ok: false, error: { code: 'property_type' } });
    expect(parseControlInput(control('offset'), '1, 2, 2000')).toMatchObject({ ok: false, error: { code: 'property_value' } });
  });

  it('rejects invalid boolean/enum/string input', () => {
    expect(parseControlInput(control('visible'), 'maybe')).toMatchObject({ ok: false, error: { code: 'property_type' } });
    expect(parseControlInput(control('mode'), 'fly')).toMatchObject({ ok: false, error: { code: 'property_value' } });
    expect(parseControlInput(control('label'), 'x'.repeat(65))).toMatchObject({ ok: false, error: { code: 'property_value' } });
  });

  it('rejects invalid or unresolved reference input', () => {
    expect(parseControlInput(control('target'), 'Not An Id')).toMatchObject({ ok: false, error: { code: 'property_type' } });
    expect(parseControlInput(control('target'), 'group-9999', { entityIds: ['group-0001'] })).toMatchObject({
      ok: false,
      error: { code: 'reference_missing' },
    });
    expect(parseControlInput(control('material'), 'asset-0000000000000000', { assetIds: ['asset-7f3a2c9e1b4d5068'] })).toMatchObject({
      ok: false,
      error: { code: 'asset_reference_missing' },
    });
  });
});

describe('packet 28 — one property edit is one typed setBehaviorProperties command', () => {
  it('sends the whole declared values map so other properties are preserved', () => {
    const plan = planSetBehaviorProperties('model-0003', 'behavior-0001', DECLARATION, STORED, 'speed', 1.25);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.args.entityId).toBe('model-0003');
    expect(plan.args.behaviorId).toBe('behavior-0001');
    // Every declared key is present (omitted keys take their declaration
    // default on the backend, so a partial map would reset them).
    expect(Object.keys(plan.args.values ?? {})).toEqual(DECLARATION.properties.map((p) => p.key));
    expect(plan.args.values).toMatchObject({ speed: 1.25, label: 'Lantern', target: 'group-0001', mode: 'run' });
  });

  it('fills untouched absent keys from the declaration default', () => {
    const plan = planSetBehaviorProperties('model-0003', 'behavior-0001', DECLARATION, {}, 'speed', 2);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.args.values).toMatchObject({ speed: 2, label: 'Lantern', visible: true, offset: [0, 0.5, 0], mode: 'idle', target: null });
  });

  it('rejects an undeclared key and an invalid value', () => {
    expect(planSetBehaviorProperties('model-0003', 'behavior-0001', DECLARATION, STORED, 'nope', 1)).toMatchObject({
      ok: false,
      error: { code: 'property_unknown' },
    });
    expect(planSetBehaviorProperties('model-0003', 'behavior-0001', DECLARATION, STORED, 'speed', 99999)).toMatchObject({
      ok: false,
      error: { code: 'property_value' },
    });
  });

  it('removal is the behaviorId: null form of the same command', () => {
    expect(planRemoveBehaviorProperties('model-0003')).toEqual({ entityId: 'model-0003', behaviorId: null });
  });
});

describe('packet 28 — declared-behavior + contract component derivation', () => {
  it('derives controls for one behavior-carrying entity', () => {
    const view = deriveBehaviorControls(
      { localId: 'model-0001', entityName: 'Lantern', behaviorId: 'behavior-0001', recordedValues: STORED },
      new Map([['behavior-0001', DECLARATION]]),
    );
    expect(view.error).toBeNull();
    expect(view.controls).toHaveLength(7);
    expect(view.controls.find((c) => c.key === 'speed')?.current).toBe(4.5);
  });

  it('reports an unresolved declaration instead of inventing a schema', () => {
    const view = deriveBehaviorControls(
      { localId: 'model-0001', entityName: 'Lantern', behaviorId: 'behavior-0009', recordedValues: {} },
      new Map(),
    );
    expect(view.declaration).toBeNull();
    expect(view.controls).toEqual([]);
    expect(view.error?.code).toBe('behavior_reference_missing');
  });

  it('exposes editable collider/controller controls and real setComponent plans (C28-1 repair)', () => {
    const box = deriveComponentControls({ collider: { shape: { type: 'box', hx: 1.5, hy: 0.25 } } });
    expect(box).toHaveLength(1);
    expect(box[0]!.component).toBe('collider');
    expect(box[0]!.present).toBe(true);
    expect(box[0]!.fields.map((f) => f.label)).toEqual(['shape', 'hx', 'hy']);
    expect(box[0]!.fields[1]!.value).toBe('1.5');
    expect(box[0]!.editable).toBe(true);
    expect(box[0]!.contractChangeRequest).toBeNull();
    expect(box[0]!.unavailableReason).toBeNull();
    expect(COMPONENT_EDIT_AVAILABLE).toContain('collider');

    const polygon = deriveComponentControls({ collider: { shape: { type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]] } } });
    expect(polygon[0]!.fields[1]!.value).toBe('3');
    expect(polygon[0]!.fields[2]!.value).toBe('0, 0');

    const controller = deriveComponentControls({ controller: {} });
    expect(controller[0]!.component).toBe('controller');
    expect(controller[0]!.fields[0]!.value).toBe('present');

    // Absent components become add affordances when the inspector asks.
    const absent = deriveComponentControls({}, { includeAbsent: true });
    expect(absent.map((c) => [c.component, c.present])).toEqual([
      ['collider', false],
      ['controller', false],
    ]);

    expect(deriveComponentControls({})).toEqual([]);
    expect(deriveComponentControls(null)).toEqual([]);
  });

  it('plans the exact setComponent args for collider/controller add, edit and remove', () => {
    expect(planSetCollider('box-0001', { type: 'box', hx: 2, hy: 0.5 })).toEqual({
      entityId: 'box-0001',
      component: 'collider',
      value: { shape: { type: 'box', hx: 2, hy: 0.5 } },
    });
    expect(planAddController('box-0001')).toEqual({ entityId: 'box-0001', component: 'controller', value: {} });
    expect(planRemovePhysicsComponent('box-0001', 'collider')).toEqual({
      entityId: 'box-0001',
      component: 'collider',
      value: null,
    });
    const box = parseColliderBox('1.5', '0.25');
    expect(box).toEqual({ ok: true, shape: { type: 'box', hx: 1.5, hy: 0.25 } });
    expect(parseColliderBox('0', '1')).toMatchObject({ ok: false, error: { code: 'collider_shape_invalid' } });
    expect(parseColliderBox('abc', '1')).toMatchObject({ ok: false, error: { code: 'collider_shape_invalid' } });
    const poly = parseColliderPolygon('[[0,0],[1,0],[0,1]]');
    expect(poly).toEqual({ ok: true, shape: { type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]] } });
    expect(parseColliderPolygon('[[0,0],[1,0]]')).toMatchObject({ ok: false, error: { code: 'collider_shape_invalid' } });
    expect(parseColliderPolygon('nope')).toMatchObject({ ok: false, error: { code: 'collider_shape_invalid' } });
  });
});
