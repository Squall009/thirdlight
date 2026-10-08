/**
 * The KTX2 encoder's worker thread (built to
 * `dist/backend/ktx2-worker.mjs`): one message `{id, bytes, mode}` in, one
 * `{id, result}` out, in order. Tile thumbnails of images are made here too,
 * so a large image is never decoded on the backend's event loop.
 */
import { parentPort } from 'node:worker_threads';

import { makeImageThumbnail } from './image-thumbnail';
import { decodeTextureRgba, encodeKtx2, packKtx2, type Ktx2Mode, type PackLayer } from './texture-encode';

let queue: Promise<void> = Promise.resolve();
// `{id, pack: {sources, layers, lossless}, mode}` packs several images into one KTX2;
// `{id, thumbnail: bytes}` makes an image's tile thumbnail (a PNG); `{id, decode: {bytes, maxPixels}}` an image's RGBA.
parentPort?.on('message', (m: { id: number; bytes?: Uint8Array; pack?: { sources: Uint8Array[]; layers: PackLayer[]; lossless?: (Uint8Array | null)[] }; thumbnail?: Uint8Array; decode?: { bytes: Uint8Array; maxPixels: number }; mode: Ktx2Mode }) => {
  queue = queue.then(async () => {
    if (m.decode !== undefined) {
      const r = await decodeTextureRgba(m.decode.bytes, m.decode.maxPixels);
      parentPort!.postMessage({ id: m.id, result: r }, r.ok ? [r.data.buffer as ArrayBuffer] : []);
      return;
    }
    if (m.thumbnail !== undefined) {
      const png = await makeImageThumbnail(m.thumbnail);
      parentPort!.postMessage({ id: m.id, result: { thumbnail: png } }, png !== null ? [png.buffer as ArrayBuffer] : []);
      return;
    }
    const result = m.pack !== undefined ? await packKtx2(m.pack.sources, m.pack.layers, m.mode, m.pack.lossless ?? []) : await encodeKtx2(m.bytes!, m.mode);
    if (result.ok) parentPort!.postMessage({ id: m.id, result }, [result.ktx2.buffer as ArrayBuffer]);
    else parentPort!.postMessage({ id: m.id, result });
  });
});
