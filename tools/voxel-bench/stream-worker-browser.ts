/**
 * The streaming worker for browsers: the stream job handlers served on the
 * module worker's own global scope, with fzstd as the zstd decoder. Built
 * by the streaming page (one module worker per pool slot).
 */
import { serveJobs, streamJobHandlers, type JobEndpoint } from '@thirdlight/voxel';
import { decompress } from 'fzstd';

serveJobs(self as unknown as JobEndpoint, streamJobHandlers({ decompress: (b) => decompress(b) }));
