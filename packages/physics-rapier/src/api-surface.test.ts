/**
 * The package's public surface: exactly the port factory, its memory probe,
 * the shape validator, the shape limits and the approved pin (a 2D entry or
 * a second engine never comes back unnoticed).
 */
import { describe, expect, it } from 'vitest';

import * as physicsRapier from './index';

describe('public exports', () => {
  it('exports exactly the contracted value surface', () => {
    expect(Object.keys(physicsRapier).sort()).toEqual([
      'MAX_CONVEX_POINTS_3D',
      'MAX_MESH_TRIANGLES_3D',
      'MAX_MESH_VERTICES_3D',
      'PHYSICS_3D_IMPLEMENTATION',
      'RAPIER_PIN',
      'createPhysicsPort3D',
      'physicsMemoryBytes3D',
      'validateColliderShape3D',
    ]);
  });

  it('carries the approved pin and implementation identity', () => {
    expect(physicsRapier.RAPIER_PIN).toBe('0.20.0');
    expect(physicsRapier.PHYSICS_3D_IMPLEMENTATION).toBe('rapier3d-compat@0.20.0');
  });
});
