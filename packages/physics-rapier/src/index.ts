/**
 * `@thirdlight/physics-rapier` — the physics backend
 * (`@dimforge/rapier3d-compat@0.20.0`, decision 0007): the runtime's
 * `PhysicsPort3D` over one Rapier world per game. A side view is a plane
 * lock on bodies, not a second backend. Imports `@thirdlight/runtime` types,
 * project-model limits and the approved Rapier pin only.
 */
export {
  PHYSICS_3D_IMPLEMENTATION,
  createPhysicsPort3D,
  physicsMemoryBytes3D,
  validateColliderShape3D,
  MAX_CONVEX_POINTS_3D,
  MAX_MESH_TRIANGLES_3D,
  MAX_MESH_VERTICES_3D,
  type ColliderShape3D,
  type ColliderShapeBox3D,
  type Physics3DInitResult,
  type Rapier3DDiagnostics,
  type RapierPhysicsPort3D,
} from './port3d';
export { RAPIER_PIN } from './constants';
