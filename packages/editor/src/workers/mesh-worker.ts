/**
 * The block mesh worker's entry (bundled to dist/editor/mesh-worker.js for
 * the Scene view and dist/preview/mesh-worker.js for Play): the three-adapter's
 * worker core on the worker's global. It loads no three.js.
 */
import { meshWorkerGlobalEndpoint, runBlockMeshWorker } from '@thirdlight/three-adapter/block-mesh-worker';

runBlockMeshWorker(meshWorkerGlobalEndpoint());
