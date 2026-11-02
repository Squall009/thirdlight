/**
 * The voxel world page's worker: the streaming core's job handlers (load,
 * apply-save, edit, derive) on the module worker's own global scope, with
 * fzstd decoding the region files' zstd chunk frames.
 */
import { decompress } from 'fzstd';
import { serveJobs, streamJobHandlers, type JobEndpoint } from '@thirdlight/voxel';

serveJobs(self as unknown as JobEndpoint, streamJobHandlers({ decompress: (b) => decompress(b) }));
