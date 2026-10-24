/**
 * The schema 8 step on documents shaped like the games' prefab use: placed
 * props with several parts under a group (doors: a behavior on the root, a
 * trigger and a blocker below), single-object walkers whose per-copy values
 * differ, a prefab that is gone. The linked scene assembles to exactly the
 * objects stored before.
 */
import { describe, expect, it } from 'vitest';

import { assembleSceneEntities, createPrefabAssembler, type AssemblyEntity } from './prefab-assembly';
import { isPrefabLink } from './prefab-links';
import { upgradeToSchema8 } from './upgrade-schema-8';

type Any = any;
const T = (p: number[]): Any => ({ position: p, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const DOOR_PROPS = [
  { key: 'travel', type: 'number', default: 1 },
  { key: 'leaf', type: 'entityRef', default: '' },
];
const content: Any = {
  behaviors: [{ behaviorId: 'door', declaration: { properties: DOOR_PROPS } }],
  prefabs: [
    {
      prefabId: 'door',
      entities: [
        { localId: 'model-1', name: 'Door', components: { transform: T([0, -60, 0]), model: { asset: { assetId: 'kit' }, piece: 'frame' }, behavior: { behaviorId: 'door', values: { travel: 1, leaf: 'model-2' } }, materials: { '*': 'trim' } } },
        { localId: 'model-2', name: 'Leaf', parentLocalId: 'model-1', components: { transform: T([0, 0, 0]), model: { asset: { assetId: 'kit' }, piece: 'leaf' } } },
        { localId: 'group-3', name: 'Sensor', parentLocalId: 'model-1', components: { transform: T([0, 1, 0]), trigger: { size: [1, 2, 3], signal: 'door-sensor', shape: 'box' } } },
      ],
    },
    { prefabId: 'walker', entities: [{ localId: 'box-1', name: 'Walker', components: { transform: T([0, -80, 0]), box: { size: [0.5, 0.5, 0.9] }, patrol: { mode: 'waypoints', waypoints: [[3, 0, 0]], speed: 1.2 } } }] },
  ],
};
/** A door placed as the instantiate command placed it: values filled, the leaf reference mapped to the copy's leaf. */
const door = (n: number, parentId: string, x: number): Any[] => [
  { id: `door-${n}`, name: 'Door', parentId, components: { transform: T([x, 0, 0]), model: { asset: { assetId: 'kit' }, piece: 'frame' }, behavior: { behaviorId: 'door', values: { travel: 1, leaf: `leaf-${n}` } }, materials: { '*': 'trim' }, prefab: { prefabId: 'door', localId: 'model-1' } } },
  { id: `leaf-${n}`, name: 'Leaf', parentId: `door-${n}`, components: { transform: T([0, 0, 0]), model: { asset: { assetId: 'kit' }, piece: 'leaf' }, prefab: { prefabId: 'door', localId: 'model-2' } } },
  { id: `sensor-${n}`, name: 'Sensor', parentId: `door-${n}`, components: { transform: T([0, 1, 0]), trigger: { size: [1, 2, 3], signal: 'door-sensor', shape: 'box' }, prefab: { prefabId: 'door', localId: 'group-3' } } },
];

function sceneBefore(): Any {
  const d1 = door(1, 'group-1', 0);
  const d2 = door(2, 'group-1', 4);
  d2[0].components.behavior.values.travel = 2; // a per-copy value
  d2[1].components.model.piece = 'leaf-wide'; // a changed part
  const d3 = door(3, 'group-1', 8).filter((e: Any) => e.id !== 'sensor-3'); // a deleted part
  d3[0].name = 'Back door';
  const d4 = door(4, 'group-1', 12);
  d4[2].parentId = 'leaf-4'; // a part moved under another part: it stays a plain object, hanging from the part
  const d5 = door(5, 'group-1', 16);
  const sign = { id: 'sign-1', parentId: 'group-1', components: { transform: T([16, 3, 0]) } }; // between a copy's parts: a link cannot keep the order
  const m1 = { id: 'walker-1', name: 'Walker', components: { transform: T([10, 1, 12]), box: { size: [0.5, 0.5, 0.9] }, patrol: { mode: 'waypoints', waypoints: [[2, 0, 3]], speed: 1.2 }, prefab: { prefabId: 'walker', localId: 'box-1' } } };
  const m2 = { id: 'walker-2', name: 'Walker', components: { transform: T([16, 1, 8]), box: { size: [0.5, 0.5, 0.9] }, patrol: { mode: 'waypoints', waypoints: [[3, 0, 0]], speed: 1.2 }, prefab: { prefabId: 'walker', localId: 'box-1' } } };
  return {
    schemaVersion: 4,
    sceneId: 'residence',
    revision: 3,
    entities: [
      { id: 'group-1', name: 'Doors', components: { transform: T([0, 0, 0]) } },
      ...d1,
      ...d2,
      ...d3,
      ...d4,
      d5[0],
      sign,
      d5[1],
      d5[2],
      // An object added under a copy's part, and one whose prefab is gone.
      { id: 'lamp-1', parentId: 'leaf-1', components: { transform: T([0, 2, 0]), light: { type: 'point' } } },
      { id: 'crate-1', components: { transform: T([3, 0, 3]), box: { size: [1, 1, 1] }, prefab: { prefabId: 'crate', localId: 'box-9' } } },
      m1,
      m2,
    ],
  };
}

const assembled = (c: Any, scene: Any): AssemblyEntity[] => {
  const declarations = new Map((c.behaviors as Any[]).map((b) => [b.behaviorId, b.declaration.properties]));
  return assembleSceneEntities(scene.entities, createPrefabAssembler(c.prefabs, { declarations })).entities;
};

describe('schema 8: plain prefab copies become linked copies', () => {
  it('links every copy it can keep exactly, with its differences as overrides; the scene assembles to what was stored', () => {
    const before = sceneBefore();
    const u = upgradeToSchema8(content, [before]);
    expect(u.changed).toBe(true);
    expect(u.applied).toEqual(['linkPrefabCopies']);
    const after = u.scenes[0] as Any;
    const byId = new Map((after.entities as Any[]).map((e) => [e.id, e]));
    // Doors 1 to 4 and both walkers are links now; their parts are no stored objects any more.
    for (const id of ['door-1', 'door-2', 'door-3', 'door-4', 'walker-1', 'walker-2']) expect(isPrefabLink(byId.get(id).components.prefab), id).toBe(true);
    for (const id of ['leaf-1', 'sensor-1', 'leaf-2']) expect(byId.has(id), id).toBe(false);
    expect(byId.get('door-1').components.prefab).toEqual({ prefabId: 'door', partIds: { 'model-2': 'leaf-1', 'group-3': 'sensor-1' } });
    expect(byId.get('door-2').components.prefab.overrides).toEqual([
      { part: 'model-1', path: 'components/behavior/values/travel', value: 2 },
      { part: 'model-2', path: 'components/model/piece', value: 'leaf-wide' },
    ]);
    expect(byId.get('door-3')).toMatchObject({ name: 'Back door', components: { prefab: { overrides: [{ part: 'group-3', remove: true }] } } });
    expect(byId.get('walker-1').components.prefab.overrides).toEqual([{ part: 'box-1', path: 'components/patrol/waypoints', value: [[2, 0, 3]] }]);
    expect(byId.get('walker-2').components.prefab).toEqual({ prefabId: 'walker' });
    // The moved part is an object hanging from the part it was moved under, its place in the copy removed.
    expect(byId.get('door-4').components.prefab).toEqual({ prefabId: 'door', overrides: [{ part: 'group-3', remove: true }], partIds: { 'model-2': 'leaf-4' } });
    expect(byId.get('sensor-4')).toMatchObject({ parentId: 'door-4', parentPart: 'model-2', components: { prefab: { prefabId: 'door', localId: 'group-3' } } });
    // A copy with an object between its parts stays plain, as does the gone prefab's object; the lamp hangs from its part.
    expect(byId.get('door-5').components.prefab).toEqual({ prefabId: 'door', localId: 'model-1' });
    // The gone prefab's object no longer names it (a project naming a prefab it lacks does not load).
    expect(byId.get('crate-1').components).toEqual({ transform: T([3, 0, 3]), box: { size: [1, 1, 1] } });
    expect(byId.get('lamp-1')).toMatchObject({ parentId: 'door-1', parentPart: 'model-2' });
    // Nothing else changes what the scene is.
    expect(assembled(content, after)).toEqual(before.entities.map((e: Any) => (e.id === 'crate-1' ? { ...e, components: { transform: e.components.transform, box: e.components.box } } : e)));
    // One line per prefab and outcome, naming the copies.
    expect(u.notes).toEqual([
      'Prefab "crate" is gone: 1 object stays plain, no longer naming it — "crate-1" (scene "residence")',
      'Prefab "door": 3 copies keep their differences from the prefab as overrides — "door-2" (scene "residence"), "door-3" (scene "residence"), "door-4" (scene "residence")',
      'Prefab "door": 2 objects stay plain (not linked: re-arranged parts a link cannot keep, or parts outside a copy) — "door-5" (scene "residence"), "sensor-4" (scene "residence")',
      'Prefab "walker": 1 copy keeps its differences from the prefab as overrides — "walker-1" (scene "residence")',
    ]);
  });

  it('leaves a project without copies as it is', () => {
    const scene = { schemaVersion: 4, sceneId: 's', revision: 1, entities: [{ id: 'a', components: { transform: T([0, 0, 0]) } }] };
    const u = upgradeToSchema8(content, [scene]);
    expect(u).toMatchObject({ changed: false, notes: [], applied: [] });
    expect(u.scenes[0]).toBe(scene);
  });
});
