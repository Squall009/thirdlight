/**
 * The runtime overlay over an authored base, and what a save keeps of it:
 * only the fields the game marks saved, merged onto the base, through the
 * save format (changed-cell masks and base hashes as for any save).
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_PLANES,
  applyEdit,
  applySave,
  baseChunkHash,
  canonicalEditCommand,
  chunkGrid,
  createWorldStore,
  DEFAULT_SAVED_FIELDS,
  PLANE_BIT,
  readSave,
  recordValue,
  savedValue,
  SHAPE_FULL,
  voxel,
  VOXEL_ROLE,
  VoxelOverlay,
  writeSave,
  type PaletteStore,
  type SaveChunk,
} from './index';

const grid = chunkGrid(32);
const WORLD = Uint8Array.from({ length: 16 }, (_, i) => i + 7);
const ROCK = 1;

/** Rock up to y 8 (exclusive) over x, z in [0, 64): four chunks of ground. */
function base(top = 8): PaletteStore {
  const s = createWorldStore(grid);
  s.applyStroke({ kind: 'box', min: [0, 0, 0], max: [63, top - 1, 63], voxel: voxel(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0) });
  return s;
}

const rain = (wetness: number): ReturnType<typeof canonicalEditCommand> =>
  canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [0, 7, 0], max: [63, 7, 63], mode: 'paint', voxel: { material: ROCK, role: VOXEL_ROLE.terrain, wetness } });
const dig = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [10, 5, 10], max: [12, 7, 12], mode: 'dig' });

function roundTrip(chunks: readonly SaveChunk[]): readonly SaveChunk[] {
  const bytes = writeSave({ worldId: WORLD, grid, chunks }, 'none', (b) => b);
  return readSave(bytes, grid, WORLD, (b) => b).chunks;
}

describe('the runtime overlay', () => {
  it('reads through to the base, holds a changed cell as one value, and forgets a cell set back to its base', () => {
    const b = base();
    const o = new VoxelOverlay(b);
    const v = voxel();
    expect(o.voxelAt(3, 2, 3, v)).toEqual(voxel(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0));
    o.setVoxel(3, 7, 3, voxel(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 6));
    expect(o.voxelAt(3, 7, 3, v).wetness).toBe(6);
    expect(b.voxelAt(3, 7, 3, v).wetness).toBe(0);
    expect(o.changedCells).toBe(1);
    expect(o.memoryBytes()).toBe(8 * 6);
    o.setVoxel(3, 7, 3, voxel(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0));
    expect(o.changedCells).toBe(0);
    expect(o.changedChunks()).toEqual([]);
  });

  it('takes stroke commands like any store; the base is never written', () => {
    const b = base();
    const before = b.encodeChunk(0, 0, 0);
    const o = new VoxelOverlay(b);
    const out = applyEdit({ store: () => o }, rain(4));
    expect(out.cells).toBe(64 * 64);
    expect(out.fields).toBe(PLANE_BIT.wetness);
    expect(applyEdit({ store: () => o }, dig).fields).toBe(PLANE_BIT.material | PLANE_BIT.role | PLANE_BIT.shape | PLANE_BIT.wetness);
    expect(b.encodeChunk(0, 0, 0)).toEqual(before);
    expect(o.voxelAt(11, 6, 11, voxel()).material).toBe(0);
    expect(o.voxelAt(20, 7, 20, voxel()).wetness).toBe(4);
    o.clear();
    expect(o.voxelAt(20, 7, 20, voxel()).wetness).toBe(0);
  });
});

describe('what a save keeps of the overlay', () => {
  it('merges only the saved fields onto the base value', () => {
    const rock = recordValue(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
    const wetRock = recordValue(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 5);
    const wetHalf = recordValue(ROCK, VOXEL_ROLE.terrain, 7, 5);
    expect(savedValue(rock, wetRock, DEFAULT_SAVED_FIELDS)).toBe(rock);
    expect(savedValue(rock, wetHalf, DEFAULT_SAVED_FIELDS)).toBe(recordValue(ROCK, VOXEL_ROLE.terrain, 7, 0));
    expect(savedValue(rock, wetHalf, ALL_PLANES)).toBe(wetHalf);
    expect(savedValue(rock, 0, DEFAULT_SAVED_FIELDS)).toBe(0);
    expect(savedValue(rock, 0, PLANE_BIT.wetness)).toBe(rock);
    expect(savedValue(0, wetRock, DEFAULT_SAVED_FIELDS)).toBe(wetRock);
  });

  it('rain alone leaves nothing to save by default; the game can choose to keep wetness', () => {
    const o = new VoxelOverlay(base());
    applyEdit({ store: () => o }, rain(6));
    expect(o.changedChunks()).toHaveLength(4);
    expect(o.saveChunks(0)).toEqual([]);
    const kept = roundTrip(o.saveChunks(0, ALL_PLANES));
    expect(kept).toHaveLength(4);
    const loaded = createWorldStore(grid);
    for (let cx = 0; cx < 2; cx++) for (let cz = 0; cz < 2; cz++) loaded.decodeChunk(cx, 0, cz, base().encodeChunk(cx, 0, cz)!);
    applySave({ worldId: WORLD, grid, chunks: kept }, WORLD, () => loaded, (c) => baseChunkHash(grid, base().encodeChunk(c.cx, c.cy, c.cz)), () => 'save');
    expect(loaded.voxelAt(40, 7, 40, voxel()).wetness).toBe(6);
  });

  it('keeps a dig over rain without the rain: changed-cell masks and base hashes as for any save, a re-exported base keeps its own cells', () => {
    const shipped = base();
    const o = new VoxelOverlay(shipped);
    applyEdit({ store: () => o }, rain(6));
    applyEdit({ store: () => o }, dig);
    const entries = roundTrip(o.saveChunks(0));
    // Only the chunk with the hole: the rain in the other three is not kept.
    expect(entries.map((e) => [e.cx, e.cy, e.cz])).toEqual([[0, 0, 0]]);
    const entry = entries[0]!;
    expect(entry.base).toEqual(baseChunkHash(grid, shipped.encodeChunk(0, 0, 0)));
    // The player's cells are the 27 dug ones, whatever form the entry took.
    const cells = entry.content.kind === 'delta' ? entry.content.delta.count : entry.content.mask.reduce((n, b) => n + popcount(b), 0);
    expect(cells).toBe(27);
    // On the shipped base: the hole, and dry rock around it.
    const same = base();
    const r = applySave({ worldId: WORLD, grid, chunks: entries }, WORLD, () => same, () => entry.base, () => 'save');
    expect(r.applied).toBe(1);
    const v = voxel();
    expect(same.voxelAt(11, 6, 11, v).material).toBe(0);
    expect(same.voxelAt(20, 7, 20, v)).toEqual(voxel(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0));
    // On a re-exported base (the ground two cells higher): the player's cells win, every other cell is the new base's.
    const reexport = base(10);
    const r2 = applySave({ worldId: WORLD, grid, chunks: entries }, WORLD, () => reexport, (c) => baseChunkHash(grid, reexport.encodeChunk(c.cx, c.cy, c.cz)), () => 'save');
    expect(r2.mismatches).toHaveLength(1);
    expect(reexport.voxelAt(11, 6, 11, v).material).toBe(0);
    expect(reexport.voxelAt(11, 9, 11, v).material).toBe(ROCK);
    expect(reexport.voxelAt(20, 9, 20, v).material).toBe(ROCK);
  });
});

function popcount(b: number): number {
  let n = 0;
  for (let v = b; v !== 0; v &= v - 1) n++;
  return n;
}
