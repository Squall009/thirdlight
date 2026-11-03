/**
 * The Play preview's simulation worker entry (built to
 * `dist/preview/sim-worker.js`, served on the preview origin as
 * `/sim-worker.js`). The game host's worker core with the platform pieces:
 * the physics backend (`physics-3d.js`, loaded on first use) and the importer
 * for the project's compiled scripts (same-origin locator URLs the page hands
 * over). No DOM, no audio, no storage: those stay in the page.
 */
import { loadPhysics3D, runSimWorker, workerGlobalEndpoint } from '@thirdlight/game-host';
import { PREVIEW_MODULE_SPECS } from './module-specs';
import { playVoxelPorts } from './voxel-ports';

/** A file next to this worker's script. */
const besideWorker = (name: string): string => new URL(name, (globalThis as unknown as { location: { href: string } }).location.href).href;

runSimWorker(workerGlobalEndpoint(), {
  // The page passes each compiled script's absolute locator URL (manifest-declared paths only).
  importModule: (url) => import(/* @vite-ignore */ url),
  // The simulation module specs the manifest's modules pick from.
  moduleSpecs: PREVIEW_MODULE_SPECS,
  // The physics backend: the separate physics-3d.js next to this worker's script, loaded only for a game with physics.
  loadPhysics3D: () => loadPhysics3D(besideWorker('physics-3d.js')),
  // The play's voxel worlds: read by range under its locator, decoded and derived in module workers started from here.
  voxelPorts: (root) => playVoxelPorts(root, besideWorker('voxel-worker.js')),
});
