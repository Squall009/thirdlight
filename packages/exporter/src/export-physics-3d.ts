/**
 * Phase 23.0: the exported game's 3D physics backend entry (`js/physics-3d.js`,
 * emitted only when the project's `physics_dimension` is 3): physics-rapier's
 * `./3d` port with rapier3d's inlined WASM (no fetch, no URL), registered on
 * the global object for the host (`loadPhysics3D`) in the page or the
 * simulation worker.
 */
import { createPhysicsPort3D, physicsMemoryBytes3D } from '@thirdlight/physics-rapier/3d';
import { registerPhysics3D } from '@thirdlight/game-host/physics-3d-global';

registerPhysics3D({ createPhysicsPort3D: (config, signal) => createPhysicsPort3D(config, signal), physicsMemoryBytes3D });
