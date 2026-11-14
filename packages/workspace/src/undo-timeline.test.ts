/**
 * The project's one undo through the real workspace service and real voxel
 * worlds on disk: scene edits and voxel strokes interleaved are undone in
 * reverse order and redone in order, a redo writes back exactly the voxels
 * the undo took (the region files' bytes equal to the edit's), a new edit of
 * either kind ends the redo of both, a stroke its world no longer holds
 * (the world read again after a checkout, or deleted) is skipped and named
 * instead of stopping every later undo, a project history started afresh
 * keeps the strokes, a resent undo steps once, and a stale revision is
 * refused (the project's for the one undo, the world's for a stroke).
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldStore, chunkGrid, VOXEL_ROLE } from '@thirdlight/voxel';
import { afterAll, describe, expect, it } from 'vitest';
import { openWorkspaceService } from './service';
import { UndoTimeline, type TimelineStep } from './undo-timeline';
import { VoxelWorlds, writeVoxelWorld, type VoxelCommandResult } from './voxel-worlds';
import type { StageInspector, WorkspaceService } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const stubInspector: StageInspector = () => {
  throw new Error('not used');
};
const grid = chunkGrid(32);
const WORLD_ID = 'b0112233445566778899aabbccddeeff';
const P = 'game';
let n = 0;
const rid = (): string => `req-${(0x7140000 + ++n).toString(16).padStart(32, '0')}`;

/** A project with one object and two voxel worlds of stone ground (`a`, `b`), the service, the worlds and the one line. */
function setUp(tag: string): { service: WorkspaceService; worlds: VoxelWorlds; line: UndoTimeline; worldDir: (w: string) => string; entity: string } {
  const base = join(tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir(), `.tl-undo-line-${tag}-${process.pid}-${Date.now().toString(36)}`);
  roots.push(base);
  mkdirSync(join(base, 'data'), { recursive: true });
  const service = openWorkspaceService({ root: join(base, 'data'), assetInspector: stubInspector });
  const game = join(base, 'game');
  expect(service.createProjectInFolder(game, P, 'Game').ok).toBe(true);
  const projectDir = service.projectDir(P)!;
  const worldDir = (w: string): string => join(projectDir, 'voxels', w);
  for (const w of ['a', 'b']) {
    mkdirSync(worldDir(w), { recursive: true });
    const s = createWorldStore(grid);
    for (let x = -8; x < 8; x++) for (let z = -8; z < 8; z++) for (let y = 0; y < 4; y++) s.setVoxel(x, y, z, { material: 2, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
    writeVoxelWorld(worldDir(w), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, s);
  }
  const worlds = new VoxelWorlds({ projectDir: (id) => (id === P ? projectDir : null) });
  const line = new UndoTimeline(service, worlds);
  const sceneId = ((service.query({ op: 'queryProject', projectId: P, args: {} }) as unknown as { scene: { sceneId: string } }).scene).sceneId;
  const made = run(service, 'createEntity', { sceneId, parentId: null, kind: 'group', name: 'Crate', transform: { position: [0, 0, 0] } });
  return { service, worlds, line, worldDir, entity: made.createdId! };
}

const revision = (service: WorkspaceService): number => (service.query({ op: 'queryProject', projectId: P, args: {} }) as unknown as { revision: number }).revision;

function run(service: WorkspaceService, op: string, args: Record<string, unknown>): { ok: boolean; createdId?: string } {
  const r = service.runCommand({ op, projectId: P, expectedRevision: revision(service), requestId: rid(), origin: { kind: 'mcp', clientId: 'vitest' }, args }) as unknown as { ok: boolean; createdId?: string };
  expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
  return r;
}

const move = (service: WorkspaceService, entity: string, x: number): void => void run(service, 'setTransform', { entityId: entity, transform: { position: [x, 0, 0] } });
const xOf = (service: WorkspaceService, entity: string): number => ((service.query({ op: 'queryEntity', projectId: P, args: { entityId: entity } }) as unknown as { entity: { components: { transform: { position: number[] } } } }).entity.components.transform.position[0])!;

/** A 1 m dig at (x, 3, 0) in a world, through the line. */
async function dig(line: UndoTimeline, world: string, x: number, extra: Record<string, unknown> = {}): Promise<VoxelCommandResult> {
  return line.voxelCommand(P, { op: 'editVoxels', projectId: P, requestId: rid(), ...extra, args: { world, command: { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [x, 3, 0], mode: 'dig', smooth: false } } });
}

const step = (service: WorkspaceService, line: UndoTimeline, op: 'undo' | 'redo', requestId = rid(), expectedRevision = revision(service)): Promise<TimelineStep> => line.step(P, op, { op, projectId: P, expectedRevision, requestId, origin: { kind: 'mcp', clientId: 'vitest' }, args: {} });

/** What a step did, in a word: a project entry, a world's stroke, or the refusal's code. */
function kind(s: TimelineStep): string {
  if (s.kind === 'refused') return s.error.code;
  if (s.kind === 'voxel') return s.result.ok ? `voxel ${s.result.world} ${s.result.op}` : s.result.error.code;
  return s.result.ok ? 'project' : s.result.error.code;
}

/** The world's region files' bytes, by name (what the voxels are on disk). */
function regions(dir: string): Record<string, string> {
  const g = join(dir, 'grid-0');
  return Object.fromEntries(readdirSync(g).sort().map((f) => [f, readFileSync(join(g, f)).toString('base64')]));
}

describe('the one undo', () => {
  it('undoes a scene edit, a voxel stroke and a scene edit in reverse order and redoes them in order; the redo writes back the exact voxels', async () => {
    const { service, line, worldDir, entity } = setUp('order');
    const clean = regions(worldDir('a'));
    move(service, entity, 1);
    const dug = await dig(line, 'a', 0);
    expect(dug.ok).toBe(true);
    const after = regions(worldDir('a'));
    expect(after).not.toEqual(clean);
    move(service, entity, 2);
    expect(line.depths(P)).toEqual({ undoDepth: 4, redoDepth: 0 });

    expect(kind(await step(service, line, 'undo'))).toBe('project');
    expect(xOf(service, entity)).toBe(1);
    expect(regions(worldDir('a'))).toEqual(after);
    const u = await step(service, line, 'undo');
    expect(kind(u)).toBe('voxel a undo');
    // The undo names what derived data must follow, as the edit did.
    expect(u.kind === 'voxel' && u.result.ok && u.result.chunks).toEqual(dug.ok && dug.chunks);
    expect(regions(worldDir('a'))).toEqual(clean);
    expect(xOf(service, entity)).toBe(1);
    expect(kind(await step(service, line, 'undo'))).toBe('project');
    expect(xOf(service, entity)).toBe(0);
    expect(line.depths(P)).toEqual({ undoDepth: 1, redoDepth: 3 });

    expect(kind(await step(service, line, 'redo'))).toBe('project');
    expect(xOf(service, entity)).toBe(1);
    expect(regions(worldDir('a'))).toEqual(clean);
    const r = await step(service, line, 'redo');
    expect(kind(r)).toBe('voxel a redo');
    // The exact voxels the undo took: the same region file bytes as after the edit.
    expect(regions(worldDir('a'))).toEqual(after);
    expect(r.kind === 'voxel' && r.result.ok && { cells: r.result.cells, box: r.result.box, parts: r.result.parts, chunks: r.result.chunks }).toEqual(dug.ok && { cells: dug.cells, box: dug.box, parts: dug.parts, chunks: dug.chunks });
    expect(kind(await step(service, line, 'redo'))).toBe('project');
    expect(xOf(service, entity)).toBe(2);
    expect(kind(await step(service, line, 'redo'))).toBe('history_empty');
    // Undone and redone again: still exact both ways.
    expect(kind(await step(service, line, 'undo'))).toBe('project');
    expect(kind(await step(service, line, 'undo'))).toBe('voxel a undo');
    expect(regions(worldDir('a'))).toEqual(clean);
    expect(kind(await step(service, line, 'redo'))).toBe('voxel a redo');
    expect(regions(worldDir('a'))).toEqual(after);
  });

  it('a new edit of either kind after an undo ends the redo of both kinds', async () => {
    const { service, worlds, line, entity } = setUp('redo-clear');
    move(service, entity, 1);
    expect((await dig(line, 'a', 0)).ok).toBe(true);
    expect(kind(await step(service, line, 'undo'))).toBe('voxel a undo');
    expect(kind(await step(service, line, 'undo'))).toBe('project');
    expect(line.depths(P)).toEqual({ undoDepth: 1, redoDepth: 2 });
    // A scene edit: the stroke's redo goes with the scene's.
    move(service, entity, 5);
    expect(line.depths(P)).toEqual({ undoDepth: 2, redoDepth: 0 });
    expect(kind(await step(service, line, 'redo'))).toBe('history_empty');
    await worlds.clearRedo(P, 'a');
    expect(worlds.newestStroke(P, 'a', 'redo')).toBeNull();

    // A stroke (in another world): the scene's redo goes with the other world's.
    expect((await dig(line, 'a', 4)).ok).toBe(true);
    expect(kind(await step(service, line, 'undo'))).toBe('voxel a undo');
    expect(kind(await step(service, line, 'undo'))).toBe('project');
    expect((await dig(line, 'b', 0)).ok).toBe(true);
    expect(line.depths(P)).toEqual({ undoDepth: 2, redoDepth: 0 });
    expect(service.undoHistory(P)).toMatchObject({ cursor: 1 });
    expect(service.undoHistory(P)!.requestIds).toHaveLength(1);
    await worlds.clearRedo(P, 'a');
    expect(worlds.newestStroke(P, 'a', 'redo')).toBeNull();
    expect(kind(await step(service, line, 'redo'))).toBe('history_empty');
    expect(kind(await step(service, line, 'undo'))).toBe('voxel b undo');
    // Before the stroke in b: the object's creation (its moves were undone, and the second move's redo ended).
    expect(kind(await step(service, line, 'undo'))).toBe('project');
    expect((service.query({ op: 'queryEntity', projectId: P, args: { entityId: entity } }) as { ok: boolean }).ok).toBe(false);
  });

  it('skips and names a stroke its world no longer holds (read again after a checkout, or deleted) instead of failing every later undo', async () => {
    const { service, line, worldDir, entity } = setUp('gone');
    const clean = join(worldDir('a'), '..', 'a-clean');
    cpSync(worldDir('a'), clean, { recursive: true });
    expect((await dig(line, 'a', 0)).ok).toBe(true);
    expect((await dig(line, 'b', 0)).ok).toBe(true);
    move(service, entity, 3);
    // World a's files go back to before the dig behind the backend (a checkout); world b's folder is deleted.
    rmSync(join(worldDir('a'), 'grid-0'), { recursive: true });
    cpSync(clean, worldDir('a'), { recursive: true });
    rmSync(worldDir('b'), { recursive: true });
    expect(kind(await step(service, line, 'undo'))).toBe('project');
    // World b's stroke: its folder is gone. Reading world a again (any command or read finds the checkout) drops its stroke too.
    const s = await step(service, line, 'undo');
    expect(s.skipped.map((k) => k.world)).toEqual(['b', 'a']);
    expect(s.skipped.every((k) => k.reason.length > 10)).toBe(true);
    // The next step is the object's creation, undone: the line was not stopped by the gone strokes.
    expect(kind(s)).toBe('project');
    expect(line.depths(P)).toEqual({ undoDepth: 0, redoDepth: 2 });
    expect(kind(await step(service, line, 'undo'))).toBe('history_empty');
  });

  it('keeps the strokes when the project history starts afresh; a resent undo steps once; stale revisions are refused', async () => {
    const { service, worlds, line, worldDir, entity } = setUp('fresh');
    const clean = regions(worldDir('a'));
    move(service, entity, 1);
    const dug = await dig(line, 'a', 0);
    move(service, entity, 2);
    expect(service.forgetHistory(P)).toBe(true);
    expect(line.depths(P)).toEqual({ undoDepth: 1, redoDepth: 0 });
    // A stale project revision refuses the stroke's undo as it would a project entry's.
    const stale = await step(service, line, 'undo', rid(), revision(service) - 1);
    expect(stale).toMatchObject({ kind: 'refused', error: { code: 'revision_conflict', currentRevision: revision(service) } });
    const once = rid();
    expect(kind(await step(service, line, 'undo', once))).toBe('voxel a undo');
    const again = await step(service, line, 'undo', once);
    expect(again.kind === 'voxel' && again.result.ok && again.result.duplicated).toBe(true);
    expect(line.depths(P)).toEqual({ undoDepth: 0, redoDepth: 1 });
    expect(regions(worldDir('a'))).toEqual(clean);
    expect(xOf(service, entity)).toBe(2);

    // A stroke's own expectedRevision is the world's: a stale one is refused with the world's revision, the right one applies.
    const worldRev = dug.ok ? dug.revision + 1 : -1;
    const refused = await dig(line, 'a', 4, { expectedRevision: worldRev - 1 });
    expect(refused).toMatchObject({ ok: false, error: { code: 'revision_conflict', expectedRevision: worldRev - 1, currentRevision: worldRev } });
    expect(line.depths(P)).toEqual({ undoDepth: 0, redoDepth: 1 });
    expect(await dig(line, 'a', 4, { expectedRevision: worldRev })).toMatchObject({ ok: true, revision: worldRev + 1, undoable: 1, redoable: 0 });
    expect(line.depths(P)).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(worlds.newestStroke(P, 'a', 'redo')).toBeNull();
  });
});
