/**
 * Generated architecture made off the page's main thread: one chunk per
 * job, from the component's elements that reach it and the trim sheets its
 * materials wear (`generateArchitectureChunk`, pure arithmetic in
 * project-model). The arrays come back handed over, not copied.
 *
 * It runs in the view's worker script beside the block mesher, terrain
 * packer, ground cover and scatter, on workers of its own; the page runs
 * the same function itself when no worker can (the same bytes either way).
 *
 * This module imports no three.js: the worker bundle stays small.
 */
import { generateArchitectureChunk, type ArchitectureChunk, type ArchitectureComponent, type ArchitectureSheets } from '@thirdlight/runtime';

/** Page → worker: make one chunk. */
export interface ArchitectureJobRequest {
  readonly t: 'archGenerate';
  readonly job: number;
  readonly component: ArchitectureComponent;
  readonly sheets: ArchitectureSheets;
  readonly cx: number;
  readonly cz: number;
}

/** Worker → page. */
export type ArchitectureJobReply =
  | { readonly t: 'archGenerated'; readonly job: number; readonly ok: true; readonly chunk: ArchitectureChunk; readonly ms: number }
  | { readonly t: 'archGenerated'; readonly job: number; readonly ok: false; readonly message: string };

/** The endpoint a worker talks through (its global scope, or a port in tests). */
export interface ArchitectureEndpoint {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  listen(onMessage: (message: unknown) => void): void;
}

/** Answer one request (also what the page runs when no worker can). */
export function answerArchitectureJob(req: ArchitectureJobRequest): ArchitectureJobReply {
  const t0 = performance.now();
  try {
    const chunk = generateArchitectureChunk(req.component, req.sheets, req.cx, req.cz);
    return { t: 'archGenerated', job: req.job, ok: true, chunk, ms: performance.now() - t0 };
  } catch (e) {
    return { t: 'archGenerated', job: req.job, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Every array buffer of a chunk (handed over with the reply). */
export function architectureChunkBuffers(c: ArchitectureChunk): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const m of c.meshes) for (const a of [m.mesh.positions, m.mesh.normals, m.mesh.uvs, m.mesh.colors, m.mesh.indices, m.mesh.farIndices]) out.add(a.buffer as ArrayBuffer);
  for (const s of c.copies) out.add(s.transforms.buffer as ArrayBuffer);
  return [...out];
}

/** Run the generator on an endpoint (beside the view worker's other parts on the same one: each ignores the others' messages). */
export function runArchitectureWorker(endpoint: ArchitectureEndpoint): void {
  endpoint.listen((raw) => {
    const m = raw as Partial<ArchitectureJobRequest> | null;
    if (m?.t !== 'archGenerate') return;
    const reply = answerArchitectureJob(m as ArchitectureJobRequest);
    endpoint.post(reply, reply.ok ? architectureChunkBuffers(reply.chunk) : undefined);
  });
}
