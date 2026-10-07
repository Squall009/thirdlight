/**
 * The view worker's entry (bundled to dist/editor/mesh-worker.js for the
 * Scene view and dist/preview/mesh-worker.js for Play): the three-adapter's
 * block mesher and terrain packer on the worker's global. It loads no
 * three.js.
 */
import { meshWorkerGlobalEndpoint, runBlockMeshWorker, runTerrainPackWorker } from '@thirdlight/three-adapter/block-mesh-worker';

// Block chunks and terrain tiles: each ignores the other's messages (a page starts a worker of this script for each).
const endpoint = meshWorkerGlobalEndpoint();
runBlockMeshWorker(endpoint);
runTerrainPackWorker(endpoint);
