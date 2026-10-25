/**
 * The 3D collider shapes (sphere, capsule, cylinder, convex hull, triangle
 * mesh), the 3D trigger areas (box with depth, sphere, capsule), and the
 * rules that follow the project's physics dimension: 3D shapes only in a 3D
 * project, a mesh never on a mover, 2D shapes and one-way colliders taken in
 * 3D (their 3D form, given the collider's depth), a 3D
 * collider's positive (uniform for round shapes) scale, the 2D plane's unit
 * scale kept exactly, and the switch block and 2D trigger areas taken in
 * 3D (a circle is a sphere, a depthless box as deep as it is wide).
 */
import { describe, expect, it } from 'vitest';

import { validateProjectV4 } from './project-v4';
import { validateSceneV4 } from './scene-v3';
import { BLOCK_COMPONENTS, COLLIDER_3D_LIMITS } from './index';
import type { ModelErrorV2 } from './errors';

const T = (position: number[] = [0, 0, 0], scale: number[] = [1, 1, 1]) => ({ position, rotation: [0, 0, 0, 1], scale });
const MANIFEST = { schemaVersion: 8, engineVersion: '0.1.0', id: 'p', name: 'P', createdAt: '2026-09-23T00:00:00Z' };
const content = (settings: Record<string, unknown>) => ({ assets: [], prefabs: [], behaviors: [], settings, behaviorTrust: { entries: [] }, scenes: [{ sceneId: 'scene-main', name: 'Main' }], startScenes: ['scene-main'] });
const CAMERA = { id: 'cam-main', components: { transform: T([0, 2, 10]), virtualCamera: { rig: 'fixed' } } };
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
    for (const shape of [{ type: 'sphere', radius: 0.5 }, { type: 'capsule', radius: 0.5, height: 2 }, { type: 'cylinder', radius: 0.5, height: 0.2 }, HULL, MESH]) {
      const v = validateSceneV4(scene([body(shape)]));
      expect(v.ok, JSON.stringify(!v.ok && v.errors)).toBe(true);
      if (v.ok) expect(v.normalized.entities[0]!.components.collider).toEqual({ shape });
    }
  });

  it('refuses bad sizes, flat hulls, bad triangles and unknown fields', () => {
    expect(shapeErrors({ type: 'sphere', radius: 0 })).toEqual(['number_out_of_range /entities/0/components/collider/shape/radius']);
    expect(shapeErrors({ type: 'capsule', radius: 1, height: 1.5 })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape']);
    expect(shapeErrors({ type: 'capsule', radius: 1 })).toEqual(['field_missing /entities/0/components/collider/shape/height']);
    expect(shapeErrors({ type: 'cylinder', radius: 1, height: 0 })).toEqual(['number_out_of_range /entities/0/components/collider/shape/height']);
    expect(shapeErrors({ type: 'convex', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] })[0]).toMatch(/^limits_exceeded .*points$/);
    expect(shapeErrors({ type: 'convex', points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape']);
    expect(shapeErrors({ type: 'convex', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 65]] })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/points/3']);
    expect(shapeErrors({ ...MESH, triangles: [[0, 1, 4]] })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/triangles/0']);
    expect(shapeErrors({ ...MESH, triangles: [[0, 1, 1]] })).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/triangles/0']);
    expect(shapeErrors({ type: 'sphere', radius: 1, hz: 1 })).toEqual(['field_unexpected /entities/0/components/collider/shape/hz']);
    const many = Array.from({ length: COLLIDER_3D_LIMITS.convexPoints + 1 }, (_, i) => [Math.cos(i), Math.sin(i), (i % 7) / 7]);
    expect(shapeErrors({ type: 'convex', points: many })[0]).toMatch(/^limits_exceeded/);
  });

  it(`a scene keeps at most ${COLLIDER_3D_LIMITS.pointsTotal} hull points and mesh vertices in all`, () => {
    const verts = Array.from({ length: 1024 }, (_, i) => [(i % 32) - 16, 0, Math.floor(i / 32) - 16]);
    const mesh = { type: 'mesh', vertices: verts, triangles: [[0, 1, 32]] };
    const full = COLLIDER_3D_LIMITS.pointsTotal / verts.length;
    const entities = Array.from({ length: full + 1 }, (_, i) => ({ id: `mesh-${String(i).padStart(4, '0')}`, components: { transform: T([(i % 32) * 40, 0, Math.floor(i / 32) * 40]), collider: { shape: mesh } } }));
    const v = validateSceneV4(scene(entities));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.errors.map((e) => e.code)).toContain('limits_exceeded');
    expect(validateSceneV4(scene(entities.slice(0, full))).ok).toBe(true);
  }, 60_000);
});

