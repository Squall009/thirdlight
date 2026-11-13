/**
 * The `interactor` schema 8 step: a project written with `foliageBend` opens
 * with `interactor` (objects, prefab parts, linked copies' overrides), the
 * upgraded scene validates and its canonical form keeps every field, and a
 * project that never used the component is left as it was.
 */
import { describe, expect, it } from 'vitest';

import { interactorOf, INTERACTOR_DEFAULTS } from './interactor';
import { validateSceneV4 } from './scene-v3';
import { upgradeInteractor } from './upgrade-interactor';
import { pendingSchema8Steps, RECORDED_SCHEMA_8_STEPS, upgradeToSchema8 } from './upgrade-schema-8';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (entities: unknown[]): Record<string, unknown> => ({ schemaVersion: 4, sceneId: 'main', revision: 1, entities });

describe('interactor upgrade step', () => {
  it('renames foliageBend on objects, prefab parts and the overrides of linked copies', () => {
    const content = {
      prefabs: [{ prefabId: 'walker', entities: [{ localId: 'root', components: { transform: T, foliageBend: { radius: 0.8 } } }, { localId: 'nested', components: { transform: T, prefab: { prefabId: 'other', overrides: [{ part: 'root', path: 'components/foliageBend/strength', value: 2 }] } } }] }],
    };
    const scenes = [
      scene([
        { id: 'hero-0001', components: { transform: T, box: { size: [1, 2, 1] }, foliageBend: { radius: 1.2, strength: 0.5, recovery: 2 } } },
        { id: 'copy-0001', components: { transform: T, prefab: { prefabId: 'walker', overrides: [{ part: 'root', path: 'components/foliageBend', remove: true }, { part: 'root', path: 'name', value: 'x' }] } } },
        { id: 'plain-0001', components: { transform: T } },
      ]),
    ];
    const r = upgradeInteractor(content, scenes);
    expect(r.changed).toBe(true);
    const ents = (r.scenes[0] as { entities: { components: Record<string, unknown> }[] }).entities;
    expect(ents[0]!.components).toEqual({ transform: T, box: { size: [1, 2, 1] }, interactor: { radius: 1.2, strength: 0.5, recovery: 2 } });
    // The key keeps its place among the object's components.
    expect(Object.keys(ents[0]!.components)).toEqual(['transform', 'box', 'interactor']);
    expect(ents[1]!.components['prefab']).toEqual({ prefabId: 'walker', overrides: [{ part: 'root', path: 'components/interactor', remove: true }, { part: 'root', path: 'name', value: 'x' }] });
    expect(ents[2]).toBe((scenes[0]!['entities'] as unknown[])[2]);
    const prefab = (r.content as typeof content).prefabs[0]!;
    expect(prefab.entities[0]!.components).toEqual({ transform: T, interactor: { radius: 0.8 } });
    expect((prefab.entities[1]!.components as { prefab: { overrides: { path: string }[] } }).prefab.overrides[0]!.path).toBe('components/interactor/strength');
    expect(r.notes[0]).toMatch(/foliageBend component is now interactor/);
  });

  it('keeps interactor where an object has both, with a note; leaves a project without it untouched', () => {
    const both = upgradeInteractor({}, [scene([{ id: 'a-0001', components: { transform: T, interactor: { strength: 2 }, foliageBend: { strength: 3 } } }])]);
    expect((both.scenes[0] as { entities: { components: unknown }[] }).entities[0]!.components).toEqual({ transform: T, interactor: { strength: 2 } });
    expect(both.notes.some((n) => n.includes('had both foliageBend and interactor'))).toBe(true);
    const content = { prefabs: [{ prefabId: 'p', entities: [{ localId: 'root', components: { transform: T } }] }] };
    const scenes = [scene([{ id: 'a-0001', components: { transform: T } }])];
    const none = upgradeInteractor(content, scenes);
    expect(none).toEqual({ content, scenes, changed: false, notes: [] });
    expect(none.content).toBe(content);
  });

  it('runs once on an 8 that has not had it; the upgraded scene validates and its canonical form keeps the fields', () => {
    expect(RECORDED_SCHEMA_8_STEPS).toContain('interactor');
    const pending = pendingSchema8Steps(['bloom-exposure', 'light-counts', 'planes']);
    expect(pending.map((s) => s.name)).toEqual(['interactor']);
    const r = upgradeToSchema8({}, [scene([{ id: 'hero-0001', components: { transform: T, foliageBend: { radius: 0.8, strength: 1.5, recovery: 2 } } }])], pending);
    expect(r.applied).toEqual(['interactor']);
    const v = validateSceneV4(r.scenes[0]);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const comps = v.normalized.entities[0]!.components as Record<string, unknown>;
    expect(comps['interactor']).toEqual({ radius: 0.8, strength: 1.5, recovery: 2 });
    expect(comps['foliageBend']).toBeUndefined();
    // The old name is no component any more: a scene that still carries it is refused, not silently dropped.
    const stale = validateSceneV4(scene([{ id: 'hero-0001', components: { transform: T, foliageBend: { radius: 0.8 } } }]));
    expect(stale.ok).toBe(false);
    // Its values mean what they meant: an absent radius grows from the body by the margin.
    expect(interactorOf({ strength: 1.5 }, 0.4)).toEqual({ radius: 0.4 + INTERACTOR_DEFAULTS.margin, strength: 1.5, recovery: INTERACTOR_DEFAULTS.recovery });
  });
});
