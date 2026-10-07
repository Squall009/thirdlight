/**
 * The view worker's entry (bundled to dist/editor/mesh-worker.js for the
 * Scene view and dist/preview/mesh-worker.js for Play): the three-adapter's
 * block mesher, terrain packer and ground cover generator on the worker's global. It loads no
 * three.js.
 */
import { meshWorkerGlobalEndpoint, runBlockMeshWorker, runCoverWorker, runTerrainPackWorker } from '@thirdlight/three-adapter/block-mesh-worker';

// Block chunks, terrain tiles and ground cover: each ignores the others' messages (a page starts a worker of this script for each).
const endpoint = meshWorkerGlobalEndpoint();
runBlockMeshWorker(endpoint);
runTerrainPackWorker(endpoint);
runCoverWorker(endpoint);
