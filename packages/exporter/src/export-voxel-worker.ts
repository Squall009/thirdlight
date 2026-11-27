/**
 * The exported game's voxel worker entry (`js/voxel-worker.js`, shipped
 * when a scene names a voxel world): the streaming core's job handlers
 * (load, apply-save, edit, derive) on the worker's own global, with fzstd
 * decoding the region files' zstd chunk frames, and beside them the ground
 * cover job (a chunk column's cover points from its cells and the build's
 * dressings). The simulation worker starts a pool of these a world (the
 * page does, in single-thread mode).
 */
import { decompress } from 'fzstd';
import { voxelCoverJobHandlers } from '@thirdlight/project-model/voxel-cover';
import { serveJobs, streamJobHandlers, type JobEndpoint } from '@thirdlight/voxel';

const codec = { decompress: (b: Uint8Array): Uint8Array => decompress(b) };
serveJobs(self as unknown as JobEndpoint, { ...streamJobHandlers(codec), ...voxelCoverJobHandlers(codec) });
