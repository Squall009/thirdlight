/**
 * The exported game's simulation worker entry (`js/sim-worker.js`
 * next to `js/main.js`). The game host's worker core with the platform
 * pieces: the physics backend the project uses, loaded on first use from its
 * own file next to this one (`physics-2d.js` or `physics-3d.js`, so the
 * worker carries neither engine), and the importer for the compiled scripts
 * (`behaviors/<digest>.js`, the absolute URLs the page resolves from its own
 * location). No DOM, no audio, no storage: those stay in the page.
 */
import { loadPhysics2D, loadPhysics3D, runSimWorker, workerGlobalEndpoint } from '@thirdlight/game-host';
// The simulation module specs the manifest names (generated per export).
import { moduleSpecs } from 'thirdlight:export-modules';

/** A file next to this worker's script. */
const besideWorker = (name: string): string => new URL(name, (globalThis as unknown as { location: { href: string } }).location.href).href;

runSimWorker(workerGlobalEndpoint(), {
  importModule: (url) => import(/* @vite-ignore */ url),
  moduleSpecs: moduleSpecs as never,
  loadPhysics2D: () => loadPhysics2D(besideWorker('physics-2d.js')),
  loadPhysics3D: () => loadPhysics3D(besideWorker('physics-3d.js')),
});