describe('the dimension rules for 3D shapes, scale and blocks', () => {
  it('a 2D-plane project refuses the 3D shapes and keeps the unit-scale rule exactly', () => {
    for (const shape of [{ type: 'sphere', radius: 0.5 }, { type: 'capsule', radius: 0.5, height: 2 }, { type: 'cylinder', radius: 0.5, height: 1 }, HULL, MESH]) {
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

  it('a 3D project: a mesh never moves; one-way colliders, depthless boxes and polygons are taken (their 3D form)', () => {
    expect(problems(THREE, [body(MESH, { mover: { waypoints: [[1, 0, 0]], speed: 1, mode: 'loop' } })])).toEqual(['collider_shape_invalid /entities/0/components/collider/shape/type']);
    expect(problems(THREE, [body(HULL, { mover: { waypoints: [[1, 0, 0]], speed: 1, mode: 'loop' } })])).toEqual([]);
    const oneWay = { id: 'body-0001', components: { transform: T(), collider: { shape: { type: 'box', hx: 1, hy: 0.1, hz: 1 }, oneWay: true } } };
    expect(problems(THREE, [oneWay])).toEqual([]);
    expect(problems(THREE, [body({ type: 'box', hx: 1, hy: 1 })])).toEqual([]);
    expect(problems(THREE, [body({ type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]] })])).toEqual([]);
  });

  it('a collider\'s depth: positive, at most 128 m, kept in the canonical form only when set', () => {
    const withDepth = (depth: unknown) => ({ id: 'body-0001', components: { transform: T(), collider: { shape: { type: 'box', hx: 1, hy: 1 }, depth } } });
    const v = validateSceneV4(scene([withDepth(2.5)]));
    expect(v.ok && v.normalized.entities[0]!.components.collider).toEqual({ shape: { type: 'box', hx: 1, hy: 1 }, depth: 2.5 });
    const plain = validateSceneV4(scene([body({ type: 'box', hx: 1, hy: 1 })]));
    expect(plain.ok && plain.normalized.entities[0]!.components.collider).toEqual({ shape: { type: 'box', hx: 1, hy: 1 } });
    for (const bad of [0, -1, 129]) expect(validateSceneV4(scene([withDepth(bad)])).ok).toBe(false);
    expect(validateSceneV4(scene([withDepth('1')])).ok).toBe(false);
  });

  it('triggers: sphere and capsule in 3D only; 3D takes a depthless box and a circle', () => {
    const trig = (t: Record<string, unknown>) => ({ id: 'trig-0001', components: { transform: T(), trigger: { signal: 'go', ...t } } });
    expect(problems(THREE, [trig({ shape: 'sphere', radius: 1 })])).toEqual([]);
    expect(problems(THREE, [trig({ shape: 'capsule', radius: 0.5, height: 2 })])).toEqual([]);
    expect(problems(THREE, [trig({ size: [1, 2, 3] })])).toEqual([]);
    expect(problems(THREE, [trig({ size: [1, 2] })])).toEqual([]);
    expect(problems(THREE, [trig({ shape: 'circle', radius: 1 })])).toEqual([]);
    expect(problems({}, [trig({ shape: 'sphere', radius: 1 })])).toEqual(['field_value /entities/0/components/trigger/shape']);
    // A 2D plane ignores a box's depth (as it ignores a collider's hz).
    expect(problems({}, [trig({ size: [1, 2, 3] })])).toEqual([]);
  });

  it('switches work in both: [w, h] or [w, h, d]', () => {
    const e = (c: Record<string, unknown>) => ({ id: 'blk-0001', components: { transform: T(), ...c } });
    for (const size of [[1, 1], [1, 0.2, 2]]) {
      expect(problems(THREE, [e({ switch: { mode: 'stand', signal: 'open', size } })])).toEqual([]);
      expect(problems({}, [e({ switch: { mode: 'stand', signal: 'open', size } })])).toEqual([]);
    }
    const kept = validateSceneV4(scene([e({ switch: { mode: 'stand', signal: 'open', size: [1, 0.2, 2] } })]));
    expect(kept.ok && kept.normalized.entities[0]!.components.switch).toEqual({ mode: 'stand', signal: 'open', size: [1, 0.2, 2] });
    expect(problems(THREE, [e({ switch: { mode: 'stand', signal: 'open', size: [1, 1, 1, 1] } })])).toEqual(['field_value /entities/0/components/switch/size']);
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
