/**
 * Phase 15.1: the generic Inspector's model — widget mapping, conditions,
 * edits → command values, the "+ Add component" list. Hand-made descriptors
 * here (the editor may not import project-model values); the real registry
 * and the real commands are checked in `tests/integration/m15-inspector`.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDescriptor, DescriptorRegistry, FieldDescriptor, ObjectFieldDescriptor } from '@thirdlight/project-model';
import {
  addEntries,
  checkNumber,
  intChoices,
  collectSignals,
  componentOp,
  componentPatch,
  entityChoices,
  fieldAria,
  fieldAt,
  groupFields,
  normalize,
  parseNumberInput,
  pickedValue,
  presetValue,
  removable,
  setAt,
  sliderRange,
  startValue,
  visibleFields,
  widgetFor,
} from './descriptor-fields';

const base = { label: 'L', tooltip: 't' };
const f = <T extends FieldDescriptor = FieldDescriptor>(x: Record<string, unknown>): T => ({ ...base, ...x }) as unknown as T;

const TRIGGER: ObjectFieldDescriptor = f<ObjectFieldDescriptor>({
  type: 'object',
  key: 'trigger',
  fields: [
    f({ type: 'enum', key: 'shape', options: [{ value: 'box', label: 'Box' }, { value: 'circle', label: 'Circle' }], default: 'box' }),
    f({ type: 'vec2', key: 'size', labels: ['w', 'h'], required: true, when: { key: 'shape', in: ['box'] }, default: [2, 2], min: 0.05, max: 500 }),
    f({ type: 'number', key: 'radius', required: true, when: { key: 'shape', in: ['circle'] }, default: 1, min: 0.05, max: 100, unit: 'm' }),
    f({ type: 'signal', key: 'signal', required: true, default: 'trigger' }),
    f({ type: 'enum', key: 'mode', options: [{ value: 'enter', label: 'Enter' }, { value: 'stay', label: 'Stay' }], default: 'enter' }),
    f({ type: 'bool', key: 'once', default: false }),
  ],
});

const CONTROLLER: ObjectFieldDescriptor = f<ObjectFieldDescriptor>({
  type: 'object',
  key: 'controller',
  fields: [
    f<ObjectFieldDescriptor>({
      type: 'object',
      key: 'capsule',
      group: 'Collision',
      fields: [
        f({ type: 'number', key: 'radius', required: true, default: 0.3, min: 0.05, max: 5 }),
        f({ type: 'number', key: 'height', required: true, default: 1.8, min: 0.1, max: 20 }),
        f({ type: 'vec2', key: 'offset', labels: ['x', 'y'], default: [0, 0] }),
      ],
    }),
  ],
});

const comp = (name: string, value: ObjectFieldDescriptor, extra: Partial<ComponentDescriptor> = {}): ComponentDescriptor => ({
  name,
  label: name.charAt(0).toUpperCase() + name.slice(1),
  tooltip: 't',
  category: 'Gameplay',
  value,
  add: { kind: 'menu', value: {} },
  handles: [],
  excludes: [],
  prefab: false,
  ...extra,
});

describe('widgetFor', () => {
  it('maps every field type to one widget', () => {
    const cases: [FieldDescriptor, string][] = [
      [f({ type: 'number', key: 'a' }), 'number'],
      [f({ type: 'int', key: 'a' }), 'int'],
      [f({ type: 'bool', key: 'a' }), 'bool'],
      [f({ type: 'enum', key: 'a', options: [] }), 'enum'],
      [f({ type: 'vec2', key: 'a', labels: ['x', 'y'] }), 'vector'],
      [f({ type: 'vec3', key: 'a', labels: ['x', 'y', 'z'] }), 'vector'],
      [f({ type: 'quat', key: 'a' }), 'euler'],
      [f({ type: 'color', key: 'a' }), 'color'],
      [f({ type: 'assetRef', key: 'a', kinds: ['audio'] }), 'asset'],
      [f({ type: 'entityRef', key: 'a' }), 'entity'],
      [f({ type: 'sceneRef', key: 'a' }), 'scene'],
      [f({ type: 'ref', key: 'a', target: 'material' }), 'ref'],
      [f({ type: 'signal', key: 'a' }), 'signal'],
      [f({ type: 'string', key: 'a' }), 'text'],
      [f({ type: 'string', key: 'a', format: 'multiline' }), 'multiline'],
      [f({ type: 'object', key: 'a', fields: [] }), 'object'],
      [f({ type: 'list', key: 'a', item: f({ type: 'number', key: '*' }) }), 'list'],
      [f({ type: 'map', key: 'a', keyLabel: 'K', value: f({ type: 'number', key: '*' }) }), 'map'],
      [f({ type: 'json', key: 'a' }), 'readonly'],
      [f({ type: 'components', key: 'a', allowed: [] }), 'readonly'],
      [f({ type: 'number', key: 'a', readOnly: true }), 'readonly'],
    ];
    for (const [d, w] of cases) expect(widgetFor(d), d.type).toBe(w);
  });

  it('adds a slider to bounded numbers only', () => {
    expect(sliderRange(f({ type: 'number', key: 'a', min: 0, max: 1, step: 0.05 }))).toEqual({ min: 0, max: 1, step: 0.05 });
    expect(sliderRange(f({ type: 'number', key: 'a', min: 0 }))).toBeNull();
    expect(sliderRange(f({ type: 'number', key: 'a', min: -1e6, max: 1e6 }))).toBeNull();
    expect(sliderRange(f({ type: 'int', key: 'a', min: 0, max: 10 }))?.step).toBe(1);
    // Phase 15.3: an int with a list of allowed values is a select (no slider).
    expect(sliderRange(f({ type: 'int', key: 'a', min: 60, max: 240, values: [60, 120, 240] }))).toBeNull();
    expect(intChoices(f({ type: 'int', key: 'a', values: [60, 120, 240] }))).toEqual([60, 120, 240]);
    expect(intChoices(f({ type: 'int', key: 'a', min: 0, max: 10 }))).toBeNull();
  });

  it('names fields by component and path', () => {
    expect(fieldAria('trigger', ['radius'])).toBe('trigger radius');
    expect(fieldAria('mover', ['waypoints', 0])).toBe('mover waypoints 1');
    expect(fieldAria('transform', ['position'])).toBe('position');
    expect(fieldAria('controller', ['capsule', 'height'])).toBe('controller capsule height');
  });
});

describe('conditions', () => {
  it('shows the variant that holds, on the effective (default) value', () => {
    expect(visibleFields({ desc: TRIGGER, value: {} }).map((x) => x.key)).toEqual(['shape', 'size', 'signal', 'mode', 'once']);
    expect(visibleFields({ desc: TRIGGER, value: { shape: 'circle' } }).map((x) => x.key)).toEqual(['shape', 'radius', 'signal', 'mode', 'once']);
  });

  it('follows ../ to the enclosing object', () => {
    const mat = f<ObjectFieldDescriptor>({
      type: 'object',
      key: 'm',
      fields: [
        f({ type: 'enum', key: 'shader', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' }),
        f<ObjectFieldDescriptor>({ type: 'object', key: 'params', fields: [f({ type: 'number', key: 'x', when: { key: '../shader', in: ['b'] } }), f({ type: 'number', key: 'y' })] }),
      ],
    });
    const params = mat.fields[1] as ObjectFieldDescriptor;
    const outer = { desc: mat, value: { shader: 'a' } };
    expect(visibleFields({ desc: params, value: {}, parent: outer }).map((x) => x.key)).toEqual(['y']);
    expect(visibleFields({ desc: params, value: {}, parent: { desc: mat, value: { shader: 'b' } } }).map((x) => x.key)).toEqual(['x', 'y']);
  });

  it('groups fields, ungrouped first', () => {
    const g = groupFields([f({ type: 'number', key: 'a', group: 'Jump' }), f({ type: 'number', key: 'b' }), f({ type: 'number', key: 'c', group: 'Jump' })]);
    expect(g.map((x) => [x.group, x.fields.map((y) => y.key)])).toEqual([[null, ['b']], ['Jump', ['a', 'c']]]);
  });
});

describe('edits → command values', () => {
  it('switching a variant drops the old fields and adds the new required ones (one patch)', () => {
    expect(componentPatch(TRIGGER, { size: [2, 2], signal: 'trigger' }, ['shape'], 'circle')).toEqual({ shape: 'circle', size: null, radius: 1 });
  });

  it('an optional field set to its default is removed; required ones are stored', () => {
    expect(componentPatch(TRIGGER, { size: [2, 2], signal: 's', mode: 'stay' }, ['mode'], 'enter')).toEqual({ mode: null });
    expect(componentPatch(TRIGGER, { size: [2, 2], signal: 's', once: true }, ['once'], false)).toEqual({ once: null });
    expect(componentPatch(TRIGGER, { size: [2, 2], signal: 's' }, ['signal'], 'trigger')).toEqual({ signal: 'trigger' });
  });

  it('changes nothing → null (never sent: the backend refuses no_change)', () => {
    expect(componentPatch(TRIGGER, { size: [2, 2], signal: 's' }, ['signal'], 's')).toBeNull();
  });

  it('a nested edit sends the whole top-level field; an absent optional object is created with its required defaults', () => {
    expect(componentPatch(CONTROLLER, {}, ['capsule', 'radius'], 0.5)).toEqual({ capsule: { radius: 0.5, height: 1.8 } });
    expect(componentPatch(CONTROLLER, { capsule: { radius: 0.5, height: 1.8, offset: [0, 1] } }, ['capsule', 'offset'], [0, 0])).toEqual({ capsule: { radius: 0.5, height: 1.8 } });
    expect(componentPatch(CONTROLLER, { capsule: { radius: 0.5, height: 1.8 } }, ['capsule'], undefined)).toEqual({ capsule: null });
  });

  it('edits list items and removes them', () => {
    const mover = f<ObjectFieldDescriptor>({ type: 'object', key: 'mover', fields: [f({ type: 'list', key: 'waypoints', required: true, item: f({ type: 'vec3', key: '*', labels: ['x', 'y', 'z'] }) })] });
    expect(componentPatch(mover, { waypoints: [[1, 0, 0], [2, 0, 0]] }, ['waypoints', 1], [3, 0, 0])).toEqual({ waypoints: [[1, 0, 0], [3, 0, 0]] });
    expect(setAt({ w: [1, 2, 3] }, ['w', 1], undefined)).toEqual({ w: [1, 3] });
    expect(fieldAt(mover, {}, ['waypoints', 0])?.type).toBe('vec3');
  });

  it('starting values: defaults, required fields of objects, first enum option', () => {
    expect(startValue(CONTROLLER.fields[0]!)).toEqual({ radius: 0.3, height: 1.8 });
    expect(startValue(f({ type: 'enum', key: 'e', options: [{ value: 'x', label: 'X' }] }))).toBe('x');
    expect(normalize(TRIGGER, { shape: 'circle' })).toEqual({ shape: 'circle', radius: 1, signal: 'trigger' });
  });
});

describe('number input', () => {
  const n = f({ type: 'number', key: 'n', label: 'Speed', min: 0, max: 10 });
  it('parses, bounds and leaves the rest to the backend', () => {
    expect(parseNumberInput(n, ' 3.5 ')).toEqual({ ok: true, value: 3.5 });
    expect(parseNumberInput(n, '')).toEqual({ ok: true, value: undefined });
    expect(parseNumberInput(n, 'abc').ok).toBe(false);
    expect(parseNumberInput(n, '11').ok).toBe(false);
    expect(checkNumber(f({ type: 'int', key: 'i' }), 1.5).ok).toBe(false);
    expect(checkNumber(f({ type: 'int', key: 'i', values: [60, 120, 240] }), 100).ok).toBe(false);
    expect(checkNumber(f({ type: 'int', key: 'i', values: [60, 120, 240] }), 240).ok).toBe(true);
    expect(checkNumber(f({ type: 'number', key: 'x', min: 0, minExclusive: true }), 0).ok).toBe(false);
    expect(checkNumber(f({ type: 'number', key: 'x', nonZero: true }), 0).ok).toBe(false);
  });
});

describe('+ Add component', () => {
  const reg = {
    version: 1,
    handleKinds: [],
    handleRoles: {},
    entity: f<ObjectFieldDescriptor>({ type: 'object', key: 'entity', fields: [] }),
    content: [],
    components: [
      comp('transform', f({ type: 'object', key: 'transform', fields: [] }), { add: { kind: 'never', reason: 'always there' } }),
      comp('box', f({ type: 'object', key: 'box', fields: [] }), { category: 'Rendering', excludes: [{ component: 'model', reason: 'one shape' }] }),
      comp('model', f({ type: 'object', key: 'model', fields: [f<ObjectFieldDescriptor>({ type: 'object', key: 'asset', required: true, fields: [f({ type: 'assetRef', key: 'assetId', kinds: ['model'], required: true })] })] }), { category: 'Rendering', add: { kind: 'pick', value: { asset: {} }, pick: ['asset/assetId'] }, excludes: [{ component: 'box', reason: 'one shape' }] }),
      comp('light', f({ type: 'object', key: 'light', fields: [] }), { presets: [{ label: 'Point', value: { type: 'point' } }, { label: 'Spot', value: { type: 'spot' } }] }),
      comp('surface', f({ type: 'object', key: 'surface', fields: [] }), { requiresAnyOf: { components: ['box', 'model'], reason: 'it colours a shape' } }),
      comp('prefab', f({ type: 'object', key: 'prefab', fields: [] }), { add: { kind: 'tool', tool: 'instantiatePrefab' } }),
      comp('trigger', TRIGGER, { add: { kind: 'menu', value: { size: [2, 2], signal: 'trigger' } } }),
    ],
  } as unknown as DescriptorRegistry;

  it('lists every component but the transform, presets separately, and says why one cannot be added', () => {
    const e = addEntries(reg, new Set(['transform', 'box', 'trigger']));
    const byId = Object.fromEntries(e.map((x) => [x.id, x]));
    expect(e.some((x) => x.component === 'transform')).toBe(false);
    expect(byId['box']).toMatchObject({ enabled: false, reason: 'already on this object' });
    expect(byId['model']!.enabled).toBe(false);
    expect(byId['model']!.reason).toContain('one shape');
    expect(byId['light:0']).toMatchObject({ label: 'Light: Point', enabled: true, value: { type: 'point' } });
    expect(byId['light:1']!.label).toBe('Light: Spot');
    expect(byId['surface']!.enabled).toBe(true);
    expect(byId['prefab']).toMatchObject({ enabled: false, reason: 'made by the instantiatePrefab' });
    const empty = Object.fromEntries(addEntries(reg, new Set(['transform'])).map((x) => [x.id, x]));
    expect(empty['surface']!.reason).toContain('needs Box or Model');
    expect(empty['model']).toMatchObject({ enabled: true, pick: ['asset/assetId'] });
    expect(addEntries(reg, new Set(), { folder: true }).every((x) => !x.enabled)).toBe(true);
  });

  it('phase 15.5: the GameObject menu takes a preset or the add value from the registry (a copy)', () => {
    const spot = presetValue(reg, 'light', 'Spot');
    expect(spot).toEqual({ type: 'spot' });
    spot!['type'] = 'changed';
    expect(presetValue(reg, 'light', 'Spot')).toEqual({ type: 'spot' });
    expect(presetValue(reg, 'trigger')).toEqual({ size: [2, 2], signal: 'trigger' });
    expect(presetValue(reg, 'light', 'Nope')).toBeNull();
    expect(presetValue(reg, 'prefab')).toBeNull();
    expect(presetValue(null, 'light', 'Spot')).toBeNull();
  });

  it('a pick entry adds once its fields are chosen', () => {
    const model = reg.components.find((c) => c.name === 'model')!;
    expect(pickedValue(model, { asset: {} })).toEqual({ ok: false, missing: ['asset/assetId'] });
    expect(pickedValue(model, { asset: { assetId: 'a-1' } })).toEqual({ ok: true, value: { asset: { assetId: 'a-1' } } });
  });

  it('knows which command edits a component and which are removable', () => {
    expect(componentOp('transform')).toBe('setTransform');
    expect(componentOp('behavior')).toBe('setBehaviorProperties');
    expect(componentOp('prefab')).toBeNull();
    expect(componentOp('trigger')).toBe('setComponent');
    expect(removable('transform')).toBe(false);
    expect(removable('box')).toBe(true);
    expect(removable('prefab')).toBe(false);
  });

  it('collects signal names and filters entity choices', () => {
    expect(collectSignals(reg, [{ trigger: { size: [1, 1], signal: 'open' } }, { trigger: { signal: 'close' } }, {}])).toEqual(['close', 'open']);
    const all = [
      { id: 'a', name: 'A', sceneId: 's1', components: ['playerSpawn'] },
      { id: 'b', name: 'B', sceneId: 's2', components: ['playerSpawn'] },
      { id: 'c', name: 'C', sceneId: 's1', components: [] },
    ];
    expect(entityChoices(f({ type: 'entityRef', key: 'x', component: 'playerSpawn' }), all, 's1').map((e) => e.id)).toEqual(['a']);
    expect(entityChoices(f({ type: 'entityRef', key: 'x', component: 'playerSpawn', anyScene: true }), all, 's1').map((e) => e.id)).toEqual(['a', 'b']);
  });
});
