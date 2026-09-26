/**
 * Phase 22.0: the simulation worker entry for Node (worker_threads) — the same
 * game-host worker core the browser bundles run, over `parentPort`. The
 * integration harness bundles this file with esbuild and starts it with
 * `new Worker(code, { eval: true })`.
 */
import { parentPort } from 'node:worker_threads';

import { runSimWorker } from '@thirdlight/game-host';
import { createPhysicsPort, physicsMemoryBytes } from '@thirdlight/physics-rapier';

const port = parentPort;
if (port === null) throw new Error('node-worker.ts must run in a worker thread');
runSimWorker(
  {
    post: (message, transfer) => port.postMessage(message, (transfer ?? []) as never),
    listen: (onMessage) => port.on('message', onMessage),
  },
  {
    createPhysicsPort: (config) => createPhysicsPort(config as never),
    importModule: (url) => import(/* @vite-ignore */ url),
    physicsMemoryBytes,
    // Phase 23.0: the 3D backend (bundled in here; a browser worker loads physics-3d.js instead).
    loadPhysics3D: async () => {
      const m = await import('@thirdlight/physics-rapier/3d');
      return { createPhysicsPort3D: (config) => m.createPhysicsPort3D(config), physicsMemoryBytes3D: m.physicsMemoryBytes3D };
    },
  },
);
