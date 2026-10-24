/**
 * A v4 prefab definition may carry the gameplay components a
 * spawned or placed copy needs (collider, collectible, patrol, hitbox,
 * health, mover, trigger, switch, surface, materials, animator, audio source, face movement); v3
 * content keeps the transform/model/box/behavior vocabulary; the canonical
 * form keeps every new field.
 */
import { describe, expect, it } from 'vitest';

import { canonicalPrefabs, validatePrefabDefinitions } from './content';
import type { ModelErrorV2 } from './errors';
import { REMOVED_COMPONENTS } from './removed-game-data';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const def = (components: Record<string, unknown>, extra: Record<string, unknown>[] = [], prefabId = 'thing') => ({
  prefabId,
  displayName: 'Thing',
  createdRevision: 1,
  entityCount: 1 + extra.length,
  depth: extra.length > 0 ? 2 : 1,
  entities: [{ localId: 'box-0001', components: { transform: T, box: { size: [1, 1, 1], material: { color: '#ffffff' } }, ...components } }, ...extra],
});
const errorsOf = (value: unknown, version: 3 | 4 = 4): ModelErrorV2[] => {
  const errors: ModelErrorV2[] = [];
  validatePrefabDefinitions(value, '/prefabs', errors, version);
  return errors;
};
const codes = (value: unknown, version: 3 | 4 = 4): string[] => errorsOf(value, version).map((e) => e.code);

describe('v4 prefab components', () => {
  it('accepts gameplay components in v4 and refuses them in v3', () => {
    const good = [
      def({ collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true } }),
      def({ collectible: { counter: 'items', amount: 1 } }),
      def({ patrol: { mode: 'edges', speed: 1, size: [1, 1] }, hitbox: { size: [1, 1], damage: 1 }, health: { max: 1 } }),
      def({ mover: { waypoints: [[4, 0, 0]], speed: 2, mode: 'once' } }),
      def({ trigger: { size: [2, 2], signal: 'hit' } }),
      def({ surface: { color: '#ff0000' } }),
    ];
    for (const d of good) expect(errorsOf([d]), JSON.stringify(d.entities[0]!.components)).toEqual([]);
    expect(codes([good[0]], 3)).toContain('component_unknown');
  });

  it('holds what a scene object can: a player with its camera, a light, a spawn', () => {
    const camera = { localId: 'group-0002', parentLocalId: 'box-0001', components: { transform: T, virtualCamera: { rig: 'follow', target: 'box-0001' } } };
    const lamp = { localId: 'group-0003', parentLocalId: 'box-0001', components: { transform: T, light: { type: 'point', color: '#ffffff', intensity: 2, range: 5 } } };
    expect(errorsOf([def({ controller: {} }, [camera, lamp])])).toEqual([]);
    expect(errorsOf([def({ playerSpawn: {} })])).toEqual([]);
    // The scene's own rules hold: a player character is a root; a spawn is a marker.
    expect(codes([def({}, [{ ...camera, components: { transform: T, controller: {} } }])])).toContain('physics_transform_unsupported');
    expect(codes([def({ playerSpawn: {}, controller: {} })])).toContain('component_conflict');
  });

  it('refuses what the scene itself holds', () => {
    for (const [name, value] of [['blockLayer', { cellSize: 1 }], ['instances', { asset: { assetId: 'a' }, buffer: 'b', count: 1 }], ['folder', {}]] as const) {
      expect(codes([def({ [name]: value })]), name).toContain('prefab_component_forbidden');
    }
  });

  it('keeps the scene rules: scene-only components, a parented mover collider, a patrol with a collider, bad values', () => {
    // The removed game components are unknown in a prefab too.
    for (const name of Object.keys(REMOVED_COMPONENTS)) expect(codes([def({ [name]: { size: [1, 1] } })]), name).toContain('component_unknown');
    // An older project's scene camera is gone from scenes, and so from prefabs.
    expect(errorsOf([def({ camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } })]).length).toBeGreaterThan(0);
    // A collider on a child follows it; a mover's collider stays a root (its system poses it in world space).
    const child = { localId: 'box-0002', parentLocalId: 'box-0001', components: { transform: T, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } };
    expect(codes([def({}, [child])])).not.toContain('physics_transform_unsupported');
    const moving = { ...child, components: { ...child.components, mover: { waypoints: [[0, 0, 0], [1, 0, 0]], speed: 1 } } };
    expect(codes([def({}, [moving])])).toContain('physics_transform_unsupported');
    expect(codes([def({ collider: { shape: { type: 'box', hx: 1, hy: 1 } }, patrol: { mode: 'edges', speed: 1, size: [1, 1] } })])).toContain('component_conflict');
    expect(errorsOf([def({ collectible: { counter: '9 items' } })]).length).toBeGreaterThan(0);
    expect(codes([def({ animator: { controller: 'anim' } })])).toContain('component_missing'); // an animator needs a model
    expect(codes([def({}), def({})])).toContain('id_duplicate');
  });

  it('the canonical form keeps every gameplay field', () => {
    const d = def({ collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true }, collectible: { counter: 'items', amount: 2, size: [0.5, 0.5] }, surface: { color: '#FF0000' } });
    expect(errorsOf([d])).toEqual([]);
    const [c] = canonicalPrefabs([d as never]);
    const comps = c!.entities[0]!.components as unknown as Record<string, unknown>;
    expect(comps['collider']).toEqual({ shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true });
    expect(comps['collectible']).toMatchObject({ counter: 'items', amount: 2, size: [0.5, 0.5] });
    expect((comps['surface'] as { color: string }).color).toBe('#ff0000');
  });

  it('an object\'s tag mask is kept (a 32-bit mask; zero is not stored)', () => {
    const tagged = { ...def({}), entities: [{ ...def({}).entities[0]!, tags: 0x80000001 }] };
    expect(errorsOf([tagged])).toEqual([]);
    expect(canonicalPrefabs([tagged as never])[0]!.entities[0]!.tags).toBe(0x80000001);
    expect('tags' in canonicalPrefabs([{ ...tagged, entities: [{ ...tagged.entities[0]!, tags: 0 }] } as never])[0]!.entities[0]!).toBe(false);
    for (const bad of [-1, 1.5, 2 ** 32, 'harmful']) expect(errorsOf([{ ...tagged, entities: [{ ...tagged.entities[0]!, tags: bad }] }]).map((e) => e.path)).toContain('/prefabs/0/entities/0/tags');
  });
});
