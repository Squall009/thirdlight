/**
 * `@thirdlight/physics-rapier/3d` — phase 23.0: the 3D backend
 * (`@dimforge/rapier3d-compat@0.20.0`, the 2D pin's version) for a project
 * whose `physics_dimension` is 3. A separate subpath so a 2D project's
 * preview and export bundles never carry the 3D WASM (decision 0005). It
 * implements the runtime's `PhysicsPort3D`; the 2D entry (`.`) is unchanged.
 */
export {
  PHYSICS_3D_IMPLEMENTATION,
  createPhysicsPort3D,
  physicsMemoryBytes3D,
  validateColliderShape3D,
  type ColliderShapeBox3D,
  type Physics3DInitResult,
  type Rapier3DDiagnostics,
  type RapierPhysicsPort3D,
} from './port3d';
export { RAPIER_PIN } from '../constants';
