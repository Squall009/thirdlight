/**
 * Edit commands, undo, saves, structure overrides, repair and dirty races,
 * on real region files in a scratch folder with real zstd.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, crc32 } from '@thirdlight/shared';
import {
  applyEdit,
  applySave,
  applyUndo,
  canonicalEditCommand,
  chunkGrid,
  chunkKey,
  chunkOfKey,
  chunkWorstUndoBytes,
  createDenseChunk,
  damagedRegionChunks,
  decodeOverrides,
  DEFAULT_REGION_FOOTPRINT,
  decodeUndoRecord,
  DenseReferenceStore,
  EditCommandError,
  editChunks,
  EditRefused,
  encodeOverrides,
  encodeUndoRecord,
  OVERRIDE_CELL_BYTES,
  overridesOf,
  parseRegionFileName,
  readSave,
  reapplyOverrides,
  sameDenseChunk,
  SaveFileError,
  stampShapeHash,
  UNDO_MEMORY_BUDGET_BYTES,
  UndoStore,
  voxel,
  VOXEL_ROLE,
  writeSave,
  type ChunkCoord,
  type ChunkUndo,
  type EditGrids,
  type PaletteStore,
  type RegionReadOptions,
  type StampShape,
  type VoxelEditCommand,
  type VoxelStoreCandidate,
} from '@thirdlight/voxel';
import { defaultWriteOps } from '@thirdlight/workspace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addressName, addressOf, loadArea, pickStore, surfaceY, zstdCompress, zstdDecompress } from './regions';
import { DiskUndoSpill, listRegionFiles, openShippedWorld, readVoxelWorldManifest, RegionWorld, ShippedWorld, updateSave, writeVoxelWorld, type WorldDirOptions } from '@thirdlight/workspace';
import { MAT } from './world-kit';
import { townWorld } from './worlds';

const grid = chunkGrid(32);
const WORLD = Uint8Array.from({ length: 16 }, (_, i) => (i * 53 + 7) & 0xff);
const OPTS: WorldDirOptions = { grid, worldId: WORLD, layout: 'stacked', footprint: DEFAULT_REGION_FOOTPRINT };
const town = townWorld({ footprint: 200 });
const stone = { material: MAT.stone, role: VOXEL_ROLE.wall, wetness: 0 };
const soil = { material: MAT.soil, role: VOXEL_ROLE.terrain, wetness: 0 };
/** What a reader expects of one of this world's region files, by its name. */
const expectIn = (name: string): RegionReadOptions => ({ expect: { worldId: WORLD, gridId: 0, layout: OPTS.layout, grid, footprint: OPTS.footprint, ...parseRegionFileName(OPTS.layout, name)! } });

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'voxel-edits-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function townStore(): PaletteStore {
  const s = pickStore(grid);
  loadArea(town.grids[0]!, s, 0, 0, 400, 400);
  return s;
}

const grids = (s: VoxelStoreCandidate): EditGrids => ({ store: (id) => (id === 0 ? s : undefined) });

/** Every chunk equal in both stores (absent = air). */
function expectSame(a: VoxelStoreCandidate, b: VoxelStoreCandidate): void {
  const x = createDenseChunk(grid);
  const y = createDenseChunk(grid);
  const keys = new Set([...a.chunkKeys(), ...b.chunkKeys()]);
  const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
  let diff = 0;
  for (const k of keys) {
    chunkOfKey(grid, k, c);
    if (!a.exportChunk(c.cx, c.cy, c.cz, x)) x.material.fill(0), x.role.fill(0), x.shape.fill(0), x.wetness.fill(0);
    if (!b.exportChunk(c.cx, c.cy, c.cz, y)) y.material.fill(0), y.role.fill(0), y.shape.fill(0), y.wetness.fill(0);
    if (!sameDenseChunk(x, y)) diff++;
  }
  expect(diff).toBe(0);
}

/** A stamp: a 6 × 4 × 3 arch-like block with a partly covered rim. */
const ARCH: StampShape = (() => {
  const size: [number, number, number] = [6, 4, 3];
  const coverage = new Uint8Array(6 * 4 * 3);
  for (let x = 0; x < 6; x++) for (let z = 0; z < 3; z++) for (let y = 0; y < 4; y++) coverage[(x * 3 + z) * 4 + y] = y >= 2 || x === 0 || x === 5 ? 255 : x === 1 || x === 4 ? 140 : 0;
  return { size, coverage };
})();
const ARCH_HASH = stampShapeHash(ARCH);
const stamps = (id: string) => (id === 'arch' ? { shape: ARCH, hash: ARCH_HASH } : undefined);

