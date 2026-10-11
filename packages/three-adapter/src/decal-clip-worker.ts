/**
 * Clipped decals made off the page's main thread: one decal per job, the
 * project-model clipper (`clipDecal`) over the receivers the page found
 * under the decal's box. It runs on the generator workers of generated
 * architecture (the same script, the same workers: `runArchitectureWorker`
 * starts it), so decals and the chunks they lie on share one pool; the page
 * runs the same function itself when no worker can.
 *
 * A receiver's arrays cross to a worker once: the worker keeps them by their
 * geometry hash until the page tells it to forget them, so a hundred marks on
 * one big model copy its vertices once, not a hundred times. The page
 * decides what each worker holds (it counts the bytes and names what to
 * forget in the next job), so the two never disagree.
 *
 * This module imports no three.js: the worker bundle stays small.
 */
import { clipDecal, type DecalClipMesh, type DecalClipProjector } from '@thirdlight/runtime';

import type { ArchitectureEndpoint } from './architecture-worker';

/** A receiver's geometry as the clipper reads it (copied to a worker, never handed over: the page's mesh keeps drawing it). */
export interface DecalClipReceiverData {
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
  readonly index: Uint16Array | Uint32Array | null;
}

/** Page → worker: clip one decal. */
export interface DecalClipJobRequest {
  readonly t: 'decalClip';
  readonly job: number;
  readonly projector: DecalClipProjector;
  /** In the clipper's order: each geometry's hash, its matrix relative to the decal's frame, and its arrays unless the worker holds them. */
  readonly receivers: readonly { readonly geometry: string; readonly matrix: readonly number[]; readonly data?: DecalClipReceiverData }[];
  /** Geometries the worker lets go of first (the page's count of what it holds went past its bound). */
  readonly forget?: readonly string[];
}

/** Worker → page. `missing`: a receiver's arrays were not held (the page sends them again). */
export type DecalClipJobReply =
  | { readonly t: 'decalClipped'; readonly job: number; readonly ok: true; readonly mesh: DecalClipMesh; readonly ms: number }
  | { readonly t: 'decalClipped'; readonly job: number; readonly ok: false; readonly message: string; readonly missing?: boolean };

/** Answer one request with the geometries `held` (kept across jobs on a worker; the page's own map when it clips itself). */
export function answerDecalClipJob(req: DecalClipJobRequest, held: Map<string, DecalClipReceiverData>): DecalClipJobReply {
  for (const g of req.forget ?? []) held.delete(g);
  const receivers = [];
  for (const r of req.receivers) {
    if (r.data !== undefined) held.set(r.geometry, r.data);
    const data = held.get(r.geometry);
    if (data === undefined) return { t: 'decalClipped', job: req.job, ok: false, message: `receiver ${r.geometry} is not held`, missing: true };
    receivers.push({ positions: data.positions, normals: data.normals, index: data.index, matrix: r.matrix });
  }
  const t0 = performance.now();
  try {
    const mesh = clipDecal(req.projector, receivers);
    return { t: 'decalClipped', job: req.job, ok: true, mesh, ms: performance.now() - t0 };
  } catch (e) {
    return { t: 'decalClipped', job: req.job, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Every array buffer of a clipped mesh (handed over with the reply). */
export function decalClipMeshBuffers(m: DecalClipMesh): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const a of [m.positions, m.normals, m.uvs, m.tangents, m.fades, m.index]) out.add(a.buffer as ArrayBuffer);
  return [...out];
}

/** Run the clipper on an endpoint (beside the other parts of the view's worker script: each ignores the others' messages). */
export function runDecalClipWorker(endpoint: ArchitectureEndpoint): void {
  const held = new Map<string, DecalClipReceiverData>();
  endpoint.listen((raw) => {
    const m = raw as Partial<DecalClipJobRequest> | null;
    if (m?.t !== 'decalClip') return;
    const reply = answerDecalClipJob(m as DecalClipJobRequest, held);
    endpoint.post(reply, reply.ok ? decalClipMeshBuffers(reply.mesh) : undefined);
  });
}
