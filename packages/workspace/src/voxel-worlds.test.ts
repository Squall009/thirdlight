/**
 * A project's voxel worlds under failing and foreign writes, with real
 * region files on disk and the workspace's own file operations (failures
 * injected at one step): an edit or an undo whose write fails leaves the
 * files, memory and undo history as they were; a rename failing midway is
 * reported with the files it reached and caught up by the next save; and a
 * region file changed by someone else during a command is never written
 * over (the world is read again, the command refused once).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdit, canonicalEditCommand, chunkGrid, chunkOfKey, createDenseChunk, createWorldStore, exportOrAir, sameDenseChunk, VOXEL_ROLE, type PaletteStore } from '@thirdlight/voxel';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256HexNative } from './digest';
import { openShippedWorld, VoxelWorlds, writeVoxelWorld, type VoxelCommandResult } from './voxel-worlds';
import { listRegionFiles, RegionWorld } from './voxel-world-files';
import { defaultOps, type WriteOps } from './write';

const grid = chunkGrid(32);
const WORLD_ID = 'a0112233445566778899aabbccddeeff';
const root = join(tmpdir(), `tl-voxel-worlds-${process.pid}-${Date.now().toString(36)}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Stone ground across the x = 0 and z = 0 region borders (four regions at a 512-cell footprint). */
function groundStore(): PaletteStore {
  const s = createWorldStore(grid);
  const v = { material: 2, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 };
  for (let x = -40; x < 40; x++) for (let z = -8; z < 8; z++) for (let y = 0; y < 4; y++) s.setVoxel(x, y, z, v);
  return s;
}

/** A dig across the x = 0 region border: one command, two region files (r.-1.0.0 and r.0.0.0). */
const ACROSS = { v: 2, grid: 0, kind: 'fill', min: [-3, 2, 0], max: [2, 3, 1], mode: 'dig' };
const ACROSS_FILES = ['r.-1.0.0.vxr', 'r.0.0.0.vxr'];
/** A dab inside one region. */
const AWAY = { v: 2, grid: 0, kind: 'set', cells: [20, 3, 0], voxel: { material: 0, role: 0, wetness: 0, shape: 0 } };

let worldCount = 0;

/** A project folder with one world; its writes go through `fault.ops` where that names an operation. */
function setUp(residentBytes?: number): { worlds: VoxelWorlds; worldDir: string; gridDir: string; fault: { ops: Partial<WriteOps> | null }; send: (op: 'editVoxels' | 'undo' | 'redo', command?: unknown) => Promise<VoxelCommandResult> } {
  const projectDir = join(root, `p${++worldCount}`);
  const worldDir = join(projectDir, 'voxels', 'w');
  mkdirSync(worldDir, { recursive: true });
  writeVoxelWorld(worldDir, { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, groundStore());
  const fault: { ops: Partial<WriteOps> | null } = { ops: null };
  // Every operation goes through the fault table when one is set; the rest are the real ones.
  const ops = Object.fromEntries(Object.keys(defaultOps).map((k) => [k, (...a: unknown[]) => ((fault.ops?.[k as keyof WriteOps] ?? defaultOps[k as keyof WriteOps]) as (...b: unknown[]) => unknown)(...a)])) as unknown as WriteOps;
  const worlds = new VoxelWorlds({ projectDir: (id) => (id === 'p' ? projectDir : null), writeOps: ops, ...(residentBytes !== undefined ? { residentBytes } : {}) });
  // An undo or redo steps the world's newest stroke that way (what the project's one undo would name).
  const send = (op: 'editVoxels' | 'undo' | 'redo', command?: unknown): Promise<VoxelCommandResult> => (op === 'editVoxels' ? worlds.command('p', { op, projectId: 'p', args: { world: 'w', command } }) : worlds.step('p', 'w', op, worlds.newestStroke('p', 'w', op) ?? -1, null));
  return { worlds, worldDir, gridDir: join(worldDir, 'grid-0'), fault, send };
}

/** Every file of a world folder, by name (temp files included, so leftovers show). */
function filesOf(worldDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sub of ['.', 'grid-0']) for (const n of readdirSync(join(worldDir, sub))) if (n !== 'grid-0') out[`${sub}/${n}`] = readFileSync(join(worldDir, sub, n)).toString('base64');
  return out;
}

