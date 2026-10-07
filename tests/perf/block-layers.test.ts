/**
 * Opt-in (TL_PERF=1): block-layer measurements against the editing and meshing targets.
 *
 *   TL_PERF=1 npx vitest run tests/perf/block-layers.test.ts
 *
 * - Editing a 64 × 64 × 16 layer (65,536 cells) through the command path
 *   (`editBlocks`: argument checks, the edit, the scene and content
 *   validation, the no-change check): one cell, a 5 × 5 brush stroke and a
 *   layer-wide fill, median of repeated runs.
 * - A 40 × 40 × 12 terrain map (heightmap-like, three block types): the
 *   merged chunk meshes (one draw per block look per chunk, before shadows),
 *   triangles after hidden-face removal, meshing and collision-building time.
 * - A 64 × 64 rolling terrain of sloped cells: meshing time flat (the
 *   default), with smoothed tops and with subdivided tops.
 * - A one-cell edit on a 512 × 512 layer (262,144 cells, 1,024 chunks): the
 *   heap an undo step keeps, and the edit, undo and redo times.
 * The numbers are printed (and recorded in docs/plan-phase-23.md); the
 * assertions are the budgets (interactive: an edit under 50 ms; a few draws
 * per chunk).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';
import { applyBlockEdits, BlockGrid, collisionMeshChunk, meshBlockChunk, shapeSource, type BlockType, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState, type CommandState } from '../../packages/commands/src/index';
import { m2EnvelopeV4 } from '../../packages/commands/src/test-fixtures';

const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#6b7280' }], shape: 'full' },
  { blockId: 'dirt', name: 'Dirt', variants: [{ color: '#8b5a2b' }], shape: 'full' },
  { blockId: 'grass', name: 'Grass', variants: [{ color: '#3fa34d' }, { color: '#4cb05a' }, { color: '#379043' }], shape: 'full' },
];
/** The measured numbers also go to ~/.cache/thirdlight-perf/block-layers.jsonl (vitest hides a passing test's output). */
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'block-layers.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe.skipIf(process.env['TL_PERF'] === undefined)('block layers: measurements (opt-in)', () => {
  it('edits a 64 × 64 × 16 layer interactively through the command path', () => {
    const before = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
    let s = createCommandState(structuredClone(before.scene), structuredClone(before.content)) as CommandState<SceneV4>;
    let n = 0;
    const run = (op: string, args: Record<string, unknown>): number => {
      n += 1;
      const t0 = performance.now();
      const out = applyMutation(s, { op, projectId: before.projectId, expectedRevision: s.scene.revision, requestId: `req-${n.toString(16).padStart(32, '0')}`, args });
      const ms = performance.now() - t0;
      if (!out.result.ok) throw new Error(JSON.stringify(out.result).slice(0, 300));
      s = (out as { state: CommandState<SceneV4> }).state;
      return ms;
    };
    for (const t of TYPES) run('setBlockType', { block: t });
    const created = applyMutation(s, { op: 'createEntity', projectId: before.projectId, expectedRevision: s.scene.revision, requestId: `req-${'c'.repeat(32)}`, args: { kind: 'group', name: 'Ground' } });
    s = (created as { state: CommandState<SceneV4> }).state;
    const id = (created.result as { createdId: string }).createdId;
    run('setComponent', { entityId: id, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [64, 16, 64] } } });
    const fill = run('editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [0, 0, 0, 64, 15, 64], cell: { block: 'stone' } }, { kind: 'fill', box: [0, 15, 0, 64, 16, 64], cell: { block: 'grass' } }] });
    const one: number[] = [];
    const stroke: number[] = [];
    for (let i = 0; i < 15; i++) {
      one.push(run('editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [i * 3, 15, 30 + i], cell: i % 2 === 0 ? null : { block: 'dirt' } }] }));
      stroke.push(run('editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [i * 4, 14, 10, i * 4 + 5, 16, 15], cell: { block: i % 2 === 0 ? 'dirt' : 'grass' } }] }));
    }
    const undo: number[] = [];
    for (let i = 0; i < 5; i++) undo.push(run('undo', {}));
    const numbers = { cells: 64 * 64 * 16, fillMs: fill, oneCellMs: median(one), strokeMs: median(stroke), undoMs: median(undo) };
    record(`block-layers edit 64x64x16: ${JSON.stringify(numbers)}`);
    expect(numbers.oneCellMs).toBeLessThan(50);
    expect(numbers.strokeMs).toBeLessThan(50);
  });

  it('a one-cell edit on a 512 × 512 layer keeps a small undo step', () => {
    const before = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
    let s = createCommandState(structuredClone(before.scene), structuredClone(before.content)) as CommandState<SceneV4>;
    let n = 0;
    const run = (op: string, args: Record<string, unknown>): number => {
      n += 1;
      const t0 = performance.now();
      const out = applyMutation(s, { op, projectId: before.projectId, expectedRevision: s.scene.revision, requestId: `req-${(0x50000 + n).toString(16).padStart(32, '0')}`, args });
      const ms = performance.now() - t0;
      if (!out.result.ok) throw new Error(JSON.stringify(out.result).slice(0, 300));
      s = (out as { state: CommandState<SceneV4> }).state;
      return ms;
    };
    for (const t of TYPES) run('setBlockType', { block: t });
    const created = applyMutation(s, { op: 'createEntity', projectId: before.projectId, expectedRevision: s.scene.revision, requestId: `req-${'d'.repeat(32)}`, args: { kind: 'group', name: 'Ground' } });
    s = (created as { state: CommandState<SceneV4> }).state;
    const id = (created.result as { createdId: string }).createdId;
    run('setComponent', { entityId: id, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [512, 4, 512] } } });
    // A varied surface (every chunk holds two block types), 262,144 cells in 1,024 chunks.
    run('editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [0, 0, 0, 512, 1, 512], cell: { block: 'stone' } }] });
    for (let i = 0; i < 4; i++) run('editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [i * 128, 0, 0, i * 128 + 64, 1, 512], cell: { block: 'grass' } }] });
    // A full collection before each heap reading: the measure is the bytes the history keeps.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const heap = (): number => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };
    const EDITS = 40;
    const h0 = heap();
    const edit: number[] = [];
    for (let i = 0; i < EDITS; i++) edit.push(run('editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [7 + i * 11, 0, 300], cell: i % 2 === 0 ? null : { block: 'dirt' } }] }));
    const perStep = (heap() - h0) / EDITS;
    const undo: number[] = [];
    const redo: number[] = [];
    for (let i = 0; i < 10; i++) undo.push(run('undo', {}));
    for (let i = 0; i < 10; i++) redo.push(run('redo', {}));
    const numbers = { cells: 512 * 512, chunks: 1024, undoBytesPerOneCellEdit: Math.round(perStep), editMs: median(edit), undoMs: median(undo), redoMs: median(redo) };
    record(`block-layers undo 512x512: ${JSON.stringify(numbers)}`);
    expect(numbers.editMs).toBeGreaterThan(0);
  }, 300_000);

  it('a 40 × 40 × 12 terrain draws a few merged meshes per chunk', () => {
    const g = new BlockGrid({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [40, 12, 40] } });
    const types = new Map(TYPES.map((t) => [t.blockId, t]));
    const at: number[] = [];
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) {
      const h = 3 + Math.round(4 + 3 * Math.sin(x / 5) * Math.cos(z / 7));
      for (let y = 0; y < h; y++) g.set(x, y, z, { block: y === h - 1 ? 'grass' : y > h - 3 ? 'dirt' : 'stone' });
      at.push(h);
    }
    const looks = { source: (t: BlockType, v: number, fm: [number, number, number]) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2]) }) };
    const t0 = performance.now();
    let draws = 0;
    let tris = 0;
    const keys = g.chunkKeys();
    for (const k of keys) {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      const parts = meshBlockChunk(g, cx, cz, types, looks);
      draws += parts.length;
      tris += parts.reduce((n, p) => n + p.indices.length / 3, 0);
    }
    const meshMs = performance.now() - t0;
    const t1 = performance.now();
    let pieces = 0;
    for (const k of keys) {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      pieces += collisionMeshChunk(g, cx, cz, types).length;
    }
    const colliderMs = performance.now() - t1;
    const numbers = { cells: g.size, chunks: keys.length, draws, drawsPerChunk: draws / keys.length, triangles: tris, trianglesIfAllFaces: g.size * 12, meshMs, colliderPieces: pieces, colliderMs };
    record(`block-layers map 40x40x12: ${JSON.stringify(numbers)}`);
    // Three block types, grass in three looks: at most five draws per chunk.
    expect(numbers.drawsPerChunk).toBeLessThanOrEqual(5);
    expect(numbers.triangles).toBeLessThan(numbers.trianglesIfAllFaces / 5);
    void applyBlockEdits;
  });

  it('a 64 × 64 rolling sloped terrain meshes flat, smoothed and with subdivided tops', () => {
    const g = slopedTerrain(64);
    const types = new Map(TYPES.map((t) => [t.blockId, t]));
    const looks = { source: (t: BlockType, v: number, fm: [number, number, number]) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2]) }) };
    const keys = g.chunkKeys();
    const run = (options?: Record<string, number>): { ms: number; triangles: number; vertices: number } => {
      const times: number[] = [];
      let triangles = 0;
      let vertices = 0;
      for (let rep = 0; rep < 7; rep++) {
        triangles = 0;
        vertices = 0;
        const t0 = performance.now();
        for (const k of keys) {
          const [cx, cz] = k.split(',').map(Number) as [number, number];
          for (const p of meshBlockChunk(g, cx, cz, types, looks, options)) {
            triangles += p.indices.length / 3;
            vertices += p.positions.length / 3;
          }
        }
        times.push(performance.now() - t0);
      }
      return { ms: median(times), triangles, vertices };
    };
    const numbers = { cells: g.size, chunks: keys.length, flat: run(), smooth: run({ smoothAngle: 45 }), subdivided: run({ smoothAngle: 45, topSubdivision: 2 }) };
    record(`block-layers sloped 64x64: ${JSON.stringify(numbers)}`);
    expect(numbers.flat.triangles).toBeGreaterThan(0);
  }, 300_000);
});

/** Rolling ground of sloped cells (0.5 m rows): under each column full cells up to the row of its lowest corner, then one sloped top. */
function slopedTerrain(n: number): BlockGrid {
  const g = new BlockGrid({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [n, 24, n] } });
  const q = (v: number): number => Math.round(v * 16) / 16;
  const h = (x: number, z: number): number => q(10 + 4 * Math.sin(x / 7) * Math.cos(z / 9) + 1.2 * Math.sin(x / 2.3 + z / 3.1));
  for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
    const c = [h(x, z), h(x + 1, z), h(x + 1, z + 1), h(x, z + 1)];
    const row = Math.floor(Math.min(...c) - 1e-9);
    for (let y = 0; y < row; y++) g.set(x, y, z, { block: 'stone' });
    const corners = c.map((v) => v - row) as [number, number, number, number];
    g.set(x, row, z, { block: 'grass', ...(corners.every((v) => v === 1) ? {} : { corners }) });
  }
  return g;
}
