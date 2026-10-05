/**
 * The exported game's block mesh worker entry (`js/mesh-worker.js`, shipped
 * when the game has block layers): the three-adapter's worker core on the
 * worker's global. It loads no three.js.
 */
import { meshWorkerGlobalEndpoint, runBlockMeshWorker } from '@thirdlight/three-adapter/block-mesh-worker';

runBlockMeshWorker(meshWorkerGlobalEndpoint());
