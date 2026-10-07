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
 * - Wall paint: the same rolling terrain with rooms of walls, painted on
 *   tops and walls: meshing and paint colours per chunk, vertices and
 *   triangles, without wall paint and with it (walls cut at the points).
 * - A one-cell edit on a 512 × 512 layer (262,144 cells, 1,024 chunks): the
 *   heap an undo step keeps, the chunk bytes it holds (binary, and the same
 *   chunks as JSON text), and the edit, undo and redo times.
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
import { applyBlockEdits, BlockGrid, blockTopOptions, chunkMeshPaint, collisionMeshChunk, decodeBlockChunks, meshBlockChunk, resolveCellLook, resolveEdgeLook, shapeSource, SurfaceRuleSet, WALL_POINT_BYTES, type BlockType, type SceneV4 } from '@thirdlight/project-model';

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
    // What the steps hold directly: their chunks in binary form, and the same chunks as JSON text (the objects' size before).
    const steps = s.history.entries.slice(-EDITS).map((e) => (e.inverse as { patch?: { chunks: { restore: Uint8Array | null; next: Uint8Array | null }[] } }).patch);
    const held = steps.flatMap((p) => p?.chunks ?? []).flatMap((c) => [c.restore, c.next]).filter((b): b is Uint8Array => b !== null);
    const binaryPerStep = held.reduce((n, b) => n + b.length, 0) / EDITS;
    const jsonPerStep = held.reduce((n, b) => n + JSON.stringify(decodeBlockChunks(b)[0]).length, 0) / EDITS;
    const undo: number[] = [];
    const redo: number[] = [];
    for (let i = 0; i < 10; i++) undo.push(run('undo', {}));
    for (let i = 0; i < 10; i++) redo.push(run('redo', {}));
    const numbers = { cells: 512 * 512, chunks: 1024, undoHeapBytesPerOneCellEdit: Math.round(perStep), undoChunkBytesPerStep: Math.round(binaryPerStep), sameChunksAsJsonPerStep: Math.round(jsonPerStep), editMs: median(edit), undoMs: median(undo), redoMs: median(redo) };
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

  it('edge pieces: a 40 × 40 terrain with walls on every fourth grid line meshes and builds colliders per chunk', () => {
    const types = new Map([...TYPES, { blockId: 'wall', name: 'Wall', variants: [{ color: '#8a8580' }, { color: '#7d7872' }], shape: 'full', placement: 'edge' } as BlockType].map((t) => [t.blockId, t]));
    const plain = new BlockGrid({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [40, 16, 40] } });
    const heights: number[][] = [];
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) {
      const h = 3 + Math.round(4 + 3 * Math.sin(x / 5) * Math.cos(z / 7));
      (heights[x] ??= [])[z] = h;
      for (let y = 0; y < h; y++) plain.set(x, y, z, { block: y === h - 1 ? 'grass' : y > h - 3 ? 'dirt' : 'stone' });
    }
    const walled = BlockGrid.from({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [40, 16, 40] } }, plain.toData('l', null, plain.takeDirty().chunks));
    // Walls 2 m high (4 rows) from the higher ground beside each edge, on the x and z lines 0, 4, 8, …
    const at: number[] = [];
    for (let line = 0; line <= 40; line += 4) for (let i = 0; i < 40; i++) {
      for (const axis of [0, 1]) {
        const [x, z] = axis === 0 ? [line, i] : [i, line];
        if ((axis === 0 && x > 39) || (axis === 1 && z > 39)) continue;
        const g = heights[x]![z]!;
        for (let y = g; y < g + 4; y++) at.push(x, y, z, axis);
      }
    }
    expect(applyBlockEdits(walled, [{ kind: 'edges', at, edge: { block: 'wall' } }], { types, stamps: new Map() }).ok).toBe(true);
    const looks = { source: (t: BlockType, v: number, fm: [number, number, number]) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2]), uv: 'world' as const }) };
    const keys = walled.chunkKeys();
    const time = (g: BlockGrid, f: (cx: number, cz: number) => number): { msPerChunk: number; count: number } => {
      const runs: number[] = [];
      let count = 0;
      for (let rep = 0; rep < 7; rep++) {
        count = 0;
        const t0 = performance.now();
        for (const k of keys) {
          const [cx, cz] = k.split(',').map(Number) as [number, number];
          count += f(cx, cz);
        }
        runs.push((performance.now() - t0) / keys.length);
      }
      return { msPerChunk: Math.round(median(runs) * 1000) / 1000, count };
    };
    const tris = (g: BlockGrid) => (cx: number, cz: number): number => meshBlockChunk(g, cx, cz, types, looks).reduce((n, p) => n + p.indices.length / 3, 0);
    const colliderTris = (g: BlockGrid) => (cx: number, cz: number): number => collisionMeshChunk(g, cx, cz, types).reduce((n, p) => n + p.indices.length / 3, 0);
    const numbers = {
      chunks: keys.length,
      edges: walled.edgeCount,
      edgesPerChunk: Math.round(walled.edgeCount / keys.length),
      mesh: { without: time(plain, tris(plain)), with: time(walled, tris(walled)) },
      collider: { without: time(plain, colliderTris(plain)), with: time(walled, colliderTris(walled)) },
    };
    record(`block-layers edges 40x40: ${JSON.stringify(numbers)}`);
    // An edge piece is a box of 12 triangles drawn whole.
    expect(numbers.mesh.with.count - numbers.mesh.without.count).toBe(numbers.edges * 12);
  }, 300_000);

  it('auto-connect: a 40 × 40 area of connected cell walls and edge fences meshes per chunk at about the cost of plain ones', () => {
    const pieces = { single: { variant: 0 }, end: { variant: 1 }, straight: { variant: 2 }, corner: { variant: 3 }, t: { variant: 4 }, cross: { variant: 5 }, base: { variant: 6 }, cap: { variant: 7 } };
    const looks8 = ['#605850', '#686058', '#706860', '#787068', '#807870', '#888078', '#908880', '#989088'].map((color) => ({ color }));
    const plainWall: BlockType = { blockId: 'wall', name: 'Wall', variants: looks8, shape: 'custom', boxes: [[0.35, 0, 0, 0.65, 1, 1]] };
    const plainFence: BlockType = { blockId: 'fence', name: 'Fence', variants: looks8.slice(0, 4), shape: 'half', placement: 'edge' };
    const connected = (t: BlockType, edge: boolean): BlockType => ({ ...t, connect: { pieces: edge ? { single: pieces.single, end: pieces.end, straight: pieces.straight, corner: pieces.corner } : pieces } });
    const typesOf = (c: boolean) => new Map([...TYPES, c ? connected(plainWall, false) : plainWall, c ? connected(plainFence, true) : plainFence].map((t) => [t.blockId, t]));
    const comp = { cellSize: [1, 0.5, 1] as [number, number, number], bounds: { min: [0, 0, 0] as [number, number, number], max: [40, 16, 40] as [number, number, number] } };
    const g = new BlockGrid(comp);
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) for (let y = 0; y < 3; y++) g.set(x, y, z, { block: y === 2 ? 'grass' : 'stone' });
    // Rooms: cell walls 3 rows high on every sixth line (corners, T-joins and crosses where they meet), fences on the lines between.
    const at: number[] = [];
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) if (x % 6 === 0 || z % 6 === 0) for (let y = 3; y < 6; y++) at.push(x, y, z);
    const fences: number[] = [];
    for (let line = 3; line < 40; line += 6) for (let i = 0; i < 40; i++) if (i % 6 !== 0) fences.push(line, 3, i, 0, i, 3, line, 1);
    expect(applyBlockEdits(g, [{ kind: 'cells', at, cell: { block: 'wall' } }, { kind: 'edges', at: fences, edge: { block: 'fence' } }], { types: typesOf(false), stamps: new Map() }).ok).toBe(true);
    const looks = { source: (t: BlockType, v: number, fm: [number, number, number]) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape === 'none' ? 'full' : t.shape, fm[0], fm[1], fm[2], t.boxes), uv: 'world' as const }) };
    const keys = g.chunkKeys();
    const time = (types: Map<string, BlockType>): { msPerChunk: number; parts: number } => {
      const runs: number[] = [];
      let parts = 0;
      for (let rep = 0; rep < 9; rep++) {
        parts = 0;
        const t0 = performance.now();
        for (const k of keys) {
          const [cx, cz] = k.split(',').map(Number) as [number, number];
          parts += meshBlockChunk(g, cx, cz, types, looks).length;
        }
        runs.push((performance.now() - t0) / keys.length);
      }
      return { msPerChunk: Math.round(median(runs) * 1000) / 1000, parts };
    };
    // One resolution: a cell's and an edge's look from their neighbours.
    const wall = typesOf(true).get('wall')!;
    const fence = typesOf(true).get('fence')!;
    const N = 200_000;
    let t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < N; i++) sink += resolveCellLook(g, wall, { block: 'wall' }, (i % 40), 3 + (i % 3), 0, 0).variant;
    const cellUs = ((performance.now() - t0) * 1000) / N;
    t0 = performance.now();
    for (let i = 0; i < N; i++) sink += resolveEdgeLook(g, fence, { block: 'fence' }, 3, 3, 1 + (i % 5), 0, 0).variant;
    const edgeUs = ((performance.now() - t0) * 1000) / N;
    // An edit at a chunk border: the chunks it re-meshes (its own and the neighbours whose looks it may change).
    g.takeDirty();
    g.set(16, 7, 7, { block: 'wall' });
    const cellChunks = g.takeDirty().mesh.length;
    g.setEdge(16, 4, 9, 1, { block: 'fence' });
    const edgeChunks = g.takeDirty().mesh.length;
    const numbers = {
      chunks: keys.length,
      wallCells: at.length / 3,
      fenceEdges: g.edgeCount,
      mesh: { plain: time(typesOf(false)), connected: time(typesOf(true)) },
      resolveUs: { cell: Math.round(cellUs * 100) / 100, edge: Math.round(edgeUs * 100) / 100 },
      chunksReMeshedByBorderEdit: { cell: cellChunks, edge: edgeChunks },
    };
    record(`block-layers auto-connect 40x40: ${JSON.stringify(numbers)}`);
    expect(sink).toBeGreaterThan(0);
    // Resolving looks costs little next to meshing them; a border edit re-meshes its chunk and the one across.
    expect(numbers.mesh.connected.msPerChunk).toBeLessThan(numbers.mesh.plain.msPerChunk * 1.5);
    expect(numbers.chunksReMeshedByBorderEdit).toEqual({ cell: 2, edge: 2 });
  }, 300_000);

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

  it('wall paint: a 64 × 64 sloped terrain with rooms meshes and colours per chunk with its walls cut at the points', () => {
    const g = slopedTerrain(64);
    const types = new Map(TYPES.map((t) => [t.blockId, t]));
    // Rooms: stone walls 6 rows over the ground on every 16th line, so every chunk has walls besides the slopes' sides.
    const walls: { kind: 'fill'; box: number[]; cell: { block: string } }[] = [];
    for (let line = 8; line < 64; line += 16) {
      walls.push({ kind: 'fill', box: [line, 0, 0, line + 1, 20, 64], cell: { block: 'stone' } }, { kind: 'fill', box: [0, 0, line, 64, 20, line + 1], cell: { block: 'stone' } });
    }
    const dabs = [];
    for (let i = 0; i < 64; i += 4) dabs.push({ kind: 'paint' as const, at: [8.5, i], y: 14, target: 'both' as const, radius: 3, strength: 0.6, channel: 2 }, { kind: 'paint' as const, at: [i, 24.5], y: 12, target: 'walls' as const, radius: 3, strength: 0.6, channel: 4 });
    expect(applyBlockEdits(g, [...walls, ...dabs], { types, stamps: new Map() }).ok).toBe(true);
    const looks = { source: (t: BlockType, v: number, fm: [number, number, number]) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2]), uv: 'world' as const, tangents: true }) };
    const keys = g.chunkKeys();
    // Material rules as a level uses them: rock on steep faces, moss in hollows, a noise patch, mud on low ground.
    const rules = new SurfaceRuleSet([
      { layer: 3, slope: { min: 40, fade: 10 } },
      { layer: 2, cavity: { min: 0.3, fade: 0.3, radius: 2 }, face: 'top' },
      { layer: 1, noise: { scale: 6, min: 0.6, fade: 0.1 }, weight: { layer: 3, max: 0.3 } },
      { layer: 1, height: { max: 5, fade: 1 }, strength: 0.5 },
    ]);
    const run = (wallPaint: boolean, withRules = false): { msPerChunk: number; paintMsPerChunk: number; vertices: number; triangles: number } => {
      const tops = blockTopOptions({ smoothAngle: 40, topSubdivision: 2, wallPaint, cellSize: g.cellSize });
      const mesh: number[] = [];
      const paint: number[] = [];
      let vertices = 0;
      let triangles = 0;
      for (let rep = 0; rep < 5; rep++) {
        vertices = 0;
        triangles = 0;
        let m = 0;
        let c = 0;
        for (const k of keys) {
          const [cx, cz] = k.split(',').map(Number) as [number, number];
          const t0 = performance.now();
          const parts = meshBlockChunk(g, cx, cz, types, looks, tops);
          const t1 = performance.now();
          for (const p of parts) chunkMeshPaint(g, types, cx, cz, { wallPaint, topSubdivision: 2, ...(withRules ? { rules, origin: [0, 0, 0] } : {}) }, p);
          c += performance.now() - t1;
          m += t1 - t0;
          for (const p of parts) {
            vertices += p.positions.length / 3;
            triangles += p.indices.length / 3;
          }
        }
        mesh.push(m / keys.length);
        paint.push(c / keys.length);
      }
      const r = (v: number): number => Math.round(v * 1000) / 1000;
      return { msPerChunk: r(median(mesh)), paintMsPerChunk: r(median(paint)), vertices, triangles };
    };
    let points = 0;
    for (const k of keys) {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      points += g.chunkWallPaint(cx, cz)?.size ?? 0;
    }
    const numbers = { chunks: keys.length, wallPoints: points, wallPointBytes: points * WALL_POINT_BYTES, without: run(false), with: run(true), rules: run(false, true), wallPaintAndRules: run(true, true) };
    record(`block-layers wall paint 64x64: ${JSON.stringify(numbers)}`);
    expect(points).toBeGreaterThan(0);
    expect(numbers.with.vertices).toBeGreaterThan(numbers.without.vertices);
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
