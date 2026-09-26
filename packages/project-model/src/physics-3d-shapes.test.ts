/**
 * Phase 23.1: the 3D collider shapes (sphere, capsule, convex hull, triangle
 * mesh), the 3D trigger areas (box with depth, sphere, capsule), and the
 * rules that follow the project's physics dimension: 3D shapes only in a 3D
 * project, a mesh never on a mover, no one-way collider in 3D, a 3D
 * collider's positive (uniform for round shapes) scale, the 2D plane's unit
 * scale kept exactly, and the 2D-plane blocks (switch, pickup, enemy)
 * refused in 3D.
 */
import { describe, expect, it } from 'vitest';

import { validateProjectV4 } from './project-v4';
import { validateSceneV4 } from './scene-v3';
import { BLOCK_COMPONENTS, COLLIDER_3D_LIMITS } from './index';
import type { ModelErrorV2 } from './errors';

const T = (position: number[] = [0, 0, 0], scale: number[] = [1, 1, 1]) => ({ position, rotation: [0, 0, 0, 1], scale });
const MANIFEST = { schemaVersion: 2, engineVersion: '0.1.0', id: 'p', name: 'P', createdAt: '2026-09-23T00:00:00Z' };
const content = (settings: Record<string, unknown>) => ({ assets: [], prefabs: [], behaviors: [], settings, behaviorTrust: { entries: [] }, game: null, scenes: [{ sceneId: 'scene-main', name: 'Main' }], startScenes: ['scene-main'] });
const CAMERA = { id: 'cam-main', components: { transform: T([0, 2, 10]), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities });
const body = (shape: unknown, extra: Record<string, unknown> = {}, scale?: number[]) => ({ id: 'body-0001', components: { transform: T([0, 0, 0], scale), collider: { shape }, ...extra } });
const THREE = { physics_dimension: 3 };
const HULL = { type: 'convex', points: [[-1, -1, -1], [1, -1, -1], [0, 1, -1], [0, 0, 1]] };
const MESH = { type: 'mesh', vertices: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], triangles: [[0, 2, 1], [0, 3, 2]] };