/** The world's chunks as the files hold them, equal to the store's. */
async function expectFilesHold(worldDir: string, expected: PaletteStore): Promise<void> {
  const m = openShippedWorld(worldDir);
  const { world } = await RegionWorld.open(m.dir, m.opts, listRegionFiles(m.dir));
  const keys = new Set([...expected.chunkKeys(), ...world.store.chunkKeys()]);
  const a = createDenseChunk(grid);
  const b = createDenseChunk(grid);
  expect(keys.size).toBeGreaterThan(0);
  for (const k of keys) {
    const { cx, cy, cz } = chunkOfKey(grid, k);
    expect(sameDenseChunk(exportOrAir(world.store, cx, cy, cz, a), exportOrAir(expected, cx, cy, cz, b)), `chunk ${cx},${cy},${cz}`).toBe(true);
  }
}

const errno = (code: string): Error => Object.assign(new Error(code), { code });

/** Fails the n-th call (1-based) of an operation from now on. */
function failNth<T extends (...a: never[]) => unknown>(n: number, real: T, code = 'EIO'): T {
  let calls = 0;
  return ((...a: Parameters<T>) => {
    if (++calls === n) throw errno(code);
    return real(...a);
  }) as T;
}

describe('voxel world writes that fail', () => {
  it('an edit whose second file fails to stage replaces no file, and memory and history stay as before', async () => {
    const { worldDir, fault, send } = setUp();
    const oracle = groundStore();
    const away = await send('editVoxels', AWAY);
    expect(away.ok).toBe(true);
    applyEdit({ store: () => oracle }, canonicalEditCommand(AWAY));
    const before = filesOf(worldDir);
    fault.ops = { writeAll: failNth(2, defaultOps.writeAll) };
    const r = await send('editVoxels', ACROSS);
    fault.ops = null;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatchObject({ code: 'write_failed' });
    expect(!r.ok && r.error.message).toMatch(/no file was replaced/);
    // Not a byte changed, no temp file left.
    expect(filesOf(worldDir)).toEqual(before);
    // Memory went back too: undoing the one edit that was written gives the world as first written.
    const undo = await send('undo');
    expect(undo).toMatchObject({ ok: true, cells: 1, undoable: 0, revision: 2 });
    await expectFilesHold(worldDir, groundStore());
    // And the failed edit can be sent again.
    expect(await send('editVoxels', ACROSS)).toMatchObject({ ok: true, revision: 3 });
    applyEdit({ store: () => oracle }, canonicalEditCommand(ACROSS));
  });

  it('an undo whose write fails is taken back: the files, memory and history keep the edit, and the next undo works', async () => {
    const { worldDir, fault, send } = setUp();
    const edited = groundStore();
    const out = applyEdit({ store: () => edited }, canonicalEditCommand(ACROSS));
    expect(await send('editVoxels', ACROSS)).toMatchObject({ ok: true, revision: 1, cells: out.cells });
    const before = filesOf(worldDir);
    fault.ops = { renameFile: failNth(1, defaultOps.renameFile) };
    const failed = await send('undo');
    fault.ops = null;
    expect(!failed.ok && failed.error.code).toBe('write_failed');
    expect(filesOf(worldDir)).toEqual(before);
    await expectFilesHold(worldDir, edited);
    // Memory kept the edit: the next save (another edit's) writes the world with it, not a half-undone one.
    expect(await send('editVoxels', AWAY)).toMatchObject({ ok: true, revision: 2, undoable: 2 });
    applyEdit({ store: () => edited }, canonicalEditCommand(AWAY));
    await expectFilesHold(worldDir, edited);
    // The undo is still there, and undoes the same cells.
    expect(await send('undo')).toMatchObject({ ok: true, cells: 1, undoable: 1, revision: 3 });
    const undo = await send('undo');
    expect(undo).toMatchObject({ ok: true, cells: out.cells, undoable: 0, revision: 4 });
    await expectFilesHold(worldDir, groundStore());
    expect(!((await send('undo')) as { ok: boolean }).ok).toBe(true);
  });

  it('a rename failing midway names the files it reached; memory keeps the edit and the next save writes the rest', async () => {
    const { worldDir, gridDir, fault, send } = setUp();
    const regions = listRegionFiles(gridDir);
    expect(regions).toEqual(expect.arrayContaining(ACROSS_FILES));
    const before = Object.fromEntries(regions.map((n) => [n, readFileSync(join(gridDir, n)).toString('base64')]));
    const manifestBefore = readFileSync(join(worldDir, 'world.json'), 'utf8');
    fault.ops = { renameFile: failNth(2, defaultOps.renameFile) };
    const r = await send('editVoxels', ACROSS);
    fault.ops = null;
    expect(!r.ok && r.error.code).toBe('write_partial');
    // The first file staged was renamed, the second not, nor the manifest (always last).
    const m = /applied in this backend and in (\S+); (\S+), world\.json still hold the state before it/.exec(!r.ok ? r.error.message : '');
    expect(m, !r.ok ? r.error.message : '').not.toBeNull();
    const [first, second] = [m![1]!, m![2]!];
    expect([first, second].sort()).toEqual(ACROSS_FILES);
    expect(readFileSync(join(gridDir, first)).toString('base64')).not.toBe(before[first]);
    expect(readFileSync(join(gridDir, second)).toString('base64')).toBe(before[second]);
    expect(readFileSync(join(worldDir, 'world.json'), 'utf8')).toBe(manifestBefore);
    expect(readdirSync(gridDir).filter((n) => n.includes('.tmp-'))).toEqual([]);
    // The next command's save writes the file that was not reached, and the manifest.
    const oracle = groundStore();
    applyEdit({ store: () => oracle }, canonicalEditCommand(ACROSS));
    applyEdit({ store: () => oracle }, canonicalEditCommand(AWAY));
    expect(await send('editVoxels', AWAY)).toMatchObject({ ok: true, revision: 1, undoable: 2 });
    await expectFilesHold(worldDir, oracle);
    // Both edits undo, newest first, back to the world as first written.
    expect(await send('undo')).toMatchObject({ ok: true, cells: 1 });
    expect(await send('undo')).toMatchObject({ ok: true, undoable: 0 });
    await expectFilesHold(worldDir, groundStore());
  });

  it('a region file changed by someone else while a command writes is not written over: the world is read again, the command refused once', async () => {
    const { worldDir, gridDir, fault, send, worlds } = setUp();
    const regions = listRegionFiles(gridDir);
    // What the other writer puts there: the same tile with a hole of its own (a checkout of other work).
    const theirs = groundStore();
    applyEdit({ store: () => theirs }, canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [-20, 3, 0], voxel: { material: 0, role: 0, wetness: 0, shape: 0 } }));
    const otherDir = join(root, `theirs-${worldCount}`);
    mkdirSync(otherDir, { recursive: true });
    writeVoxelWorld(otherDir, { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, theirs);
    // Their hole is in r.-1.0.0, a file the edit below rewrites.
    const theirs0 = ACROSS_FILES[0]!;
    expect(regions).toContain(theirs0);
    const theirBytes = readFileSync(join(otherDir, 'grid-0', theirs0));
    expect(theirBytes).not.toEqual(readFileSync(join(gridDir, theirs0)));
    // It lands between this process's check and its write (while the files are staged).
    fault.ops = {
      writeAll: (fd, bytes) => {
        writeFileSync(join(gridDir, theirs0), theirBytes);
        fault.ops = null;
        defaultOps.writeAll(fd, bytes);
      },
    };
    const r = await send('editVoxels', ACROSS);
    fault.ops = null;
    expect(!r.ok && r.error).toMatchObject({ code: 'world_changed', cls: 'conflict' });
    expect(!r.ok && r.error.message).toContain(theirs0);
    // Their file stands; the info serves its tag; the world in memory is theirs.
    expect(readFileSync(join(gridDir, theirs0))).toEqual(theirBytes);
    const info = await worlds.info('p', 'w');
    expect(info.ok && info.files.find((f) => f.name === theirs0)?.etag).toBe(sha256HexNative(theirBytes));
    // The edit sent again applies on their world, and nothing of the old undo history is left.
    expect(await send('editVoxels', ACROSS)).toMatchObject({ ok: true, undoable: 1 });
    applyEdit({ store: () => theirs }, canonicalEditCommand(ACROSS));
    await expectFilesHold(worldDir, theirs);
  });
});

