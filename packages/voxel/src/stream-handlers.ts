/**
 * The streaming jobs a worker runs (stream-job.ts has the contract): the
 * per-cell work of streaming done off the main thread, which then only
 * adopts the returned arrays.
 *
 * Each job works in a private scratch store holding just the chunks it was
 * sent, emptied again when it ends, so a worker keeps no world state: any
 * worker can run any job, and a worker that is replaced loses nothing.
 * The decompressor is passed in (fzstd in browser workers; any zstd frame
 * decoder in Node), keeping this module free of codecs and Node built-ins.
 */
import { apronVoxelAt, checkApron, checkRadius } from './apron';
import { assemblyRules, jobRadius } from './assembly';
import { deriveWithApron } from './derive-assembly';
import { derivedTransfer, encodeDerived } from './derived-data';
import { crc32 } from '@thirdlight/shared';
import { CellDelta, exportOrAir } from './cell-delta';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { payloadTransfer } from './chunk-wire';
import { CHUNK_EDGES, chunkGrid, chunkOfKey, type ChunkEdge, type ChunkGrid } from './coords';
import { applyEdit } from './edit-apply';
import { canonicalEditCommand } from './edit-command';
import type { JobHandlers, JobResult } from './job-worker';
import { createWorldStore, type PaletteStore } from './palette-store';
import { ALL_DERIVED_PARTS, DERIVED_PART, MATERIAL_AIR, valueMaterial, type VoxelRecord } from './record';
import { encodeShader, shaderDataOf } from './derived-shader';
import { regionChunkCodecBytes, type RegionChunkRead } from './region-file';
import { applySaveChunk, baseChunkHash, sameHash, saveContentFromPayload } from './save-file';
import { stampShapeHash, type StampResolver } from './stamp-shape';
import { encodeUndoRecord } from './undo-store';
import type { ApplySaveInput, ApplySaveOutput, ChunkRef, DeriveInput, DeriveOutput, EditInput, EditOutput, LoadInput, LoadOutput, StoredChunk } from './stream-job';

export interface StreamHandlerOptions {
  /** Decompresses one stored chunk's zstd frame. */
  decompress(bytes: Uint8Array): Uint8Array;
}

const scratch = new Map<number, PaletteStore>();

/** The worker's scratch store for an edge (empty between jobs). */
function storeFor(edge: ChunkEdge): PaletteStore {
  if (!CHUNK_EDGES.includes(edge)) throw new RangeError(`chunk edge ${String(edge)}`);
  let s = scratch.get(edge);
  if (s === undefined) {
    s = createWorldStore(chunkGrid(edge), 'worker');
    scratch.set(edge, s);
  }
  return s;
}

/** Empties a scratch store (whatever a job left in it). */
function clear(store: PaletteStore): void {
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of [...store.chunkKeys()]) {
    chunkOfKey(store.grid, key, c);
    store.dropChunk(c.cx, c.cy, c.cz);
  }
}

function checkRef(c: ChunkRef): void {
  for (const v of [c.grid, c.cx, c.cy, c.cz]) if (!Number.isInteger(v)) throw new RangeError('chunk reference is not integers');
}

/** A stored chunk as a region read, for the shared decompress-and-check path. */
function readOf(c: ChunkRef, b: StoredChunk): RegionChunkRead {
  if ('uniform' in b) return b.uniform === 0 ? { cx: c.cx, cy: c.cy, cz: c.cz, kind: 'air' } : { cx: c.cx, cy: c.cy, cz: c.cz, kind: 'uniform', value: b.uniform };
  return { cx: c.cx, cy: c.cy, cz: c.cz, kind: 'stored', bytes: b.stored, raw: b.raw };
}

/** Puts a chunk's codec bytes (null: air) into the store. */
function put(store: PaletteStore, c: ChunkRef, codec: Uint8Array | null): void {
  if (codec === null) store.dropChunk(c.cx, c.cy, c.cz);
  else store.decodeChunk(c.cx, c.cy, c.cz, codec);
}

function load(opts: StreamHandlerOptions, raw: unknown): JobResult {
  const input = raw as LoadInput;
  checkRef(input.chunk);
  const store = storeFor(input.edge);
  const c = input.chunk;
  try {
    const t0 = performance.now();
    const read = readOf(c, input.bytes);
    const codec = regionChunkCodecBytes(store.grid, read, opts.decompress);
    const t1 = performance.now();
    put(store, c, codec);
    const payload = store.chunkPayload(c.cx, c.cy, c.cz, false);
    const t2 = performance.now();
    const output: LoadOutput = { payload, hash: input.hash ? baseChunkHash(store.grid, codec) : null, decompressUs: (t1 - t0) * 1000, decodeUs: (t2 - t1) * 1000 };
    return { output, transfer: payloadTransfer(payload, output.hash === null ? [] : [output.hash.buffer as ArrayBuffer]) };
  } finally {
    clear(store);
  }
}

