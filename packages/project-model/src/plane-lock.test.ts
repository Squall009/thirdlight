/**
 * The `plane` field of the collider and controller components: an
 * axis-aligned plane (normal along world X or Z, an origin in metres), null
 * (free) or absent (the scene's default plane, else free). Additive: a
 * component without it keeps its canonical bytes; a bad plane is a field
 * error at its path. A scene's `defaultPlane` and how its bodies take it.
 */
import { describe, expect, it } from 'vitest';

import { canonicalComponentsV3, validateSceneV4 } from './scene-v3';
import { effectivePlaneOf, planeLockOf, withScenePlane } from './plane-lock';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (components: Record<string, unknown>) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [{ id: 'body-0001', components: { transform: T, ...components } }] });
const errors = (components: Record<string, unknown>): string[] => {
  const v = validateSceneV4(scene(components));
  return v.ok ? [] : v.errors.map((e) => `${e.code} ${e.path}`);
};
const BOX = { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 };

describe('the plane field', () => {
  it('a collider or a controller takes { axis: x | z, origin } or null; the canonical form keeps both', () => {
    expect(errors({ collider: { shape: BOX, plane: { axis: 'z', origin: 0 } } })).toEqual([]);
    expect(errors({ collider: { shape: BOX, plane: null } })).toEqual([]);
    expect(errors({ controller: { plane: { axis: 'x', origin: -3.5 } } })).toEqual([]);
    expect(canonicalComponentsV3({ transform: T, collider: { shape: BOX, plane: { origin: -0, axis: 'z' } } }).collider).toEqual({ shape: BOX, plane: { axis: 'z', origin: 0 } });
    expect(canonicalComponentsV3({ transform: T, collider: { shape: BOX, plane: null } }).collider).toEqual({ shape: BOX, plane: null });
    expect(canonicalComponentsV3({ transform: T, controller: { plane: null } }).controller).toEqual({ plane: null });
    expect(canonicalComponentsV3({ transform: T, controller: { plane: { axis: 'x', origin: 2 } } }).controller).toEqual({ plane: { axis: 'x', origin: 2 } });
    expect(canonicalComponentsV3({ transform: T, controller: {} }).controller).toEqual({});
  });

  it('refuses a plane through Y, a missing or unbounded origin and extra fields, at their paths', () => {
    expect(errors({ collider: { shape: BOX, plane: { axis: 'y', origin: 0 } } })).toEqual(['field_value /entities/0/components/collider/plane/axis']);
    expect(errors({ collider: { shape: BOX, plane: { axis: 'z' } } })).toEqual(['field_missing /entities/0/components/collider/plane/origin']);
    expect(errors({ controller: { plane: { axis: 'z', origin: 1e9 } } })).toEqual(['field_value /entities/0/components/controller/plane/origin']);
    expect(errors({ controller: { plane: { axis: 'z', origin: 0, normal: [0, 0, 1] } } })).toEqual(['field_unexpected /entities/0/components/controller/plane/normal']);
    expect(errors({ collider: { shape: BOX, plane: 'z' } })).toEqual(['field_type /entities/0/components/collider/plane']);
  });

  it('reads a component plane, or null for none or a bad one', () => {
    expect(planeLockOf({ plane: { axis: 'z', origin: 1 } })).toEqual({ axis: 'z', origin: 1 });
    expect(planeLockOf({ plane: null })).toBeNull();
    expect(planeLockOf({ plane: { axis: 'y', origin: 1 } })).toBeNull();
    expect(planeLockOf(undefined)).toBeNull();
  });

  it("a scene's default plane: valid and canonical, refused when not a plane", () => {
    const doc = (defaultPlane: unknown) => ({ ...scene({ collider: { shape: BOX } }), defaultPlane });
    const v = validateSceneV4(doc({ origin: -0, axis: 'x' }));
    expect(v.ok && v.normalized.defaultPlane).toEqual({ axis: 'x', origin: 0 });
    expect(validateSceneV4(doc({ axis: 'y', origin: 0 })).ok).toBe(false);
    expect(validateSceneV4(doc(null)).ok).toBe(false);
  });

  it("bodies without a plane of their own take the scene's; null stays free; other objects are untouched", () => {
    const Z = { axis: 'z', origin: 0.5 };
    const list = [
      { id: 'a', components: { collider: { shape: BOX } } },
      { id: 'b', components: { controller: {} } },
      { id: 'c', components: { collider: { shape: BOX, plane: null } } },
      { id: 'd', components: { collider: { shape: BOX, plane: { axis: 'x', origin: 1 } } } },
      { id: 'e', components: { box: {} } },
    ];
    const out = withScenePlane(list, Z);
    const planeOf = (e: { components: Record<string, unknown> }): unknown => ((e.components['collider'] ?? e.components['controller']) as { plane?: unknown } | undefined)?.plane;
    expect(out.map(planeOf)).toEqual([Z, Z, null, { axis: 'x', origin: 1 }, undefined]);
    expect(out[4]).toBe(list[4]);
    expect(withScenePlane(list, undefined)).toBe(list);
    expect(effectivePlaneOf({}, Z as never)).toEqual(Z);
    expect(effectivePlaneOf({ plane: null }, Z as never)).toBeNull();
  });
});
