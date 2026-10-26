/**
 * The tracer in a browser page (bundled by tracer-run.ts): the product's
 * GPU tracer on a fresh WebGPU device with the default limits (what the
 * renderer asks for), one pass a frame at the display's cap, each pass
 * timestamped.
 */
import { GpuTracer, type TracerDevice } from '../../packages/three-adapter/src/tracer-gpu';

/** One case: a packed scene and a batch of rays (base64 of their bytes). */
export interface TracerCase {
  name: string;
  words: string;
  rays: string;
  frames: number;
}

const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function b64Of(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function run(cases: TracerCase[]): Promise<Record<string, unknown>> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o: unknown): Promise<any> } }).gpu;
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === undefined || adapter === null) return { error: 'no WebGPU adapter' };
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  const tracer = await GpuTracer.create(device as TracerDevice);
  const timed = device.features.has('timestamp-query') === true;
  const qs = timed ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
  const resolve = timed ? device.createBuffer({ size: 16, usage: 0x200 | 0x4 }) : null; // QUERY_RESOLVE | COPY_SRC
  const out: Record<string, unknown>[] = [];
  for (const c of cases) {
    const words = bytesOf(c.words);
    tracer.setScene({ words: new Uint32Array(words.buffer, words.byteOffset, words.byteLength / 4), bytes: { blocks: 0, terrain: 0, arch: 0, bricks: 0 } });
    const r = bytesOf(c.rays);
    const rays = new Float32Array(r.buffer, r.byteOffset, r.byteLength / 4);
    const hits = await tracer.trace(rays);
    const ns: number[] = [];
    for (let f = 0; f < c.frames; f += 1) {
      await new Promise((ok) => requestAnimationFrame(ok));
      const enc = device.createCommandEncoder();
      tracer.encode(enc, rays, qs !== null ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
      if (qs !== null && resolve !== null) {
        const read = device.createBuffer({ size: 16, usage: 0x1 | 0x8 });
        enc.resolveQuerySet(qs, 0, 2, resolve, 0);
        enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
        device.queue.submit([enc.finish()]);
        await read.mapAsync(0x1);
        const t = new BigUint64Array(read.getMappedRange().slice(0));
        read.unmap();
        read.destroy();
        ns.push(Number(t[1]! - t[0]!));
      } else {
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();
      }
    }
    out.push({ name: c.name, hits: b64Of(new Uint8Array(hits.buffer)), ns });
  }
  tracer.dispose();
  device.destroy();
  return { adapter: adapter.info?.description ?? adapter.info?.vendor ?? '', timed, cases: out };
}

(window as unknown as { __tlTracer: unknown }).__tlTracer = { run };
