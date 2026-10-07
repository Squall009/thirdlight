/**
 * The exported game's view worker entry (`js/mesh-worker.js`, shipped when
 * the game has block layers or terrain): the three-adapter's block mesher
 * and terrain packer on the worker's global. It loads no three.js.
 */
import { meshWorkerGlobalEndpoint, runBlockMeshWorker, runTerrainPackWorker } from '@thirdlight/three-adapter/block-mesh-worker';

// Block chunks and terrain tiles: each ignores the other's messages (a page starts a worker of this script for each).
const endpoint = meshWorkerGlobalEndpoint();
runBlockMeshWorker(endpoint);
runTerrainPackWorker(endpoint);