function problems(settings: Record<string, unknown>, entities: unknown[]): string[] {
  const r = validateProjectV4(MANIFEST, content(settings), [scene([...entities, CAMERA])]);
  return r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`);
}
const shapeErrors = (shape: unknown): string[] => {
  const v = validateSceneV4(scene([body(shape)]));
  return v.ok ? [] : v.errors.map((e) => `${e.code} ${e.path}`);
};

describe('3D collider shapes (validation and canonical form)', () => {
  it('accepts a sphere, a capsule, a convex hull and a mesh; the canonical form keeps them', () => {
    for (const shape of [{ type: 'sphere', radius: 0.5 }, { type: 'capsule', radius: 0.5, height: 2 }, HULL, MESH]) {
      const v = validateSceneV4(scene([body(shape)]));
      expect(v.ok, JSON.stringify(!v.ok && v.errors)).toBe(true);
      if (v.ok) expect(v.normalized.entities[0]!.components.collider).toEqual({ shape });
    }
  });

  it('refuses bad sizes, flat hulls, bad triangles and unknown fields', () => {
    expect(shapeErrors({ type: 'sphere', radius: 0 })).toEqual(['number_out_of_range /entities/0/components/collider/shape/radius']);
    expect(shapeErrors({ type: 'capsule', radius: 1, height: 1.5 })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape']);
    expect(shapeErrors({ type: 'capsule', radius: 1 })).toEqual(['field_missing /entities/0/components/collider/shape/height']);
    expect(shapeErrors({ type: 'convex', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] })[0]).toMatch(/^limits_exceeded .*points$/);
    expect(shapeErrors({ type: 'convex', points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape']);
    expect(shapeErrors({ type: 'convex', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 65]] })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/points/3']);
    expect(shapeErrors({ ...MESH, triangles: [[0, 1, 4]] })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/triangles/0']);
    expect(shapeErrors({ ...MESH, triangles: [[0, 1, 1]] })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/triangles/0']);
    expect(shapeErrors({ type: 'sphere', radius: 1, hz: 1 })).toEqual(['field_unexpected /entities/0/components/collider/shape/hz']);
    const many = Array.from({ length: COLLIDER_3D_LIMITS.convexPoints + 1 }, (_, i) => [Math.cos(i), Math.sin(i), (i % 7) / 7]);
    expect(shapeErrors({ type: 'convex', points: many })[0]).toMatch(/^limits_exceeded/);
  });

  it('a scene keeps at most 32,768 hull points and mesh vertices in all', () => {
    const verts = Array.from({ length: 1024 }, (_, i) => [(i % 32) - 16, 0, Math.floor(i / 32) - 16]);
    const mesh = { type: 'mesh', vertices: verts, triangles: [[0, 1, 32]] };
    const entities = Array.from({ length: 33 }, (_, i) => ({ id: `mesh-${String(i).padStart(4, '0')}`, components: { transform: T([i * 40, 0, 0]), collider: { shape: mesh } } }));
    const v = validateSceneV4(scene(entities));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.errors.map((e) => e.code)).toContain('limits_exceeded');
    expect(validateSceneV4(scene(entities.slice(0, 32))).ok).toBe(true);
  });
});

describe('the dimension rules for 3D shapes, scale and blocks', () => {
  it('a 2D-plane project refuses the 3D shapes and keeps the unit-scale rule exactly', () => {
    for (const shape of [{ type: 'sphere', radius: 0.5 }, { type: 'capsule', radius: 0.5, height: 2 }, HULL, MESH]) {
      expect(problems({}, [body(shape)])).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/type']);
    }
    expect(problems({}, [body({ type: 'box', hx: 1, hy: 1 }, {}, [2, 1, 1])])).toEqual(['physics_transform_unsupported /entities/0/transform/scale']);
  });

  it('a 3D project: boxes, hulls and meshes take any positive scale, spheres and capsules a uniform one; controllers stay at unit scale', () => {
    expect(problems(THREE, [body({ type: 'box', hx: 1, hy: 1, hz: 1 }, {}, [2, 0.5, 3])])).toEqual([]);
    expect(problems(THREE, [body(HULL, {}, [2, 1, 1])])).toEqual([]);
    expect(problems(THREE, [body(MESH, {}, [4, 1, 4])])).toEqual([]);
    expect(problems(THREE, [body({ type: 'sphere', radius: 0.5 }, {}, [2, 2, 2])])).toEqual([]);
    expect(problems(THREE, [body({ type: 'sphere', radius: 0.5 }, {}, [2, 1, 2])])).toEqual(['physics_transform_unsupported /entities/0/transform/scale']);
    expect(problems(THREE, [body({ type: 'capsule', radius: 0.5, height: 2 }, {}, [1, 2, 1])])).toEqual(['physics_transform_unsupported /entities/0/transform/scale']);
    const player = { id: 'player-0001', components: { transform: T([0, 2, 0], [2, 2, 2]), controller: {} } };
    expect(problems(THREE, [player])).toEqual(['physics_transform_unsupported /entities/0/transform/scale']);
  });

  it('a 3D project: a mesh never moves, no one-way colliders', () => {
    expect(problems(THREE, [body(MESH, { mover: { waypoints: [[1, 0, 0]], speed: 1, mode: 'loop' } })])).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/type']);
    expect(problems(THREE, [body(HULL, { mover: { waypoints: [[1, 0, 0]], speed: 1, mode: 'loop' } })])).toEqual([]);
    const oneWay = { id: 'body-0001', components: { transform: T(), collider: { shape: { type: 'box', hx: 1, hy: 0.1, hz: 1 }, oneWay: true } } };
    expect(problems(THREE, [oneWay])).toEqual(['collider_shape_invalid /entities/0/components/collider/oneWay']);
  });

  it('triggers: sphere and capsule in 3D only; in 3D a box needs its depth and a circle is refused', () => {
    const trig = (t: Record<string, unknown>) => ({ id: 'trig-0001', components: { transform: T(), trigger: { signal: 'go', ...t } } });
    expect(problems(THREE, [trig({ shape: 'sphere', radius: 1 })])).toEqual([]);
    expect(problems(THREE, [trig({ shape: 'capsule', radius: 0.5, height: 2 })])).toEqual([]);
    expect(problems(THREE, [trig({ size: [1, 2, 3] })])).toEqual([]);
    expect(problems(THREE, [trig({ size: [1, 2] })])).toEqual(['field_value /entities/0/components/trigger/size']);
    expect(problems(THREE, [trig({ shape: 'circle', radius: 1 })])).toEqual(['field_value /entities/0/components/trigger/shape']);
    expect(problems({}, [trig({ shape: 'sphere', radius: 1 })])).toEqual(['field_value /entities/0/components/trigger/shape']);
    // A 2D plane ignores a box's depth (as it ignores a collider's hz).
    expect(problems({}, [trig({ size: [1, 2, 3] })])).toEqual([]);
  });

  it('switches, pickups and enemies are 2D-plane blocks: refused in a 3D project', () => {
    const e = (c: Record<string, unknown>) => ({ id: 'blk-0001', components: { transform: T(), ...c } });
    expect(problems(THREE, [e({ switch: { mode: 'stand', signal: 'open', size: [1, 1] } })])).toEqual(['component_conflict /entities/0/components/switch']);
    expect(problems(THREE, [e({ pickup: { kind: 'coin', value: 1 } })])).toEqual(['component_conflict /entities/0/components/pickup']);
    expect(problems({}, [e({ pickup: { kind: 'coin', value: 1 } })])).toEqual([]);
  });

  it('trigger component: a capsule needs a height of at least twice its radius; only a capsule has a height', () => {
    const check = (v: unknown): string[] => {
      const errors: ModelErrorV2[] = [];
      BLOCK_COMPONENTS.trigger.validate(v, '/t', errors);
      return errors.map((x) => `${x.code} ${x.path}`);
    };
    expect(check({ shape: 'capsule', radius: 0.5, height: 2, signal: 'go' })).toEqual([]);
    expect(check({ shape: 'capsule', radius: 0.5, signal: 'go' })).toEqual(['field_missing /t/height']);
    expect(check({ shape: 'capsule', radius: 1, height: 1, signal: 'go' })).toEqual(['field_value /t/height']);
    expect(check({ shape: 'sphere', radius: 1, height: 2, signal: 'go' })).toEqual(['field_unexpected /t/height']);
    expect(check({ shape: 'sphere', size: [1, 1], radius: 1, signal: 'go' })).toEqual(['field_unexpected /t/size']);
    expect(BLOCK_COMPONENTS.trigger.canonical({ size: [1, 2, 3], signal: 'go' })).toEqual({ size: [1, 2, 3], signal: 'go' });
    expect(JSON.stringify(BLOCK_COMPONENTS.trigger.canonical({ height: 2, radius: 0.5, shape: 'capsule', signal: 'go' } as never))).toBe('{"signal":"go","shape":"capsule","radius":0.5,"height":2}');
  });
});
