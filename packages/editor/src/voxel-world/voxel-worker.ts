/**
 * The voxel world page's worker: the streaming core's job handlers (load,
 * apply-save, edit, derive) on the module worker's own global scope, with
 * fzstd decoding the region files' zstd chunk frames, and beside them the
 * ground cover job. Play's and the Scene view's worlds start their pools
 * from this same file, so all three grow the same cover.
 */
import { decompress } from 'fzstd';
import { voxelCoverJobHandlers } from '@thirdlight/project-model/voxel-cover';
import { serveJobs, streamJobHandlers, type JobEndpoint } from '@thirdlight/voxel';

const codec = { decompress: (b: Uint8Array): Uint8Array => decompress(b) };
serveJobs(self as unknown as JobEndpoint, { ...streamJobHandlers(codec), ...voxelCoverJobHandlers(codec) });
