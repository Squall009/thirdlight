/**
 * The exported game's view worker entry (`js/mesh-worker.js`, shipped when
 * the game has block layers, terrain, architecture or voxel worlds): the three-adapter's block mesher,
 * terrain packer, ground cover generator, scatter set preparer, architecture generator and the surface cache's voxel
 * charts on the worker's global. It loads no three.js.
 */
import { meshWorkerGlobalEndpoint, runArchitectureWorker, runBlockMeshWorker, runCoverWorker, runScatterWorker, runTerrainPackWorker, runVoxelChartWorker } from '@thirdlight/three-adapter/block-mesh-worker';

// Block chunks, terrain tiles, ground cover, scatter sets, generated architecture and the surface cache's voxel charts: each ignores the others' messages (a page starts a worker of this script for each).
const endpoint = meshWorkerGlobalEndpoint();
runBlockMeshWorker(endpoint);
runTerrainPackWorker(endpoint);
runCoverWorker(endpoint);
runScatterWorker(endpoint);
runArchitectureWorker(endpoint);
runVoxelChartWorker(endpoint);
