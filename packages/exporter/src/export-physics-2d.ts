/**
 * The exported game's 2D physics backend entry (`js/physics-2d.js`,
 * emitted only when the project's physics is on the 2D plane): physics-rapier's
 * port, registered on the global object for the host (`loadPhysics2D`) in the
 * page or the simulation worker. rapier2d's WASM is the file next to it
 * (`js/physics-2d.wasm`), fetched when the port starts.
 */
import { createPhysicsPort, physicsMemoryBytes, type RapierPhysicsInitConfig } from '@thirdlight/physics-rapier';
import { registerPhysics2D } from '@thirdlight/game-host/physics-global';

registerPhysics2D({ createPhysicsPort: (config) => createPhysicsPort(config as RapierPhysicsInitConfig), physicsMemoryBytes });
