/**
 * Packet 28 — prefab/declaration projection (Node; vitest).
 *
 * Pins the "copies, not links" property (project-model §20.1.4): definition and
 * declaration changes converge the content projection and never rewrite a
 * materialized copy; `change.next` records are applied whole; a declaration
 * update leaves stored values untouched (§20.8.3).
 */
import { describe, expect, it } from 'vitest';
import type { BehaviorRecord, PrefabDefinition, PropertyDeclaration } from '@thirdlight/project-model';
import { PrefabProjection } from './prefab-projection';
import { Projection } from './projection';
import type { EntityV3 as Entity } from '@thirdlight/project-model';

const DECLARATION: PropertyDeclaration = {
  properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 }],
};

function definition(prefabId: string, displayName = 'Kit'): PrefabDefinition {
  return {
    prefabId,
    displayName,
    createdRevision: 5,
    entityCount: 1,
    depth: 1,
    entities: [
      {
        localId: 'model-0001',
        name: 'Lantern',
        components: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          behavior: { behaviorId: 'behavior-0001', values: { speed: 4.5 } },
        },
      },
    ],
  };
}

function behavior(declaration: PropertyDeclaration, publishedRevision = 3): BehaviorRecord {
  return { behaviorId: 'behavior-0001', displayName: 'Lantern Glow', declaration, source: null, publishedRevision };
}

describe('packet 28 — prefab/declaration projection hydration', () => {
  it('hydrates definitions and declarations in ascending id order', () => {
    const p = new PrefabProjection();
    p.hydrate([definition('prefab-0002'), definition('prefab-0001')], [behavior(DECLARATION)]);
    expect(p.listDefinitions().map((d) => d.prefabId)).toEqual(['prefab-0001', 'prefab-0002']);
    expect(p.prefabIds).toEqual(['prefab-0001', 'prefab-0002']);
    expect(p.getDeclaration('behavior-0001')).toEqual(DECLARATION);
    expect(p.getBehavior('behavior-0001')?.displayName).toBe('Lantern Glow');
    expect(p.listSummaries()[0]).toEqual({ prefabId: 'prefab-0001', displayName: 'Kit', createdRevision: 5, entityCount: 1, depth: 1 });
    expect(p.declarationMap().get('behavior-0001')).toEqual(DECLARATION);
  });

  it('stores a defensive copy of a definition (the projection is not aliased)', () => {
    const input = definition('prefab-0001');
    const p = new PrefabProjection();
    p.hydrate([input], []);
    p.getDefinition('prefab-0001')!.displayName = 'mutated';
    expect(input.displayName).toBe('Kit');
  });
});

describe('packet 28 — definitions/declarations converge from applied changes', () => {
  it('applies createPrefab and removePrefab without touching the scene projection', () => {
    const scene = new Projection();
    const copy: Entity = {
      id: 'model-0003',
      name: 'Lantern',
      components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    };
    scene.hydrate({ revision: 12, entities: [copy] });
    const before = JSON.stringify(scene.listEntities());

    const p = new PrefabProjection();
    expect(p.applyChange({ type: 'createPrefab', prefabId: 'prefab-0001', definition: definition('prefab-0001') })).toBe(true);
    expect(p.getDefinition('prefab-0001')?.displayName).toBe('Kit');
    // Undo of the capture removes the definition; the materialized copy (and
    // its entities/values) is untouched — copies are not links.
    expect(p.applyChange({ type: 'removePrefab', prefabId: 'prefab-0001' })).toBe(true);
    expect(p.getDefinition('prefab-0001')).toBeUndefined();
    expect(JSON.stringify(scene.listEntities())).toBe(before);
  });

  it('treats instantiatePrefab as scene-only (it never edits a definition)', () => {
    const p = new PrefabProjection();
    p.hydrate([definition('prefab-0001')], [behavior(DECLARATION)]);
    expect(
      p.applyChange({
        type: 'instantiatePrefab',
        prefabId: 'prefab-0001',
        rootId: 'group-0002',
        entries: [],
        mapping: [],
      }),
    ).toBe(false);
    expect(p.getDefinition('prefab-0001')?.displayName).toBe('Kit');
  });

  it('applies a declaration update from change.next without rewriting stored values', () => {
    const values = { speed: 4.5 };
    const p = new PrefabProjection();
    p.hydrate([definition('prefab-0001')], [behavior(DECLARATION)]);
    const updated: PropertyDeclaration = { properties: [{ ...DECLARATION.properties[0]!, default: 9 }] };
    expect(
      p.applyChange({
        type: 'publishBehavior',
        behaviorId: 'behavior-0001',
        previous: behavior(DECLARATION),
        next: behavior(updated, 4),
      }),
    ).toBe(true);
    // The schema changed (new default); the definition's recorded values did not.
    expect(p.getDeclaration('behavior-0001')?.properties[0]?.default).toBe(9);
    expect(p.getDefinition('prefab-0001')?.entities[0]?.components.behavior?.values).toEqual(values);
  });

  it('removes a behavior record on the inverse (change.next === null)', () => {
    const p = new PrefabProjection();
    p.hydrate([], [behavior(DECLARATION)]);
    expect(p.applyChange({ type: 'publishBehavior', behaviorId: 'behavior-0001', previous: behavior(DECLARATION), next: null })).toBe(true);
    expect(p.getBehavior('behavior-0001')).toBeUndefined();
    expect(p.getDeclaration('behavior-0001')).toBeUndefined();
  });
});
