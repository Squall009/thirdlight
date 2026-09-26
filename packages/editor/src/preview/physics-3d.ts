/**
 * Phase 23.0: the Play preview's 3D physics backend entry (built to
 * `dist/preview/physics-3d.js`, served on the preview origin as
 * `/physics-3d.js`): physics-rapier's `./3d` port with rapier3d's inlined
 * WASM, registered on the global object for the host (`loadPhysics3D`) — a
 * separate script so only a project whose `physics_dimension` is 3 loads it,
 * in the page (single thread) or in the simulation worker.
 */
import { createPhysicsPort3D, physicsMemoryBytes3D } from '@thirdlight/physics-rapier/3d';
import { registerPhysics3D } from '@thirdlight/game-host/physics-3d-global';

registerPhysics3D({ createPhysicsPort3D: (config, signal) => createPhysicsPort3D(config, signal), physicsMemoryBytes3D });