/** Strokes around a surface spot of the town. */
function strokesAt(s: VoxelStoreCandidate, x: number, z: number): VoxelEditCommand[] {
  const y = surfaceY(s, x, z, 200, -200)!;
  const yaw = Math.PI / 6;
  return [
    canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [x, y + 1, z, x + 1, y + 1, z], voxel: { ...stone, shape: 15 } }),
    canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [4, 0, 0], points: [x + 0.5, y, z + 0.5, x + 3.2, y + 0.4, z + 1.1], mode: 'dig', smooth: true }),
    canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'cylinder', size: [2.5, 1.5, 0], points: [x + 8, y + 1, z - 3], mode: 'add', voxel: soil, smooth: true }),
    canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [x - 10, y - 16, z + 6], max: [x + 21, y + 15, z + 37], mode: 'place', voxel: stone }),
    canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'box', size: [3, 2, 1], points: [x, y, z + 10], mode: 'paint', voxel: soil, smooth: false }),
    canonicalEditCommand({ v: 2, grid: 0, kind: 'stamp', stamp: { id: 'arch', hash: ARCH_HASH }, origin: [x + 30.25, y + 1, z + 30.75], yaw: [Math.cos(yaw), Math.sin(yaw)], scale: 1.5, mode: 'add', voxel: stone, smooth: true }),
    canonicalEditCommand({ v: 2, grid: 0, kind: 'dig', cells: [x + 31, y - 1, z] }),
  ];
}

