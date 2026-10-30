/**
 * The editor's preflight and the commands decide property values and prefab
 * rules with the same project-model functions, so an edit the editor accepts
 * is one the backend accepts. Each side is called through its own entry
 * point; the shared rule is wrapped in a spy to prove both go through it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DeclaredProperty } from '@thirdlight/project-model';

vi.mock('@thirdlight/project-model/authoring-rules', async (importOriginal) => {
  const real = await importOriginal<typeof import('@thirdlight/project-model/authoring-rules')>();
  return {
    ...real,
    propertyValueRule: vi.fn(real.propertyValueRule),
    transformFieldErrors: vi.fn(real.transformFieldErrors),
    firstExternalEntityRef: vi.fn(real.firstExternalEntityRef),
  };
});

const rules = await import('@thirdlight/project-model/authoring-rules');
const { checkOverrideValue } = await import('../packages/commands/src/properties');
const commandErrors = await import('../packages/commands/src/errors');
const { parseControlInput, validatePropertyValue, isPrivateProperty } = await import('../packages/editor/src/session/property-controls');
const { planInstantiatePrefab, preflightCreatePrefab } = await import('../packages/editor/src/session/prefab-authoring');
const model = await import('@thirdlight/project-model');
const { validateTransformV2 } = await import('../packages/project-model/src/components');

const prop = (over: Partial<DeclaredProperty>): DeclaredProperty => ({ key: 'p', label: 'P', type: 'number', default: 0, ...over }) as DeclaredProperty;

/** Declarations and values, valid and not, across the seven types. */
const TABLE: [DeclaredProperty, unknown][] = [
  [prop({ min: 0, max: 10 }), 10],
  [prop({ min: 0, max: 10 }), 10.5],
  [prop({ min: 0, max: 10 }), -1],
  [prop({}), Number.NaN],
  [prop({}), '3'],
  [prop({ type: 'boolean', default: false }), true],
  [prop({ type: 'boolean', default: false }), 'true'],
  [prop({ type: 'string', default: '' }), 'ab'],
  [prop({ type: 'string', default: '', maxLength: 2 }), 'abc'],
  [prop({ type: 'string', default: '', maxLength: 2 }), '😀😀'],
  [prop({ type: 'string', default: '' }), 'x'.repeat(257)],
  [prop({ type: 'string', default: '' }), 'a\u0007b'],
  [prop({ type: 'enum', default: 'a', values: ['a', 'b'] }), 'b'],
  [prop({ type: 'enum', default: 'a', values: ['a', 'b'] }), 'c'],
  [prop({ type: 'enum', default: 'a', values: ['a', 'b'] }), 1],
  [prop({ type: 'vec3', default: [0, 0, 0] }), [1, 2, 3]],
  [prop({ type: 'vec3', default: [0, 0, 0] }), [1, 2]],
  [prop({ type: 'vec3', default: [0, 0, 0] }), [1, 2, Infinity]],
  [prop({ type: 'vec3', default: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } }), [1, 1, 1.5]],
  [prop({ type: 'entityRef', default: null }), null],
  [prop({ type: 'entityRef', default: null }), 'box-0001'],
  [prop({ type: 'entityRef', default: null }), 'box-9999'],
  [prop({ type: 'entityRef', default: null }), 4],
  [prop({ type: 'assetRef', default: null }), 'asset-1'],
  [prop({ type: 'assetRef', default: null }), 'asset-2'],
  [prop({ type: 'assetRef', default: null }), false],
];

const REFS = { entityIds: new Set(['box-0001']), assetIds: new Set(['asset-1']) };

/** The text a user would type for a value (only values that parse to themselves). */
function asText(value: unknown): string | null {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v))) return value.join(', ');
  return null;
}