function applySave(opts: StreamHandlerOptions, raw: unknown): JobResult {
  const input = raw as ApplySaveInput;
  checkRef(input.chunk);
  const store = storeFor(input.edge);
  const c = input.chunk;
  try {
    const codec = input.base === null ? null : regionChunkCodecBytes(store.grid, readOf(c, input.base), opts.decompress);
    const baseNow = baseChunkHash(store.grid, codec);
    const mismatch = !sameHash(baseNow, input.expect);
    const applied = !mismatch || input.onMismatch === 'save';
    put(store, c, codec);
    if (applied) applySaveChunk(store, { grid: c.grid, cx: c.cx, cy: c.cy, cz: c.cz, base: input.expect, content: saveContentFromPayload(store.grid, input.content.kind, input.content.payload) }, !mismatch);
    const payload = store.chunkPayload(c.cx, c.cy, c.cz, false);
    const output: ApplySaveOutput = { payload, mismatch, applied, baseNow };
    return { output, transfer: payloadTransfer(payload, [baseNow.buffer as ArrayBuffer]) };
  } finally {
    clear(store);
  }
}

function edit(raw: unknown): JobResult {
  const input = raw as EditInput;
  const store = storeFor(input.edge);
  try {
    const cmd = canonicalEditCommand(input.command);
    const held = new Set<string>();
    for (const { chunk, payload } of input.chunks) {
      checkRef(chunk);
      if (chunk.grid !== cmd.grid) throw new RangeError(`edit job: chunk of grid ${chunk.grid} for a command on grid ${cmd.grid}`);
      store.adoptPayload(chunk.cx, chunk.cy, chunk.cz, payload);
      held.add(`${chunk.cx},${chunk.cy},${chunk.cz}`);
    }
    const shapes = new Map((input.stamps ?? []).map((s) => [s.id, { shape: s.shape, hash: stampShapeHash(s.shape) }]));
    const stamps: StampResolver = (id) => shapes.get(id);
    const outcome = applyEdit({ store: (g) => (g === cmd.grid ? store : undefined) }, cmd, { stamps, loaded: (_g, cx, cy, cz) => held.has(`${cx},${cy},${cz}`) });
    const undo = encodeUndoRecord(store.grid, outcome.chunks);
    const chunks = outcome.chunks.map((u) => ({ chunk: { grid: u.grid, cx: u.cx, cy: u.cy, cz: u.cz }, payload: store.chunkPayload(u.cx, u.cy, u.cz, false) }));
    const output: EditOutput = { cells: outcome.cells, chunks, undo, fields: outcome.fields };
    const transfer: ArrayBuffer[] = [undo.buffer as ArrayBuffer];
    for (const ch of chunks) payloadTransfer(ch.payload, transfer);
    return { output, transfer };
  } finally {
    clear(store);
  }
}

/** FNV-1a over 32-bit words. */
function fnv(words: Uint32Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    let w = words[i]!;
    for (let b = 0; b < 4; b++) {
      h ^= w & 0xff;
      h = Math.imul(h, 0x01000193);
      w >>>= 8;
    }
  }
  return h >>> 0;
}

/**
 * Grows the set cells of `a` (a cube of side s, index (x·s + z)·s + y) by r
 * along one axis (stride: 1 for y, s for z, s² for x), into `out`: a cell
 * is set when any cell within r of it along that axis is. Running counts
 * make it O(cells) whatever r is.
 */
function dilate(a: Uint8Array, out: Uint8Array, s: number, r: number, stride: number): void {
  const lines = s * s;
  for (let line = 0; line < lines; line++) {
    // The first cell of the line: lines run over the two other axes.
    const hi = Math.floor(line / s);
    const lo = line % s;
    const base = stride === 1 ? line * s : stride === s ? hi * s * s + lo : hi * s + lo;
    let count = 0;
    for (let k = 0; k < Math.min(r, s); k++) count += a[base + k * stride]!;
    for (let i = 0; i < s; i++) {
      if (i + r < s) count += a[base + (i + r) * stride]!;
      if (i - r - 1 >= 0) count -= a[base + (i - r - 1) * stride]!;
      out[base + i * stride] = count > 0 ? 1 : 0;
    }
  }
}