describe('edit commands', () => {
  it('are canonical: one payload per stroke, unknown versions, fields and mixes refused', () => {
    const c = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 9, 9], points: [-0, 1, 2], mode: 'dig', smooth: false });
    expect(c).toEqual({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [0, 1, 2], mode: 'dig', smooth: false });
    expect(c.kind === 'brush' && Object.is(c.points[0], 0)).toBe(true);
    const bad: [unknown, string][] = [
      [{ v: 3, grid: 0, kind: 'dig', cells: [0, 0, 0] }, '/v'],
      [{ v: 1, grid: 0, kind: 'dig', cells: [0, 0, 0] }, '/v'],
      [{ v: 2, grid: 0, kind: 'dig', cells: [0, 0, 0], extra: 1 }, '/extra'],
      [{ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [1, 1, 1], points: [0, 0, 0], mode: 'place', voxel: stone, smooth: true }, '/smooth'],
      [{ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [1, 1, 1], points: [0, 0, 0], mode: 'dig', voxel: stone, smooth: false }, '/voxel'],
      [{ v: 2, grid: 0, kind: 'stamp', stamp: { id: 'arch', hash: ARCH_HASH }, origin: [0, 0, 0], yaw: [1, 1], scale: 1, mode: 'add', voxel: stone, smooth: false }, '/yaw'],
      [{ v: 2, grid: 0, kind: 'set', cells: [0, 9000, 0], voxel: { ...stone, shape: 15 } }, '/cells/1'],
      [{ v: 2, grid: 0, kind: 'fill', min: [2, 0, 0], max: [1, 0, 0], mode: 'dig' }, '/max'],
    ];
    for (const [cmd, path] of bad) {
      let err: unknown;
      try {
        canonicalEditCommand(cmd);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EditCommandError);
      expect((err as EditCommandError).path).toBe(path);
    }
  });

  it('apply the same cells on the palette store and the dense oracle, and undo exactly', () => {
    const pick = townStore();
    const dense = new DenseReferenceStore(grid);
    const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    const cells = createDenseChunk(grid);
    for (const k of pick.chunkKeys()) {
      chunkOfKey(grid, k, c);
      pick.exportChunk(c.cx, c.cy, c.cz, cells);
      dense.importChunk(c.cx, c.cy, c.cz, cells);
    }
    const original = townStore();
    const records: ChunkUndo[][] = [];
    const cmds = [...strokesAt(pick, 40, 50), ...strokesAt(pick, 120, 110)];
    for (const cmd of cmds) {
      const a = applyEdit(grids(pick), cmd, { stamps });
      const b = applyEdit(grids(dense), cmd, { stamps });
      expect(a.cells).toBeGreaterThan(0);
      expect(b.cells).toBe(a.cells);
      expect(b.chunks.map((u) => [u.cx, u.cy, u.cz])).toEqual(a.chunks.map((u) => [u.cx, u.cy, u.cz]));
      records.push(a.chunks as ChunkUndo[]);
    }
    expectSame(pick, dense);
    const after = pickStore(grid);
    for (const k of pick.chunkKeys()) {
      chunkOfKey(grid, k, c);
      pick.exportChunk(c.cx, c.cy, c.cz, cells);
      after.importChunk(c.cx, c.cy, c.cz, cells);
    }
    // Some records keep cell deltas, the 16 m fill keeps whole before-images; both survive their bytes.
    const kinds = new Set(records.flat().map((u) => u.before.kind));
    expect(kinds).toEqual(new Set(['delta', 'image']));
    for (let i = records.length - 1; i >= 0; i--) applyUndo(grids(pick), decodeUndoRecord(grid, encodeUndoRecord(grid, records[i]!)));
    expectSame(pick, original);
    // Redo: the same commands on the state they were first applied to give the same voxels.
    for (const cmd of cmds) applyEdit(grids(pick), cmd, { stamps });
    expectSame(pick, after);
    // A command that changes nothing reports no cells (the command layer's no_change).
    expect(applyEdit(grids(pick), cmds[cmds.length - 1]!, { stamps }).cells).toBe(0);
  });

  it('refuse before writing: unknown or changed stamp, unloaded chunk', () => {
    const s = townStore();
    const cmd = strokesAt(s, 100, 100)[5]!;
    const other = { shape: { size: [1, 1, 1] as const, coverage: new Uint8Array([255]) }, hash: '0'.repeat(64) };
    const code = (f: () => unknown): string => {
      try {
        f();
      } catch (e) {
        return e instanceof EditRefused ? e.code : String(e);
      }
      return 'applied';
    };
    expect(code(() => applyEdit(grids(s), cmd, {}))).toBe('stamp_unknown');
    expect(code(() => applyEdit(grids(s), cmd, { stamps: () => other }))).toBe('stamp_changed');
    const fill = strokesAt(s, 100, 100)[3]!;
    let calls = 0;
    expect(code(() => applyEdit(grids(s), fill, { loaded: () => ++calls < 2 }))).toBe('chunk_not_loaded');
    expectSame(s, townStore());
  });

  it('refuse a stroke whose worst-case undo passes the memory budget of one edit, before visiting a cell', () => {
    const s = townStore();
    const code = (f: () => unknown): string => {
      try {
        f();
      } catch (e) {
        return e instanceof EditRefused ? e.code : String(e);
      }
      return 'applied';
    };
    const per = chunkWorstUndoBytes(grid);
    // 32³: 15 + 32,768 × 6 bytes a chunk at worst, so the 64 MiB default fits 341 chunks of any stroke.
    expect(per).toBe(196_623);
    expect(Math.floor(UNDO_MEMORY_BUDGET_BYTES / per)).toBe(341);
    const fill = (x1: number): VoxelEditCommand => canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [0, 0, 0], max: [x1, 31, 31], mode: 'place', voxel: stone });
    // A budget of 4 chunks: a fill over 4 chunks applies, over 5 is refused and writes nothing.
    const budgetBytes = 4 * per;
    expect(code(() => applyEdit(grids(s), fill(4 * 32 + 31), { budgetBytes }))).toBe('over_budget');
    expectSame(s, townStore());
    expect(applyEdit(grids(s), fill(3 * 32 + 31), { budgetBytes }).chunks.length).toBe(4);
    // A long thin brush stroke counts the chunks its dabs reach, not its bounding box: 16 dabs of a 1-cell sphere
    // along a diagonal across 8 chunks on x and z (64 in its box) fit a budget of 9 chunks.
    const points: number[] = [];
    for (let k = 0; k < 16; k++) points.push(40 + k * 16 + 5, 20, 40 + k * 16 + 5);
    const thin = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [1, 1, 1], points, mode: 'dig', smooth: false });
    expect(code(() => applyEdit(grids(townStore()), thin, { budgetBytes: 9 * per }))).toBe('applied');
    expect(code(() => applyEdit(grids(townStore()), thin, { budgetBytes: 7 * per }))).toBe('over_budget');
    // The default budget: the world filled, or a sphere 2 km across, refused at once (no cell visited).
    const t0 = performance.now();
    expect(code(() => applyEdit(grids(s), canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-32768, -8192, -32768], max: [32767, 8191, 32767], mode: 'place', voxel: stone })))).toBe('over_budget');
    expect(code(() => applyEdit(grids(s), canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2000, 0, 0], points: [0, 0, 0], mode: 'dig', smooth: false })))).toBe('over_budget');
    expect(code(() => editChunks(grid, canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-32768, -8192, -32768], max: [32767, 8191, 32767], mode: 'dig' })))).toBe('over_budget');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('undo store', () => {
  it('holds records under a byte budget, spills the oldest to disk and reads them back, one call at a time', async () => {
    const s = townStore();
    const spill = new DiskUndoSpill(join(root, 'undo'));
    const budget = 64 * 1024;
    const undo = new UndoStore(grid, spill, budget);
    const ids: Promise<number>[] = [];
    let x = 20;
    for (let i = 0; i < 12; i++, x += 13) for (const cmd of strokesAt(s, x, 30 + i * 9)) ids.push(undo.put(applyEdit(grids(s), cmd, { stamps }).chunks));
    const all = await Promise.all(ids);
    expect(undo.memoryBytes).toBeLessThanOrEqual(budget);
    expect(undo.spilledRecords).toBeGreaterThan(0);
    expect(readdirSync(spill.dir).length).toBe(undo.spilledRecords);
    for (let i = all.length - 1; i >= 0; i--) applyUndo(grids(s), await undo.take(all[i]!));
    expectSame(s, townStore());
    expect(readdirSync(spill.dir)).toEqual([]);
    expect(undo.memoryBytes).toBe(0);
  });
});