describe('one rule for property values', () => {
  it('the editor and the commands call the same function', () => {
    const rule = vi.mocked(rules.propertyValueRule);
    rule.mockClear();
    validatePropertyValue(prop({}), 1);
    expect(rule).toHaveBeenCalledTimes(1);
    parseControlInput({ key: 'p', label: 'P', type: 'number', constraints: {} }, '1');
    expect(rule).toHaveBeenCalledTimes(2);
    checkOverrideValue(prop({}), 'p', 1, REFS, 'prefab-1');
    expect(rule).toHaveBeenCalledTimes(3);
    // Re-exports, not copies.
    expect(isPrivateProperty).toBe(rules.isPrivateProperty);
    expect(commandErrors.isValidName).toBe(rules.isValidName);
    expect(rules.isPrivateProperty).toBe(model.isPrivateProperty);
  });

  it('agrees on every value of the table, with and without references', () => {
    for (const [p, value] of TABLE) {
      const command = checkOverrideValue(p, p.key, value, REFS, 'prefab-1');
      const commandCode = command.ok ? null : command.error.code;
      // Stored values: references are not resolved without the scene.
      const stored = validatePropertyValue(p, value);
      const unresolved = commandCode === 'reference_missing' || commandCode === 'asset_reference_missing';
      expect(stored?.code ?? null, `stored ${p.type} ${JSON.stringify(value)}`).toBe(unresolved ? null : commandCode);
      // Typed input with the reference lists: the editor's verdict is the command's.
      const text = asText(value);
      // Only text that types back to the same value ("1" in an enum field is the string "1").
      const sameKind = (typeof value === 'number') === (p.type === 'number') && (typeof value === 'boolean') === (p.type === 'boolean');
      if (text === null || !sameKind) continue;
      const parsed = parseControlInput(
        { key: p.key, label: p.label, type: p.type, constraints: p },
        text,
        { entityIds: [...REFS.entityIds], assetIds: [...REFS.assetIds] },
      );
      expect(parsed.ok ? null : parsed.error.code, `input ${p.type} ${JSON.stringify(text)}`).toBe(commandCode);
    }
  });
});

describe('one set of prefab rules', () => {
  const declarations = new Map([['mover', { properties: [prop({ key: 'target', label: 'Target', type: 'entityRef', default: null })] }]]);
  const scene = [
    { id: 'a', parentId: null, prefab: null, behavior: null },
    { id: 'b', parentId: 'a', prefab: null, behavior: { behaviorId: 'mover', values: { target: 'c' } } },
    { id: 'c', parentId: null, prefab: null, behavior: null },
  ];

  it('the capture preflight finds the external reference with the shared rule', () => {
    const external = vi.mocked(rules.firstExternalEntityRef);
    external.mockClear();
    const r = preflightCreatePrefab({ prefabId: 'prefab-0001', displayName: 'P', sourceEntityId: 'a', scene, existingPrefabIds: [], declarations });
    expect(external).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, error: { code: 'prefab_external_reference_forbidden', localId: 'b', key: 'target', entityId: 'c' } });
    expect(rules.subtreeOf(scene, 'a')).toEqual({ entities: [scene[0], scene[1]], depth: 2 });
    expect(rules.subtreeOf(scene, 'nope')).toBeNull();
  });

  it("a placed copy's root transform is checked by the scene's transform rule", () => {
    const transform = vi.mocked(rules.transformFieldErrors);
    const definition = { prefabId: 'prefab-0001', displayName: 'P', depth: 1, entities: [{ localId: 'a', components: {} }] } as never;
    const base = { prefabId: 'prefab-0001', definition, declarations, sceneEntityIds: [], parentDepth: 0 };
    const cases: [Record<string, unknown>, string | null][] = [
      [{ position: [1, 2, 3] }, null],
      [{ position: [2e6, 0, 0] }, 'number_out_of_range'],
      [{ rotation: [0, 0, 0, 2] }, 'quaternion_invalid'],
      [{ scale: [1, 0, 1] }, 'number_out_of_range'],
    ];
    for (const [t, code] of cases) {
      transform.mockClear();
      const plan = planInstantiatePrefab({ ...base, transform: t });
      expect(transform).toHaveBeenCalledTimes(1);
      expect(plan.ok ? null : plan.error.code).toBe(code);
      // The model's scene transform check gives the same verdict.
      const errors: { code: string }[] = [];
      validateTransformV2({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...t }, '/t', errors as never);
      expect(errors[0]?.code ?? null).toBe(code);
    }
  });
});
