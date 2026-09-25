/**
 * Phase 22.0: the exported game's simulation worker entry (`js/sim-worker.js`
 * next to `js/main.js`). The game host's worker core with the platform
 * pieces: physics-rapier (its WASM is inside this bundle — no fetch, no URL)
 * and the importer for the compiled scripts (`behaviors/<digest>.js`, the
 * absolute URLs the page resolves from its own location). No DOM, no audio,
 * no storage: those stay in the page.
 */
import { createPhysicsPort, physicsMemoryBytes, type RapierPhysicsInitConfig } from '@thirdlight/physics-rapier';
import { runSimWorker, workerGlobalEndpoint } from '@thirdlight/game-host';

runSimWorker(workerGlobalEndpoint(), {
  createPhysicsPort: (config) => createPhysicsPort(config as RapierPhysicsInitConfig),
  importModule: (url) => import(/* @vite-ignore */ url),
  physicsMemoryBytes,
});
