/**
 * The `brush` step: instance-brush strokes on a large instance set.
 *
 * A block layer (128 × 128 columns, its top at y = 1) and an instance set of
 * 50,000 copies spread over most of it; then strokes on the free stripe
 * along its far edge, each as large as one stroke may be (the editor's
 * request: every candidate's surface sent along), the same strokes without a
 * surface (the backend drops them onto the block layer), erase strokes, and
 * undo/redo. Each is one `paintInstances` command over HTTP; the round trip
 * is the backend's whole stroke (read the set, plan, publish the new buffer,
 * store it). The editor adds its own surface pass (a few ms, the e2e's
 * `data-instance-stroke`) and its redraw.
 */

import { INSTANCE_BRUSH_LIMITS, INSTANCE_FLOATS, strokeCandidates, type InstanceBrush } from '@thirdlight/project-model';

import type { PerfBackend } from './backend';
import { summarize, type Summary } from './stats';

export interface BrushScaleReport {
  copiesBefore: number;
  copiesAfter: number;
  /** Paint strokes with the editor's surface: places per stroke, copies added, round trip. */
  paint: { strokes: number; places: number; added: number; ms: Summary };
  /** The same strokes without a surface (dropped onto the block layer by the backend). */
  paintNoSurface: { strokes: number; added: number; ms: Summary };
  erase: { strokes: number; removed: number; ms: Summary };
  undo: Summary;
  redo: Summary;
  /** The set's buffer bytes after the strokes. */
  bufferBytes: number;
  backendRssMiB: number | null;
}

const SIDE = 128;
const SET_COPIES = 50_000;
/** The free stripe the strokes paint on (the set's copies stay below z = FREE_Z). */
const FREE_Z = 100;

export async function measureInstanceBrush(be: PerfBackend, projectId: string, rss: () => number | null, log: (s: string) => void): Promise<BrushScaleReport> {
  const p = be.project(projectId);
  const found = ((await p.query('queryIndex', { kind: 'model', refs: false, limit: 1 }))['entries'] ?? []) as { id: string }[];
  const model = found[0] === undefined ? undefined : { assetId: found[0].id };
  if (model === undefined) throw new Error('no model asset for the instance set');
  await p.command('setSettings', { settings: { physics_dimension: 3 } });
  await p.command('setBlockType', { block: { blockId: 'bench-turf', name: 'Bench turf', variants: [{ color: '#3f8f3a' }], shape: 'full' } });
  const layer = String((await p.command('createEntity', { parentId: null, kind: 'group', name: 'Brush bench ground', transform: { position: [0, 0, 0] } }))['createdId']);
  await p.command('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [SIDE, 4, SIDE] } } });
  await p.command('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, SIDE, 1, SIDE], cell: { block: 'bench-turf' } }] });

  // The large set: copies on a jittered grid over z < FREE_Z.
  const floats = new Float32Array(SET_COPIES * INSTANCE_FLOATS);
  const cols = Math.ceil(Math.sqrt((SET_COPIES * SIDE) / FREE_Z));
  const step = SIDE / cols;
  for (let i = 0; i < SET_COPIES; i++) {
    const o = i * INSTANCE_FLOATS;
    floats.set([(i % cols) * step + step / 2, 1, Math.floor(i / cols) * step + step / 2, 0, 0, 0, 1, 0.5, 0.5, 0.5], o);
  }
  const stageId = await be.stage(projectId, new Uint8Array(floats.buffer));
  const published = await be.post(`/api/v1/projects/${projectId}/content/buffers`, { stageId });
  if (published.status !== 200) throw new Error(`the set's buffer was refused: ${JSON.stringify(published.json).slice(0, 300)}`);
  const set = String((await p.command('createEntity', { parentId: null, kind: 'group', name: 'Brush bench set', components: { instances: { asset: { assetId: model.assetId }, buffer: published.json['digest'], count: SET_COPIES } } }))['createdId']);
  const count = async (): Promise<number> => Number((((await p.query('queryEntity', { entityId: set }))['entity'] as { components: { instances: { count: number } } }).components.instances.count));

  // A stroke as large as one may be: a row of dabs across the free stripe.
  const brush: InstanceBrush = { radius: 3, density: 6, spacing: 0.3, scale: [0.4, 0.6], yaw: 360, align: 1, seed: 11 };
  const strokeAt = (row: number, seed: number): { dabs: [number, number, number][]; places: number } => {
    const dabs: [number, number, number][] = [];
    for (let x = 4; x < SIDE - 4; x += 1.5) {
      const next = [...dabs, [x, 1, FREE_Z + 4 + row * 7] as [number, number, number]];
      const c = strokeCandidates(next, { ...brush, seed });
      if (c === null || next.length > INSTANCE_BRUSH_LIMITS.dabs) break;
      dabs.push(next[next.length - 1]!);
    }
    return { dabs, places: strokeCandidates(dabs, { ...brush, seed })!.length };
  };
  const timed = async (args: Record<string, unknown>): Promise<number> => {
    const t = performance.now();
    await p.command('paintInstances', { entityId: set, ...args });
    return performance.now() - t;
  };
  const copiesBefore = await count();
  const paintMs: number[] = [];
  let places = 0;
  for (let row = 0; row < 3; row++) {
    const s = strokeAt(row, 100 + row);
    places = Math.max(places, s.places);
    const surface = strokeCandidates(s.dabs, { ...brush, seed: 100 + row })!.map(() => [1, 0, 0]);
    paintMs.push(await timed({ mode: 'paint', dabs: s.dabs, brush: { ...brush, seed: 100 + row }, surface }));
  }
  const afterPaint = await count();
  const dropMs: number[] = [];
  for (let row = 0; row < 3; row++) {
    const s = strokeAt(row, 200 + row);
    dropMs.push(await timed({ mode: 'paint', dabs: s.dabs, brush: { ...brush, seed: 200 + row } }));
  }
  const afterDrop = await count();
  const eraseMs: number[] = [];
  for (let k = 0; k < 3; k++) eraseMs.push(await timed({ mode: 'erase', dabs: [[20 + k * 30, 1, FREE_Z + 10], [30 + k * 30, 1, FREE_Z + 10]], brush }));
  const afterErase = await count();
  const undo: number[] = [];
  const redo: number[] = [];
  for (let k = 0; k < 3; k++) {
    let t = performance.now();
    await p.command('undo', {});
    undo.push(performance.now() - t);
    t = performance.now();
    await p.command('redo', {});
    redo.push(performance.now() - t);
  }
  const copiesAfter = await count();
  const report: BrushScaleReport = {
    copiesBefore,
    copiesAfter,
    paint: { strokes: paintMs.length, places, added: afterPaint - copiesBefore, ms: summarize(paintMs) },
    paintNoSurface: { strokes: dropMs.length, added: afterDrop - afterPaint, ms: summarize(dropMs) },
    erase: { strokes: eraseMs.length, removed: afterDrop - afterErase, ms: summarize(eraseMs) },
    undo: summarize(undo),
    redo: summarize(redo),
    bufferBytes: copiesAfter * INSTANCE_FLOATS * 4,
    backendRssMiB: rss(),
  };
  log(`scale: brush on ${copiesBefore} copies: paint p50 ${report.paint.ms.p50} ms (${places} places), no surface p50 ${report.paintNoSurface.ms.p50} ms, erase p50 ${report.erase.ms.p50} ms, undo p50 ${report.undo.p50} ms`);
  return report;
}
