/**
 * The exported game's simulation worker entry (`js/sim-worker.js`
 * next to `js/main.js`). The game host's worker core with the platform
 * pieces: the physics backend, loaded on first use from its own file next to
 * this one (`physics-3d.js`, so the worker does not carry the engine), and the importer for the compiled scripts
 * (`behaviors/<digest>.js`, the absolute URLs the page resolves from its own
 * location), and the game's voxel worlds: their region files read whole from
 * the export's content files (each checked against the catalog's row), and
 * their workers (`voxel-worker.js`) started from here. No DOM, no audio, no
 * storage: those stay in the page.
 */
import { sha256HexAsync } from '@thirdlight/shared';
import { loadPhysics3D, runSimWorker, shippedVoxelPorts, workerGlobalEndpoint } from '@thirdlight/game-host';
// The simulation module specs the manifest names (generated per export).
import { moduleSpecs } from 'thirdlight:export-modules';

/** A file next to this worker's script. */
const besideWorker = (name: string): string => new URL(name, (globalThis as unknown as { location: { href: string } }).location.href).href;

runSimWorker(workerGlobalEndpoint(), {
  importModule: (url) => import(/* @vite-ignore */ url),
  moduleSpecs: moduleSpecs as never,
  loadPhysics3D: () => loadPhysics3D(besideWorker('physics-3d.js')),
  // `root` is the export's folder (the page's); the worlds' files are content files under it, read by their catalog paths.
  voxelPorts: (root, worlds) =>
    shippedVoxelPorts({
      worlds,
      io: { read: (path) => fetch(new URL(path, root), { credentials: 'omit' }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${path}: HTTP ${String(r.status)}`)))), sha256Hex: sha256HexAsync },
      workerUrl: besideWorker('voxel-worker.js'),
    }),
});
