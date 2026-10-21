/**
 * The script type check's worker thread (built beside the backend bundle,
 * `dist/backend/type-check-worker.mjs`): one message `{id, input}` in, the
 * check's result `{id, result}` (or `{id, error}`) out. The compiler's first
 * load (its standard library and the API typings) and a heavy script's
 * check take this thread's time, never the backend's event loop that every
 * project's requests, sockets and Play relays share.
 */
import { parentPort } from 'node:worker_threads';

import { createScriptTypeChecker, type ScriptTypeCheckInput } from '@thirdlight/behavior-build/type-check';

// The checker keeps the parsed standard library and each script's files between checks.
const checker = createScriptTypeChecker({ now: () => performance.now() });

parentPort?.on('message', (m: { id: number; input: ScriptTypeCheckInput }) => {
  checker.check(m.input).then(
    (result) => parentPort!.postMessage({ id: m.id, result }),
    (e: unknown) => parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) }),
  );
});
