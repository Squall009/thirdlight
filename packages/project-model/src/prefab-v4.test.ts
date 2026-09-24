/**
 * Phase 14.1: a v4 prefab definition may carry the gameplay components a
 * spawned or placed copy needs (collider, pickup, enemy, mover, trigger,
 * switch, surface, materials, animator, audio source, face movement); v3
 * content keeps the transform/model/box/behavior vocabulary; the canonical
 * form keeps every new field.
 */
import { describe, expect, it } from 'vitest';

import { canonicalPrefabs, validatePrefabDefinitions } from './content';
import type { ModelErrorV2 } from './errors';

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

describe('v4 prefab components (phase 14.1)', () => {
  it('accepts gameplay components in v4 and refuses them in v3', () => {
    const good = [
      def({ collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true } }),
      def({ pickup: { kind: 'coin', value: 1 } }),
      def({ enemy: { patrol: 'edges', speed: 1, size: [1, 1], contactDamage: 1, stompable: true, health: 1 } }),
      def({ mover: { waypoints: [[4, 0, 0]], speed: 2, mode: 'once' } }),
      def({ trigger: { size: [2, 2], signal: 'hit' } }),
      def({ surface: { color: '#ff0000' } }),
    ];
    for (const d of good) expect(errorsOf([d]), JSON.stringify(d.entities[0]!.components)).toEqual([]);
    expect(codes([good[0]], 3)).toContain('component_unknown');
  });

  it('keeps the scene rules: scene-only components, a parented collider, an enemy with a collider, bad values', () => {
    expect(codes([def({ controller: {} })])).toContain('component_unknown');
    expect(codes([def({ gameZone: { role: 'hazard', size: [1, 1] } })])).toContain('component_unknown');
    expect(codes([def({ camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } })])).toContain('prefab_component_forbidden');
    const child = { localId: 'box-0002', parentLocalId: 'box-0001', components: { transform: T, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } };
    expect(codes([def({}, [child])])).toContain('physics_transform_unsupported');
    expect(codes([def({ collider: { shape: { type: 'box', hx: 1, hy: 1 } }, enemy: { patrol: 'edges', speed: 1, size: [1, 1], contactDamage: 1, stompable: true, health: 1 } })])).toContain('component_conflict');
    expect(errorsOf([def({ pickup: { kind: 'coin', value: -3 } })]).length).toBeGreaterThan(0);
    expect(codes([def({ animator: { controller: 'anim' } })])).toContain('component_missing'); // an animator needs a model
    expect(codes([def({}), def({})])).toContain('id_duplicate');
  });

  it('the canonical form keeps every gameplay field', () => {
    const d = def({ collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true }, pickup: { kind: 'coin', value: 2, size: [0.5, 0.5] }, surface: { color: '#FF0000' } });
    expect(errorsOf([d])).toEqual([]);
    const [c] = canonicalPrefabs([d as never]);
    const comps = c!.entities[0]!.components as unknown as Record<string, unknown>;
    expect(comps['collider']).toEqual({ shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true });
    expect(comps['pickup']).toMatchObject({ kind: 'coin', value: 2, size: [0.5, 0.5] });
    expect((comps['surface'] as { color: string }).color).toBe('#ff0000');
  });
});