describe('a voxel world served on demand', () => {
  it('holds no chunk until an edit reaches a file, loads only the files an edit names, and drops them once saved', async () => {
    // A budget of one byte: every clean file is dropped after each command.
    const { worlds, worldDir, send } = setUp(1);
    const oracle = groundStore();
    const info = await worlds.info('p', 'w');
    expect(info.ok && info.files.length).toBe(4);
    expect(worlds.residency('p', 'w')).toMatchObject({ residentBytes: 0, loaded: 0, listed: 4, loads: 0 });
    expect(await send('editVoxels', ACROSS)).toMatchObject({ ok: true, revision: 1 });
    applyEdit({ store: () => oracle }, canonicalEditCommand(ACROSS));
    // The dig spans two of the four files: only those were read, and both went again once written.
    expect(worlds.residency('p', 'w')).toMatchObject({ residentBytes: 0, loaded: 0, loads: 2, drops: 2 });
    expect(await send('editVoxels', AWAY)).toMatchObject({ ok: true, revision: 2, undoable: 2 });
    applyEdit({ store: () => oracle }, canonicalEditCommand(AWAY));
    await expectFilesHold(worldDir, oracle);
    // An undo reads its chunks' file back before writing the old cells into it.
    expect(await send('undo')).toMatchObject({ ok: true, cells: 1, revision: 3 });
    expect(await send('undo')).toMatchObject({ ok: true, revision: 4, undoable: 0 });
    await expectFilesHold(worldDir, groundStore());
    expect(worlds.residency('p', 'w')).toMatchObject({ residentBytes: 0, loaded: 0 });
    // A file an edit creates (a region nothing was in) is counted once written, and dropped as any clean file is.
    const drops = worlds.residency('p', 'w')!.drops;
    expect(await send('editVoxels', { ...AWAY, cells: [700, 3, 0], voxel: { material: 2, role: VOXEL_ROLE.terrain, wetness: 0, shape: 15 } })).toMatchObject({ ok: true, revision: 5 });
    expect(worlds.residency('p', 'w')).toMatchObject({ residentBytes: 0, loaded: 0, listed: 5, drops: drops + 1 });
  });

  it('keeps the files used last within its budget, and refuses an edit of a file that changed since the world was opened', async () => {
    const { worlds, gridDir, send } = setUp();
    expect(await send('editVoxels', AWAY)).toMatchObject({ ok: true });
    const kept = worlds.residency('p', 'w')!;
    // The default budget keeps the saved file: the next edit there reads nothing again.
    expect(kept.loaded).toBe(1);
    expect(kept.residentBytes).toBeGreaterThan(0);
    // A file an edit creates counts its bytes once written.
    expect(await send('editVoxels', { ...AWAY, cells: [700, 3, 0], voxel: { material: 2, role: VOXEL_ROLE.terrain, wetness: 0, shape: 15 } })).toMatchObject({ ok: true });
    expect(worlds.residency('p', 'w')!.residentBytes).toBeGreaterThan(kept.residentBytes);
    expect(await send('undo')).toMatchObject({ ok: true });
    expect(await send('editVoxels', { ...AWAY, cells: [21, 3, 0] })).toMatchObject({ ok: true });
    expect(worlds.residency('p', 'w')!.loads).toBe(1);
    // A file nobody loaded yet replaced on disk: the next command finds the stamp moved and reads the world again first.
    const other = 'r.-1.0.-1.vxr';
    writeFileSync(join(gridDir, other), readFileSync(join(gridDir, other)).subarray(0, 64));
    const r = await send('editVoxels', ACROSS);
    expect(!r.ok && r.error.code).toBe('world_changed');
    const info = await worlds.info('p', 'w');
    expect(info.ok && info.files.find((f) => f.name === other)?.etag).toBeNull();
  });
});