describe('saves', () => {
  it('hold only changed chunks against the shipped world, round trip through zstd, and refuse unknown versions', async () => {
    const dir = join(root, 'shipped-a');
    RegionWorld.create(dir, OPTS, townStore());
    const shipped = new ShippedWorld(dir, OPTS, listRegionFiles(dir));
    const { world } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    const touched = new Map<number, ChunkCoord>();
    for (const cmd of [...strokesAt(world.store, 60, 60), ...strokesAt(world.store, 130, 90)]) {
      for (const u of applyEdit(grids(world.store), cmd, { stamps }).chunks) touched.set(chunkKey(grid, u.cx, u.cy, u.cz), u);
    }
    let save = updateSave({ worldId: WORLD, grid, chunks: [] }, shipped, world.store, 0, touched.values());
    expect(save.chunks.length).toBe(touched.size);
    expect(new Set(save.chunks.map((c) => c.content.kind)).has('delta')).toBe(true);
    const bytes = writeSave(save, 'zstd', zstdCompress);
    expect(writeSave({ ...save, chunks: [...save.chunks].reverse() }, 'zstd', zstdCompress)).toEqual(bytes);
    const back = readSave(bytes, grid, WORLD, zstdDecompress);
    const { world: loaded } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    const r = applySave(back, WORLD, (g) => (g === 0 ? loaded.store : undefined), (c) => shipped.hash(c), () => 'save');
    expect(r.mismatches).toEqual([]);
    expect(r.applied).toBe(save.chunks.length);
    expectSame(loaded.store, world.store);

    // Undoing every edit leaves nothing to save.
    const fresh = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    save = updateSave(save, shipped, fresh.world.store, 0, touched.values());
    expect(save.chunks).toEqual([]);

    // Unknown (newer) version refused; an older one lifted by its steps; damage refused.
    const at = (version: number): Uint8Array => {
      const x = Uint8Array.from(bytes);
      x[4] = version;
      new DataView(x.buffer).setUint32(40, crc32(x.subarray(0, 40)), true);
      return x;
    };
    const v3 = at(3);
    expect(() => readSave(v3, grid, WORLD, zstdDecompress)).toThrow(/unknown version 3/);
    // The draft version 1 is not read.
    expect(() => readSave(at(1), grid, WORLD, zstdDecompress)).toThrow(/unknown version 1/);
    const lifted = readSave(bytes, grid, WORLD, zstdDecompress, [(s) => ({ ...s, chunks: s.chunks.filter((c) => c.content.kind !== 'air') })]);
    expect(lifted.chunks.length).toBeLessThanOrEqual(back.chunks.length);
    expect(() => readSave(v3, grid, WORLD, zstdDecompress, [(s) => s])).not.toThrow();
    const bad = Uint8Array.from(bytes);
    bad[bad.length - 3]! ^= 0x40;
    expect(() => readSave(bad, grid, WORLD, zstdDecompress)).toThrow(SaveFileError);

    // Another world's save is refused by the reader and by the apply, before anything is written.
    const other = Uint8Array.from(WORLD, (b) => b ^ 1);
    expect(() => readSave(bytes, grid, other, zstdDecompress)).toThrow(/save: made for world [0-9a-f]{32}, this world is/);
    const { world: untouched } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    const content = (): string =>
      [...untouched.store.chunkKeys()]
        .map((k) => {
          const c = chunkOfKey(grid, k);
          return Buffer.from(untouched.store.encodeChunk(c.cx, c.cy, c.cz)!).toString('hex');
        })
        .join();
    const before = content();
    expect(() => applySave(back, other, () => untouched.store, (c) => shipped.hash(c), () => 'save')).toThrow(SaveFileError);
    expect(content()).toBe(before);
  });

  it('report a re-exported base chunk the save also changed; the game keeps its save or takes the new base', async () => {
    const dir = join(root, 'shipped-b');
    RegionWorld.create(dir, OPTS, townStore());
    const shipped = new ShippedWorld(dir, OPTS, listRegionFiles(dir));
    const { world: play } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    const y = surfaceY(play.store, 100, 100, 200, -200)!;
    const playerEdit = canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [100, y + 1, 100], voxel: { ...stone, shape: 15 } });
    const touched = applyEdit(grids(play.store), playerEdit).chunks;
    const save = updateSave({ worldId: WORLD, grid, chunks: [] }, shipped, play.store, 0, touched);
    expect(save.chunks.length).toBe(1);

    // The author re-exports with another change in the same chunk.
    const { world: author } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    author.edit(canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [101, y + 1, 101], voxel: { ...soil, shape: 15 } }));
    author.save();
    const reshipped = new ShippedWorld(dir, OPTS, listRegionFiles(dir));
    const back = readSave(writeSave(save, 'zstd', zstdCompress), grid, WORLD, zstdDecompress);
    const v = voxel();
    for (const choice of ['save', 'base'] as const) {
      const { world } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
      const r = applySave(back, WORLD, () => world.store, (c) => reshipped.hash(c), () => choice);
      expect(r.mismatches.length).toBe(1);
      expect(world.store.voxelAt(101, y + 1, 101, v).material).toBe(MAT.soil);
      expect(world.store.voxelAt(100, y + 1, 100, v).material).toBe(choice === 'save' ? MAT.stone : author.store.voxelAt(100, y + 1, 100, voxel()).material);
      expect(r.tookBase.length).toBe(choice === 'base' ? 1 : 0);
    }
  });

  it('keep only the player\'s cells on a re-export, whole-chunk entries too: the dug hole stays, the moved wall stays', async () => {
    const dir = join(root, 'shipped-c');
    RegionWorld.create(dir, OPTS, townStore());
    const shipped = new ShippedWorld(dir, OPTS, listRegionFiles(dir));
    const { world: play } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    // A big hole in the ground under (100, 100): 16 × 16 × 16 cells of one chunk, enough that the save keeps the whole chunk.
    const top = surfaceY(play.store, 100, 100, 200, -200)!;
    const cy = Math.floor((top - 20) / 32);
    const y0 = cy * 32 + 2;
    const hole = (x: number, y: number, z: number): boolean => x >= 96 && x <= 111 && z >= 96 && z <= 111 && y >= y0 && y <= y0 + 15;
    const dug = play.edit(canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [96, y0, 96], max: [111, y0 + 15, 111], mode: 'dig' }));
    expect(dug.cells).toBeGreaterThan(2000);
    const save = updateSave({ worldId: WORLD, grid, chunks: [] }, shipped, play.store, 0, dug.chunks);
    expect(save.chunks.length).toBe(1);
    expect(save.chunks[0]!.content.kind).not.toBe('delta');

    // The author re-exports with a wall moved into that chunk, beside the hole and through one of its cells.
    const { world: author } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    author.edit(canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [110, y0, 100], max: [120, y0 + 12, 101], mode: 'place', voxel: stone }));
    author.save();
    const reshipped = new ShippedWorld(dir, OPTS, listRegionFiles(dir));
    const back = readSave(writeSave(save, 'zstd', zstdCompress), grid, WORLD, zstdDecompress);
    const v = voxel();
    const w = voxel();
    for (const choice of ['save', 'base'] as const) {
      const { world } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
      const r = applySave(back, WORLD, () => world.store, (c) => reshipped.hash(c), () => choice);
      expect(r.mismatches.length).toBe(1);
      // Every cell of the chunk: the player's cells are the player's, every other cell the new base's.
      let differ = 0;
      for (let x = 96; x < 128; x++) for (let z = 96; z < 128; z++) for (let y = cy * 32; y < cy * 32 + 32; y++) {
        world.store.voxelAt(x, y, z, v);
        const want = choice === 'save' && hole(x, y, z) ? voxel() : author.store.voxelAt(x, y, z, w);
        if (v.material !== want.material || v.shape !== want.shape || v.role !== want.role) differ++;
      }
      expect(differ).toBe(0);
      expect(world.store.voxelAt(115, y0 + 5, 100, v).material).toBe(MAT.stone);
      expect(world.store.voxelAt(110, y0 + 5, 100, v).material).toBe(choice === 'save' ? 0 : MAT.stone);
    }
  });

  it('are made against the regions the world lists: one gone or of another world is damaged, never air', async () => {
    const wdir = join(root, 'world-listed');
    writeVoxelWorld(wdir, { worldId: bytesToHex(WORLD), edge: 32, layout: 'stacked', footprint: DEFAULT_REGION_FOOTPRINT }, townStore());
    const m = readVoxelWorldManifest(wdir);
    const play = townStore();
    const name = m.regions[0]!;
    const c = [...play.chunkKeys()].map((k) => chunkOfKey(grid, k)).find((k) => addressName(addressOf(grid, OPTS.layout, OPTS.footprint, k)) === name)!;
    expect(openShippedWorld(wdir).chunkBytes(c)).not.toBeNull();
    // A region the world does not list is air.
    expect(openShippedWorld(wdir).chunkBytes({ cx: 900, cy: 0, cz: 900 })).toBeNull();
    const gdir = join(wdir, 'grid-0');
    const kept = readFileSync(join(gdir, name));
    play.setVoxel(c.cx * 32 + 1, c.cy * 32 + 1, c.cz * 32 + 1, voxel(MAT.stone, VOXEL_ROLE.wall, 15));
    const empty = { worldId: WORLD, grid, chunks: [] };
    expect(updateSave(empty, openShippedWorld(wdir), play, 0, [c]).chunks.length).toBe(1);

    // The listed file is gone: no save is made against air standing in for it, and the repair source does not claim it.
    rmSync(join(gdir, name));
    expect(() => openShippedWorld(wdir).chunkBytes(c)).toThrow(/shipped region .* is listed but damaged/);
    expect(() => updateSave(empty, openShippedWorld(wdir), play, 0, [c])).toThrow(/listed but damaged/);
    expect(await openShippedWorld(wdir).source().chunk(0, c)).toBeUndefined();

    // Another world's file of the same tile in its place: refused by the world id it holds.
    const otherDir = join(root, 'world-listed-other');
    RegionWorld.create(otherDir, { ...OPTS, worldId: Uint8Array.from(WORLD, (b) => b ^ 1) }, townStore());
    writeFileSync(join(gdir, name), readFileSync(join(otherDir, name)));
    expect(() => openShippedWorld(wdir).chunkBytes(c)).toThrow(/world id .*, expected/);
    writeFileSync(join(gdir, name), kept);
    expect(openShippedWorld(wdir).chunkBytes(c)).not.toBeNull();
  });
});

