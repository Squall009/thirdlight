/**
 * Worker-transfer cost of chunk buffers: a real worker_threads Worker echoes
 * every message back, and the harness times the round trip of each chunk
 * as its own message, once copied (structured clone both ways) and once
 * transferred (the ArrayBuffer moves both ways, nothing is copied).
 *
 * Node's worker messaging is the stand-in for a browser module worker's
 * postMessage: both clone or move ArrayBuffers the same way, but absolute
 * times differ by engine, so the copy/transfer ratio is the figure to carry
 * over, not the microseconds.
 */
import { Worker } from 'node:worker_threads';

/** The worker: answers every message with the same buffers, moving them back when they were moved in. */
const ECHO = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => parentPort.postMessage(m, m.transfer ? [m.buf] : []));
`;

export interface TransferResult {
  /** Chunks sent (one message each). */
  chunks: number;
  /** Mean bytes per chunk. */
  meanBytes: number;
  /** Microseconds per chunk round trip, copying. */
  copyUsPerChunk: number;
  /** Microseconds per chunk round trip, transferring. */
  transferUsPerChunk: number;
  /** Payload MB/s (both directions counted once) of each mode. */
  copyMBps: number;
  transferMBps: number;
}

/** A started echo worker; `close` ends it. */
export interface EchoWorker {
  /** Sends every buffer as its own message and resolves with the ms until the last came back. */
  roundTrip(buffers: readonly ArrayBuffer[], transfer: boolean): Promise<number>;
  /** Sends one buffer and resolves with the buffer that comes back. */
  echo(buffer: ArrayBuffer, transfer: boolean): Promise<ArrayBuffer>;
  close(): Promise<void>;
}

/** Starts the echo worker. */
export function startEchoWorker(): EchoWorker {
  const worker = new Worker(ECHO, { eval: true });
  worker.unref();
  return {
    roundTrip(buffers, transfer) {
      return new Promise((resolve, reject) => {
        let left = buffers.length;
        const t0 = performance.now();
        const onMessage = (): void => {
          left--;
          if (left === 0) {
            worker.off('message', onMessage);
            worker.off('error', reject);
            resolve(performance.now() - t0);
          }
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
        for (const buf of buffers) worker.postMessage({ buf, transfer }, transfer ? [buf] : []);
      });
    },
    echo(buf, transfer) {
      return new Promise((resolve, reject) => {
        worker.once('message', (m: { buf: ArrayBuffer }) => resolve(m.buf));
        worker.once('error', reject);
        worker.postMessage({ buf, transfer }, transfer ? [buf] : []);
      });
    },
    async close() {
      await worker.terminate();
    },
  };
}

/**
 * Times copy and transfer round trips for `chunks` (each a chunk's bytes),
 * `rounds` times each; the fastest round counts (the first warms the path).
 */
export async function measureTransfer(chunks: readonly Uint8Array[], rounds = 5): Promise<TransferResult> {
  if (chunks.length === 0) throw new Error('measureTransfer needs at least one chunk');
  const worker = startEchoWorker();
  try {
    // A fresh, exactly sized copy each round: a transferred buffer is gone, and Node's Buffer.slice
    // (zlib's output is a Buffer) would share the pooled memory instead of copying.
    const fresh = (): ArrayBuffer[] =>
      chunks.map((c) => {
        const copy = new Uint8Array(c.length);
        copy.set(c);
        return copy.buffer;
      });
    let copy = Infinity;
    let move = Infinity;
    for (let r = 0; r < rounds; r++) {
      copy = Math.min(copy, await worker.roundTrip(fresh(), false));
      move = Math.min(move, await worker.roundTrip(fresh(), true));
    }
    const bytes = chunks.reduce((s, c) => s + c.length, 0);
    return {
      chunks: chunks.length,
      meanBytes: bytes / chunks.length,
      copyUsPerChunk: (copy * 1000) / chunks.length,
      transferUsPerChunk: (move * 1000) / chunks.length,
      copyMBps: bytes / 1e6 / (copy / 1000),
      transferMBps: bytes / 1e6 / (move / 1000),
    };
  } finally {
    await worker.close();
  }
}