function derive(raw: unknown): JobResult {
  const input = raw as DeriveInput;
  checkRef(input.chunk);
  const store = storeFor(input.edge);
  const g = store.grid;
  const e = g.edge;
  const r = input.radius;
  checkRadius(e, r);
  checkApron(input.apron);
  if (input.apron.edge !== e || input.apron.radius !== r) throw new RangeError('derive job: apron of another edge or radius');
  const c = input.chunk;
  try {
    store.adoptPayload(c.cx, c.cy, c.cz, input.payload);
    const parts = input.parts ?? ALL_DERIVED_PARTS;
    if ((parts & ALL_DERIVED_PARTS) !== parts || parts === 0) throw new RangeError(`derive job: parts ${parts}`);
    if (parts === DERIVED_PART.shader) {
      // Material and wetness feed only the shader data, which reads the chunk's own cells.
      const shader = shaderDataOf(g, exportOrAir(store, c.cx, c.cy, c.cz, scratchCells(g)));
      const output: DeriveOutput = { solid: 0, exposed: 0, mask: null, hash: crc32(encodeShader(shader)), assembly: null, shader };
      return { output, transfer: [shader.palette.buffer as ArrayBuffer, shader.ids.buffer as ArrayBuffer] };
    }
    if (input.rules !== undefined) {
      const rules = assemblyRules(input.rules);
      if (jobRadius(rules) !== r) throw new RangeError(`derive job: radius ${r} for rules ${rules.id} v${rules.version} (needs ${jobRadius(rules)})`);
      const assembly = deriveWithApron(g, rules, input.apron, (out) => store.exportChunk(c.cx, c.cy, c.cz, out));
      const output: DeriveOutput = { solid: 0, exposed: 0, mask: null, hash: crc32(encodeDerived(assembly)), assembly, shader: null };
      return { output, transfer: derivedTransfer(assembly) };
    }
    const output = exposure(store, c, input);
    return { output, transfer: output.mask === null ? [] : [output.mask.buffer as ArrayBuffer] };
  } finally {
    clear(store);
  }
}

const EMPTY: DeriveOutput = Object.freeze({ solid: 0, exposed: 0, mask: null, hash: 0, assembly: null, shader: null });

const cellScratch = new Map<number, DenseChunk>();

function scratchCells(g: ChunkGrid): DenseChunk {
  let c = cellScratch.get(g.edge);
  if (c === undefined) cellScratch.set(g.edge, (c = createDenseChunk(g)));
  return c;
}

/** The derive placeholder: solid cells with an air cell within R (Chebyshev), from the chunk and its apron. */
function exposure(store: PaletteStore, c: ChunkRef, input: DeriveInput): DeriveOutput {
  const g = store.grid;
  const e = g.edge;
  const r = input.radius;
  const p = input.payload;
  if (p.form === 'air') return EMPTY;
  const a = input.apron;
  // One solid voxel everywhere and solid all around within R: nothing is exposed.
  if (p.form === 'uniform' && (r === 0 || a.dense.every((d, k) => d === 0 && valueMaterial(a.uniform[k]!) !== MATERIAL_AIR))) {
    return { solid: g.cellsPerChunk, exposed: 0, mask: null, hash: 0, assembly: null, shader: null };
  }
  const s = e + 2 * r;
  const air = new Uint8Array(s * s * s);
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const ox = c.cx << g.shift;
  const oy = c.cy << g.shift;
  const oz = c.cz << g.shift;
  for (let x = 0; x < s; x++) for (let z = 0; z < s; z++) for (let y = 0; y < s; y++) {
    const lx = x - r;
    const ly = y - r;
    const lz = z - r;
    const inside = lx >= 0 && lx < e && ly >= 0 && ly < e && lz >= 0 && lz < e;
    if (inside) store.voxelAt(ox + lx, oy + ly, oz + lz, v);
    else apronVoxelAt(a, lx, ly, lz, v);
    air[(x * s + z) * s + y] = v.material === MATERIAL_AIR ? 1 : 0;
  }
  const t = new Uint8Array(air.length);
  dilate(air, t, s, r, 1);
  const u = new Uint8Array(air.length);
  dilate(t, u, s, r, s);
  dilate(u, t, s, r, s * s);
  const mask = new Uint32Array(g.cellsPerChunk >>> 5);
  let solid = 0;
  let exposed = 0;
  for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) for (let ly = 0; ly < e; ly++) {
    const k = ((lx + r) * s + (lz + r)) * s + (ly + r);
    if (air[k] === 1) continue;
    solid++;
    if (t[k] === 0) continue;
    exposed++;
    const i = (((lx << g.shift) | lz) << g.shift) | ly;
    mask[i >>> 5]! |= 1 << (i & 31);
  }
  if (exposed === 0) return { solid, exposed, mask: null, hash: 0, assembly: null, shader: null };
  return { solid, exposed, mask, hash: fnv(mask), assembly: null, shader: null };
}

/** The stream job handlers ({@link serveJobs} serves them). */
export function streamJobHandlers(opts: StreamHandlerOptions): JobHandlers {
  return {
    load: (input) => load(opts, input),
    'apply-save': (input) => applySave(opts, input),
    edit: (input) => edit(input),
    derive: (input) => derive(input),
  };
}

/** The derive placeholder run in the calling thread (tests, and a main-thread fallback with no workers). */
export function deriveNow(input: DeriveInput): DeriveOutput {
  return derive(input).output as DeriveOutput;
}
