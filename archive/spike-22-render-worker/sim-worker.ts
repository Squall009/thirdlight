/**
 * SPIKE 22.2 (archived, not built or tested): the export's simulation worker
 * entry with a tee — every `ready`/`frame` message it sends the page is also
 * sent, as a structured-clone copy, to the render worker over a
 * MessageChannel port the page hands it before `init` (`spike.renderPort`).
 * The render worker so gets the per-frame state straight from the simulation,
 * without a hop through the page's main thread. Each frame is stamped with the
 * epoch time it left the simulation (`spikeT`), for the latency probes.
 *
 * The copy is made before the page's message transfers the transform buffer
 * (postMessage clones synchronously), so both receivers read the same values.
 */
import { createPhysicsPort, physicsMemoryBytes, type RapierPhysicsInitConfig } from '@thirdlight/physics-rapier';
import { runSimWorker, workerGlobalEndpoint, type SimEndpoint } from '@thirdlight/game-host';

const base = workerGlobalEndpoint();
let renderPort: MessagePort | null = null;
const epochNow = (): number => performance.timeOrigin + performance.now();

const endpoint: SimEndpoint = {
  post(message, transfer) {
    const m = message as { t?: string; state?: Record<string, unknown> };
    if ((m.t === 'frame' || m.t === 'ready') && m.state !== undefined) {
      m.state['spikeT'] = epochNow();
      renderPort?.postMessage(m);
    }
    base.post(message, transfer);
  },
  listen(onMessage) {
    base.listen((raw) => {
      const r = raw as { t?: string; port?: MessagePort } | null;
      if (r !== null && typeof r === 'object' && r.t === 'spike.renderPort' && r.port !== undefined) {
        renderPort = r.port;
        return;
      }
      onMessage(raw);
    });
  },
};

runSimWorker(endpoint, {
  createPhysicsPort: (config) => createPhysicsPort(config as RapierPhysicsInitConfig),
  importModule: (url) => import(/* @vite-ignore */ url),
  physicsMemoryBytes,
});
