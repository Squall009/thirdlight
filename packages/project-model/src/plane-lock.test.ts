/**
 * The `plane` field of the collider and controller components: an
 * axis-aligned plane (normal along world X or Z, an origin in metres) or
 * null/absent (free). Additive: a component without it keeps its canonical
 * bytes; a bad plane is a field error at its path.
 */
import { describe, expect, it } from 'vitest';

import { canonicalComponentsV3, validateSceneV4 } from './scene-v3';
import { planeLockOf } from './plane-lock';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (components: Record<string, unknown>) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [{ id: 'body-0001', components: { transform: T, ...components } }] });
const errors = (components: Record<string, unknown>): string[] => {
  const v = validateSceneV4(scene(components));
  return v.ok ? [] : v.errors.map((e) => `${e.code} ${e.path}`);
};
const BOX = { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 };

describe('the plane field', () => {
  it('a collider or a controller takes { axis: x | z, origin } or null; the canonical form keeps a plane and drops null', () => {
    expect(errors({ collider: { shape: BOX, plane: { axis: 'z', origin: 0 } } })).toEqual([]);
    expect(errors({ collider: { shape: BOX, plane: null } })).toEqual([]);
    expect(errors({ controller: { plane: { axis: 'x', origin: -3.5 } } })).toEqual([]);
    expect(canonicalComponentsV3({ transform: T, collider: { shape: BOX, plane: { origin: -0, axis: 'z' } } }).collider).toEqual({ shape: BOX, plane: { axis: 'z', origin: 0 } });
    expect(canonicalComponentsV3({ transform: T, collider: { shape: BOX, plane: null } }).collider).toEqual({ shape: BOX });
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
});
