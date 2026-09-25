/**
 * Phase 22.1: the editor's off-thread jobs — one table, run by the editor
 * worker (`editor-worker.ts`) and, where no worker is available, by the page
 * itself: the same functions on both sides, so the results are the same.
 *
 * - `scatter`: an instance set's placements (`scatterTransforms`);
 * - `graphIssues` / `materialIssues`: the Problems tab's graph diagnostics;
 * - `encodePng`: RGBA pixels or an `ImageBitmap` to PNG bytes
 *   (`OffscreenCanvas.convertToBlob`);
 * - `bake`: the whole browser lightmap bake on an `OffscreenCanvas`
 *   (WebGPURenderer runs in a worker on WebGPU and on WebGL 2), then the
 *   atlases as PNG bytes.
 *
 * DOM-free: every job needs only what a dedicated worker has.
 */
import type { GraphDocument, GraphKindDef, MaterialDef } from '@thirdlight/project-model';
import { bakeLightmapsInBrowser, type BrowserBakeResult } from '@thirdlight/three-adapter';

import { scatterTransforms, type ScatterOptions } from '../session/instances';
import { unpackBakeInput, type PackedBakeInput } from './bake-transfer';
import { graphIssuesOf, materialIssuesOf, type GraphIssue, type MaterialIssue } from './problems';

/** Pixels (RGBA8, row 0 on top) or a bitmap to encode as PNG. */
export type EncodeInput = { pixels: Uint8ClampedArray; width: number; height: number } | { bitmap: ImageBitmap };

export type BakeJobResult = { ok: true; pngs: Uint8Array[]; millis: number } | Extract<BrowserBakeResult, { ok: false }>;

export interface JobTypes {
  scatter: { input: ScatterOptions; output: Float32Array };
  graphIssues: { input: { graphs: readonly GraphDocument[]; kinds: Readonly<Record<string, GraphKindDef>> }; output: GraphIssue[] };
  materialIssues: { input: { materials: readonly MaterialDef[]; graphs: readonly GraphDocument[]; kinds: Readonly<Record<string, GraphKindDef>>; textureIds: readonly string[] }; output: MaterialIssue[] };
  encodePng: { input: EncodeInput; output: Uint8Array };
  bake: { input: PackedBakeInput; output: BakeJobResult };
}

export type JobName = keyof JobTypes;

export interface JobContext {
  progress(done: number, total: number): void;
  readonly signal: AbortSignal;
}

export interface JobResult<T> {
  output: T;
  /** Buffers moved (not copied) back to the page. */
  transfer: Transferable[];
}

/** PNG bytes of pixels or a bitmap, on an OffscreenCanvas (a worker has no DOM canvas). */
export async function encodePngOffscreen(input: EncodeInput): Promise<Uint8Array> {
  const width = 'bitmap' in input ? input.bitmap.width : input.width;
  const height = 'bitmap' in input ? input.bitmap.height : input.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2D OffscreenCanvas for the PNG');
  if ('bitmap' in input) {
    ctx.drawImage(input.bitmap, 0, 0);
    input.bitmap.close();
  } else {
    ctx.putImageData(new ImageData(input.pixels as unknown as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

type Handlers = { [K in JobName]: (input: JobTypes[K]['input'], ctx: JobContext) => Promise<JobResult<JobTypes[K]['output']>> };

export const JOBS: Handlers = {
  async scatter(input) {
    const output = scatterTransforms(input);
    return { output, transfer: [output.buffer] };
  },
  async graphIssues(input) {
    return { output: graphIssuesOf(input.graphs, input.kinds), transfer: [] };
  },
  async materialIssues(input) {
    return { output: materialIssuesOf(input.materials, input.graphs, input.kinds, input.textureIds), transfer: [] };
  },
  async encodePng(input) {
    const output = await encodePngOffscreen(input);
    return { output, transfer: [output.buffer] };
  },
  async bake(input, ctx) {
    const result = await bakeLightmapsInBrowser({ ...unpackBakeInput(input), canvas: new OffscreenCanvas(4, 4), onProgress: (d, t) => ctx.progress(d, t), signal: ctx.signal });
    if (!result.ok) return { output: result, transfer: [] };
    const pngs: Uint8Array[] = [];
    for (const a of result.atlases) pngs.push(await encodePngOffscreen({ pixels: a.pixels, width: a.width, height: a.height }));
    return { output: { ok: true, pngs, millis: result.millis }, transfer: pngs.map((p) => p.buffer) };
  },
};
