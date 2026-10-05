/**
 * The exported game's 3D physics backend entry (`js/physics-3d.js`,
 * emitted only when the project's `physics_dimension` is 3): physics-rapier's
 * `./3d` port, registered on the global object for the host (`loadPhysics3D`)
 * in the page or the simulation worker. rapier3d's WASM is the file next to
 * it (`js/physics-3d.wasm`), fetched when the port starts.
 */
import { createPhysicsPort3D, physicsMemoryBytes3D } from '@thirdlight/physics-rapier/3d';
import { registerPhysics3D } from '@thirdlight/game-host/physics-global';

registerPhysics3D({ createPhysicsPort3D: (config, signal) => createPhysicsPort3D(config, signal), physicsMemoryBytes3D });