describe('structure overrides', () => {
  /** A test structure (not a generator): a room of `w` × 8 cells, walls 1 cell, 6 high, floor at y 0. */
  function room(w: number): PaletteStore {
    const s = pickStore(grid);
    const wall = voxel(MAT.timber, VOXEL_ROLE.wall, 15);
    const floor = voxel(MAT.plank, VOXEL_ROLE.wall, 15);
    for (let x = 0; x < w; x++) for (let z = 0; z < 8; z++) {
      s.setVoxel(x, 0, z, floor);
      if (x === 0 || x === w - 1 || z === 0 || z === 7) for (let y = 1; y <= 6; y++) s.setVoxel(x, y, z, wall);
    }
    return s;
  }

  it('keep overrides that still fit after regenerating, absorb those the generator now makes, report misfits', () => {
    const generated = room(12);
    const edited = room(12);
    const put = (cells: number[], v: { material: number; role: number; wetness: number; shape: number }) => applyEdit(grids(edited), canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells, voxel: v }));
    put([11, 3, 4], { ...stone, shape: 15 }); // paint a cell of the east wall
    put([5, 2, 0, 5, 3, 0, 6, 2, 0, 6, 3, 0], { material: 0, role: 0, wetness: 0, shape: 0 }); // a window in the north wall
    put([3, 1, 3], { material: MAT.plank, role: VOXEL_ROLE.wall, wetness: 0, shape: 15 }); // a crate inside
    put([15, 1, 3], { material: MAT.timber, role: VOXEL_ROLE.wall, wetness: 0, shape: 15 }); // a post where the wider room will put its wall
    const o = overridesOf(generated, edited, 7);
    const bytes = encodeOverrides(o);
    const back = decodeOverrides(grid, bytes);
    expect(encodeOverrides(back)).toEqual(bytes);
    expect(bytes.length).toBe(16 + 4 + 10 + 7 * OVERRIDE_CELL_BYTES);

    // The room grows to 16 cells: the painted east-wall cell is now inside (air): misfit; the window stays; the crate stays; the post is now generated: absorbed.
    const regenerated = room(16);
    const r = reapplyOverrides(regenerated, back);
    expect(r.misfits.map((m) => m.cell)).toEqual([chunkLocal(11, 3, 4)]);
    expect(r.kept).toBe(5);
    expect(r.absorbed).toBe(1);
    const v = voxel();
    expect(regenerated.voxelAt(5, 2, 0, v).material).toBe(0);
    expect(regenerated.voxelAt(3, 1, 3, v).material).toBe(MAT.plank);
    expect(regenerated.voxelAt(11, 3, 4, v).material).toBe(0);
    expect(encodeOverrides(r.overrides).length).toBe(16 + 4 + 10 + 5 * OVERRIDE_CELL_BYTES);
  });

  function chunkLocal(x: number, y: number, z: number): number {
    return (((x & 31) << 5) | (z & 31)) << 5 | (y & 31);
  }
});

