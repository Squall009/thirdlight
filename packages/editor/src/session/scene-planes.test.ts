import { describe, expect, it } from 'vitest';

import { bodyPlaneOf, gizmoPlaneAxis } from './scene-planes';

describe('the plane the gizmo keeps an object on', () => {
  const planes = new Map([['side', { axis: 'z' as const, origin: 0 }], ['hall', { axis: 'x' as const, origin: 4 }]]);
  it('a body takes its own plane, else its scene\'s; null frees it; no body is free', () => {
    expect(gizmoPlaneAxis({ components: { collider: { shape: { type: 'box', hx: 1, hy: 1 } } }, sceneId: 'side' }, planes)).toBe('z');
    expect(gizmoPlaneAxis({ components: { controller: {} }, sceneId: 'hall' }, planes)).toBe('x');
    expect(gizmoPlaneAxis({ components: { collider: { plane: { axis: 'x', origin: 2 } } }, sceneId: 'side' }, planes)).toBe('x');
    expect(gizmoPlaneAxis({ components: { collider: { plane: null } }, sceneId: 'side' }, planes)).toBeNull();
    expect(gizmoPlaneAxis({ components: { box: {} }, sceneId: 'side' }, planes)).toBeNull();
    expect(gizmoPlaneAxis({ components: { collider: {} }, sceneId: 'free' }, planes)).toBeNull();
    expect(gizmoPlaneAxis(undefined, planes)).toBeNull();
  });
  it('the controller decides for a character (its own capsule is the body)', () => {
    expect(bodyPlaneOf({ controller: { plane: { axis: 'x', origin: 0 } }, collider: {} }, { axis: 'z', origin: 0 })).toEqual({ axis: 'x', origin: 0 });
  });
});
