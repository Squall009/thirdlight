/**
 * Phase 22.0: the Play preview's simulation worker entry (built to
 * `dist/preview/sim-worker.js`, served on the preview origin as
 * `/sim-worker.js`). The game host's worker core with the platform pieces:
 * physics-rapier (its WASM is inside this bundle — no fetch) and the importer
 * for the project's compiled scripts (same-origin locator URLs the page hands
 * over). No DOM, no audio, no storage: those stay in the page.
 */
import { createPhysicsPort, physicsMemoryBytes, type RapierPhysicsInitConfig } from '@thirdlight/physics-rapier';
import { loadPhysics3D, runSimWorker, workerGlobalEndpoint } from '@thirdlight/game-host';

runSimWorker(workerGlobalEndpoint(), {
  createPhysicsPort: (config) => createPhysicsPort(config as RapierPhysicsInitConfig),
  // The page passes each compiled script's absolute locator URL (manifest-declared paths only).
  importModule: (url) => import(/* @vite-ignore */ url),
  physicsMemoryBytes,
  // Phase 23.0: a 3D project's backend — the separate physics-3d.js next to this worker's script, loaded only then.
  loadPhysics3D: () => loadPhysics3D(new URL('physics-3d.js', (globalThis as unknown as { location: { href: string } }).location.href).href),
});
