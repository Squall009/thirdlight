/**
 * The exported game's voxel worker entry (`js/voxel-worker.js`, shipped
 * when a scene names a voxel world): the streaming core's job handlers
 * (load, apply-save, edit, derive) on the worker's own global, with fzstd
 * decoding the region files' zstd chunk frames. The simulation worker
 * starts a pool of these a world (the page does, in single-thread mode).
 */
import { decompress } from 'fzstd';
import { serveJobs, streamJobHandlers, type JobEndpoint } from '@thirdlight/voxel';

serveJobs(self as unknown as JobEndpoint, streamJobHandlers({ decompress: (b) => decompress(b) }));
