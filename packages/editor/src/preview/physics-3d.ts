/**
 * The Play preview's physics backend entry (built to
 * `dist/preview/physics-3d.js`, served on the preview origin as
 * `/physics-3d.js`): physics-rapier's port with rapier3d's inlined WASM,
 * registered on the global object for the host (`loadPhysics3D`) — a
 * separate script so only a game that needs physics loads it, in the page
 * (single thread) or in the simulation worker.
 */
import { createPhysicsPort3D, physicsMemoryBytes3D } from '@thirdlight/physics-rapier';
import { registerPhysics3D } from '@thirdlight/game-host/physics-global';

registerPhysics3D({ createPhysicsPort3D: (config, signal) => createPhysicsPort3D(config, signal), physicsMemoryBytes3D });
