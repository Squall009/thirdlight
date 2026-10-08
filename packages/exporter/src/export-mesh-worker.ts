/**
 * The exported game's view worker entry (`js/mesh-worker.js`, shipped when
 * the game has block layers or terrain): the three-adapter's block mesher,
 * terrain packer, ground cover generator and scatter set preparer on the worker's global. It loads no three.js.
 */
import { meshWorkerGlobalEndpoint, runBlockMeshWorker, runCoverWorker, runScatterWorker, runTerrainPackWorker } from '@thirdlight/three-adapter/block-mesh-worker';

// Block chunks, terrain tiles, ground cover and scatter sets: each ignores the others' messages (a page starts a worker of this script for each).
const endpoint = meshWorkerGlobalEndpoint();
runBlockMeshWorker(endpoint);
runTerrainPackWorker(endpoint);
runCoverWorker(endpoint);
runScatterWorker(endpoint);