describe('repair, atomic replace and dirty races', () => {
  /** A world folder with one stored chunk's bytes damaged on disk; returns the damaged chunk. */
  function damage(dir: string): ChunkCoord {
    const name = readdirSync(dir).filter((n) => n.endsWith('.vxr')).sort()[0]!;
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    expect(damagedRegionChunks(bytes, expectIn(name))).toEqual([]);
    const h = new DataView(bytes.buffer);
    const entries = h.getUint32(44, true);
    // Flip a byte in the last stored chunk.
    bytes[bytes.length - 5]! ^= 0x5a;
    writeFileSync(join(dir, name), bytes);
    const d = damagedRegionChunks(bytes, expectIn(name));
    expect(d.length).toBe(1);
    expect(entries).toBeGreaterThan(1);
    return { cx: d[0]!.cx, cy: d[0]!.cy, cz: d[0]!.cz };
  }

  it('repairs a damaged chunk from a source, else keeps it damaged, unloaded and carried verbatim', async () => {
    const shippedDir = join(root, 'repair-shipped');
    RegionWorld.create(shippedDir, OPTS, townStore());
    const dir = join(root, 'repair-work');
    cpSync(shippedDir, dir, { recursive: true });
    const bad = damage(dir);
    const key = chunkKey(grid, bad.cx, bad.cy, bad.cz);

    // No source: reported, not loaded, edits into it refused, other edits saved with the damaged bytes carried.
    const kept = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    expect(kept.repairs.map((r) => r.repaired)).toEqual([false]);
    expect(kept.world.damaged.has(key)).toBe(true);
    expect([...kept.world.store.chunkKeys()]).not.toContain(key);
    const x = bad.cx * 32 + 3;
    const z = bad.cz * 32 + 3;
    expect(() => kept.world.edit(canonicalEditCommand({ v: 2, grid: 0, kind: 'dig', cells: [x, bad.cy * 32 + 3, z] }))).toThrow(EditRefused);
    const fileOf = (c: ChunkCoord): string => addressName(addressOf(grid, OPTS.layout, OPTS.footprint, c));
    const neighbour = [...kept.world.store.chunkKeys()].map((k) => chunkOfKey(grid, k)).find((c) => fileOf(c) === fileOf(bad))!;
    kept.world.edit(canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [neighbour.cx * 32 + 1, neighbour.cy * 32 + 1, neighbour.cz * 32 + 1], voxel: { ...stone, shape: 12 } }));
    expect(kept.world.save().files).toBe(1);
    const after = readdirSync(dir).filter((n) => n.endsWith('.vxr')).map((n) => damagedRegionChunks(new Uint8Array(readFileSync(join(dir, n))), expectIn(n))).flat();
    expect(after.map((e) => [e.cx, e.cy, e.cz])).toEqual([[bad.cx, bad.cy, bad.cz]]);

    // With the shipped world as a source: repaired, dirty, and the next save writes it sound.
    const fixed = await RegionWorld.open(dir, OPTS, listRegionFiles(dir), [new ShippedWorld(join(root, 'nowhere'), OPTS, []).source('empty backup'), new ShippedWorld(shippedDir, OPTS, listRegionFiles(shippedDir)).source()]);
    expect(fixed.repairs[0]).toMatchObject({ repaired: true, source: 'shipped world' });
    expect(fixed.world.tracker.isDirty({ grid: 0, key })).toBe(true);
    fixed.world.save();
    for (const n of readdirSync(dir).filter((f) => f.endsWith('.vxr'))) expect(damagedRegionChunks(new Uint8Array(readFileSync(join(dir, n))), expectIn(n))).toEqual([]);
  });

  it('replaces files atomically: a failed rename leaves the old file and the chunk dirty', async () => {
    const dir = join(root, 'atomic');
    RegionWorld.create(dir, OPTS, townStore());
    const { world } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    const y = surfaceY(world.store, 77, 77, 200, -200)!;
    world.edit(canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [77, y + 1, 77], voxel: { ...stone, shape: 15 } }));
    const [p] = world.prepareSaves();
    const before = readFileSync(join(dir, p!.name));
    const failing = { ...defaultWriteOps, renameFile: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    const r = world.commit(p!, failing);
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dir, p!.name))).toEqual(before);
    expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(world.tracker.dirty().length).toBe(1);
    expect(world.save().files).toBe(1);
    expect(world.tracker.dirty()).toEqual([]);
  });

  it('survives unload, save and worker-timeout races', async () => {
    const dir = join(root, 'races');
    RegionWorld.create(dir, OPTS, townStore());
    const { world } = await RegionWorld.open(dir, OPTS, listRegionFiles(dir));
    const y = surfaceY(world.store, 90, 90, 200, -200)!;
    const set = (m: number) => world.edit(canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [90, y + 1, 90], voxel: { material: m, role: VOXEL_ROLE.wall, wetness: 0, shape: 15 } }));
    const key = chunkKey(grid, 90 >> 5, (y + 1) >> 5, 90 >> 5);
    const chunk = { grid: 0, key };
    const fileVoxel = async (): Promise<number> => (await RegionWorld.open(dir, OPTS, listRegionFiles(dir))).world.store.voxelAt(90, y + 1, 90, voxel()).material;

    // An edit while a save runs: the save writes its snapshot, the chunk stays dirty, the next save writes the edit.
    set(MAT.stone);
    const [a] = world.prepareSaves();
    expect(world.tracker.canUnload(chunk)).toBe(false);
    set(MAT.brick);
    expect(world.tracker.unload(chunk)).toBe(false);
    expect(world.commit(a!).ok).toBe(true);
    expect(await fileVoxel()).toBe(MAT.stone);
    expect(world.tracker.isDirty(chunk)).toBe(true);
    expect(world.tracker.canUnload(chunk)).toBe(false);
    world.save();
    expect(await fileVoxel()).toBe(MAT.brick);
    expect(world.tracker.canUnload(chunk)).toBe(true);

    // A save job times out; a newer job saves; the late one's commit is refused and cannot overwrite.
    set(MAT.plaster);
    const [late] = world.prepareSaves();
    expect(world.prepareSaves()).toEqual([]);
    world.tracker.expireSave(late!.job.id);
    set(MAT.plank);
    const [newer] = world.prepareSaves();
    expect(world.commit(newer!).ok).toBe(true);
    expect(world.commit(late!)).toEqual({ ok: false, why: 'expired' });
    expect(await fileVoxel()).toBe(MAT.plank);
    expect(world.tracker.isDirty(chunk)).toBe(false);

    // A mesh job started before an edit: its result is superseded; a timed-out job's late result is unknown.
    const mesh = world.tracker.beginJob(chunk);
    set(MAT.stone);
    expect(world.tracker.acceptResult(mesh.id)).toEqual({ ok: false, reason: 'superseded' });
    const slow = world.tracker.beginJob(chunk);
    world.tracker.expireJob(slow.id);
    expect(world.tracker.acceptResult(slow.id)).toEqual({ ok: false, reason: 'unknown_job' });
    const fresh = world.tracker.beginJob(chunk);
    expect(world.tracker.acceptResult(fresh.id)).toEqual({ ok: true });
  });
});
